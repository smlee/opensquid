#!/usr/bin/env node
/**
 * Claude Code `SessionEnd` hook binary.
 *
 * Fires when a session terminates — entry point for context-clearing
 * lessons (Task 4.x). The dispatcher still runs in case a pack registers
 * a `session_end` rule (e.g. flushing a violations buffer).
 *
 * Wired in `~/.claude/settings.json`:
 *
 *   { "hooks": { "SessionEnd": [{ "hooks": [{ "type": "command",
 *     "command": "opensquid-hook-sessionend" }] }] } }
 *
 * stdin = session-end JSON. exit code is informational here — Claude Code
 * is already closing the session — but we follow the same 0/2 convention
 * for consistency with the other hooks.
 *
 * Fail-open on any internal error.
 */
import { buildRegistry, loadActivePacks } from '../bootstrap.js';
import { clearFsmState } from '../fsm_state.js';
import { runCompression } from '../compression_orchestrator.js';
import { makeConsolidateRunner } from '../wedge/compression_deps.js';
import { emitProbe, groupFromTask } from '../satisfaction_probe.js';
import { archiveActiveTask, readActiveTask } from '../session_state.js';
import { Event } from '../types.js';

import { dispatchEvent } from './dispatch.js';
import { reconcileMemoryOnSessionEnd } from './memory_reconcile.js';

interface SessionEndPayload {
  sessionId?: string;
  session_id?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as SessionEndPayload;
  return {
    kind: 'session_end',
    sessionId: obj.sessionId ?? obj.session_id ?? process.env.CLAUDE_SESSION_ID ?? 'unknown',
  };
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk as string;
  return data;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('opensquid: empty SessionEnd payload — proceeding\n');
    process.exit(0);
  }

  let normalized: unknown;
  try {
    normalized = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`opensquid: invalid SessionEnd JSON — ${String(e)}\n`);
    process.exit(0);
  }

  const parsed = Event.safeParse(normalized);
  if (!parsed.success) {
    process.stderr.write('opensquid: invalid SessionEnd payload schema\n');
    process.exit(0);
  }

  // Stdin-first session id (parsePayload already applied the correct precedence,
  // matching the stop/pre-tool-use/user-prompt-submit hooks post-2026-05-26 fix).
  const sessionId = parsed.data.kind === 'session_end' ? parsed.data.sessionId : 'unknown';
  const packs = await loadActivePacks(sessionId);
  const registry = await buildRegistry();
  const { exitCode, stderr } = await dispatchEvent(parsed.data, packs, registry, sessionId);
  if (stderr) process.stderr.write(stderr + '\n');

  // MAU.3 — flush authored memories to the long-term RAG at the session boundary.
  await reconcileMemoryOnSessionEnd(sessionId);

  // CMP.2 — emit a satisfaction probe for the just-closed task's feature
  // group (async, append-only, deduped per group). The user answers at a
  // natural boundary; a "satisfied" answer later gates the compression
  // orchestrator (CMP.4). Read the active task BEFORE archiving it.
  // Best-effort + fail-open: a probe-emit failure must never affect the
  // session-end exit code.
  try {
    const active = await readActiveTask(sessionId);
    const group = groupFromTask(active);
    if (group) await emitProbe(sessionId, group);
  } catch (e) {
    process.stderr.write(`opensquid: satisfaction-probe emit skipped — ${String(e)}\n`);
  }

  // T-CTX-LOOP CTX.5 (2026-05-29) — wire the CMP.4 compression orchestrator at
  // the session boundary. The orchestrator is satisfaction-gated (D1: no
  // probe answered "satisfied" → no-op); when satisfied, it reads CMP.3
  // candidate windows + runs the TS consolidate (RES-4c, engine-free) per window:
  // compress + recall-replay verify + force-delete ONLY non-user-cited predecessors
  // that the verify gate passes. consolidate NEVER-deletes for unverified or
  // user-cited memories — opensquid is pure policy. Fail-open per the hook contract;
  // a compression failure must not block session-end.
  try {
    const active = await readActiveTask(sessionId);
    const group = groupFromTask(active);
    if (group) {
      const runner = await makeConsolidateRunner();
      try {
        const outcomes = await runCompression(sessionId, group, runner.run);
        if (outcomes.length > 0) {
          process.stderr.write(
            `opensquid: compression — ${String(outcomes.length)} window(s) for group ${group}\n`,
          );
        }
      } finally {
        await runner.close();
      }
    }
  } catch (e) {
    process.stderr.write(`opensquid: compression skipped — ${String(e)}\n`);
  }

  // T-AUTO-HANDOFF — the SessionEnd BACKUP writer. MUST run BEFORE
  // archiveActiveTask/clearFsmState below: those destroy the exact state the
  // deterministic dump reads (active-task signal + FSM file). Best-effort —
  // a handoff failure never blocks session close.
  try {
    const { runHandoff } = await import('../handoff/index.js');
    const result = await runHandoff(sessionId, process.cwd());
    process.stderr.write(`opensquid: auto-handoff written — ${result.docPath}\n`);
  } catch (e) {
    process.stderr.write(`opensquid: auto-handoff skipped — ${String(e)}\n`);
  }

  // AP.2 / rule #16 — archive (not delete) the active-task signal at session
  // close, so an abandoned in-progress task leaves a trace. Best-effort.
  await archiveActiveTask(sessionId);

  // Clear the coding-flow lifecycle state on session close — a session-scoped
  // machine that starts fresh each session (cross-session resume is a separate
  // product question, deferred). ENOENT swallowed by the helper. (T-FSM-UNIFY:
  // one unified pack now, so this single clear covers the whole lifecycle —
  // incidentally fixing the old never-cleared FSM-state leak.)
  try {
    await clearFsmState(sessionId, 'coding-flow');
  } catch (e) {
    process.stderr.write(`opensquid: coding-flow clear failed — ${String(e)}\n`);
  }

  process.exit(exitCode);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (session-end): ${String(e)}\n`);
  process.exit(0);
});
