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
import { buildRegistry, loadActivePacksForDispatch } from '../bootstrap.js';
import { exitIfSubagent } from './subagent_guard.js';
import { clearFsmState } from '../fsm_state.js';
import { runCompression } from '../compression_orchestrator.js';
import { makeConsolidateRunner } from '../wedge/compression_deps.js';
import { liveTurnIngestIds } from '../../rag/memory/store.js';
import { commitMemoryStore } from '../../rag/store_git.js';
import { createBackend } from '../../rag/backend_factory.js';
import { resolveBackendConfig } from '../../rag/config.js';
import { emitProbe, groupFromTask } from '../satisfaction_probe.js';
import { archiveActiveTask, readActiveTask } from '../session_state.js';
import { Event } from '../types.js';

import { dispatchEvent } from './dispatch.js';
import { reconcileMemoryOnSessionEnd } from './memory_reconcile.js';
import { sessionEndIndication } from './session_end_indication.js';
import { notifyRetentionSweep } from './session_end_sweep_notify.js';
import { sweepRetiredIfAllowed } from './session_end_retention.js';

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
  exitIfSubagent('session-end'); // SUB.1: before stdin read / any state write
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
  const packs = await loadActivePacksForDispatch(sessionId);
  const registry = await buildRegistry();
  const { exitCode, stderr } = await dispatchEvent(parsed.data, packs, registry, sessionId);
  if (stderr) process.stderr.write(stderr + '\n');

  // T-session-end-indication (wg-a9af600828fe) — name the session that ended (+ its task), so `/exit`
  // is unambiguous (the user runs one session; the "phantom sibling" confusion was identity-invisible).
  // Read the active task BEFORE archiveActiveTask below destroys it. Fail-open — never block session close.
  try {
    const ended = await readActiveTask(sessionId);
    process.stderr.write(sessionEndIndication(sessionId, ended) + '\n');
  } catch {
    process.stderr.write(`[opensquid] session ${sessionId.slice(0, 8)} ended\n`);
  }

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

  // T-memory-lifecycle — bound the always-on raw-turn capture. UNCONDITIONALLY gist this run's live raw turns
  // (assistant/tool; user prose is verbatim+immune+excluded) into gists and retire the raws — reuses
  // compress + demote via the runner, NO satisfaction gate and NO recall-replay verify (the transcript JSONL
  // is the lossless archive, so retiring a gisted raw loses nothing recoverable). The retention sweep below
  // then reclaims the retired raws. Fail-open.
  try {
    const runner = await makeConsolidateRunner();
    try {
      const ids = await liveTurnIngestIds(runner.client);
      const TURN_GIST_WINDOW = 20;
      for (let i = 0; i < ids.length; i += TURN_GIST_WINDOW) {
        await runner.gistAndRetire(ids.slice(i, i + TURN_GIST_WINDOW));
      }
      if (ids.length > 0)
        process.stderr.write(
          `opensquid: turn-gist — ${String(ids.length)} raw turn(s) gisted+retired\n`,
        );
    } finally {
      await runner.close();
    }
  } catch (e) {
    process.stderr.write(`opensquid: turn-gist skipped — ${String(e)}\n`);
  }

  // RSW.1 (wg-9e4f4eb2a40f) — close the retention loop. Restore any already-demoted USER memory to
  // recall (Part 1b), then hard-delete retired AGENT rows past the 30-day window (Part 2). Runs AFTER
  // compression (this session's demotes become eligible next time) and BEFORE the GVM.1 snapshot
  // (deletions land in the same forensic commit). Unconditional (NOT satisfaction-gated like
  // compression) + fail-open; the constructed libSQL client is reclaimed by the process.exit below.
  try {
    const backend = createBackend(await resolveBackendConfig());
    await backend.init();
    const restored = (await backend.repromoteRetiredUserMemories?.()) ?? [];
    if (restored.length > 0)
      process.stderr.write(
        `opensquid: retention — ${String(restored.length)} user mem(s) restored\n`,
      );
    // #16 gate: the destructive 30-day sweep runs ONLY when the cwd project's work-graph cycle is
    // complete AND its git tree is clean (retentionPruneAllowed) — never hard-delete while work is
    // in-flight or uncommitted. The gate is fail-closed; a gate throw propagates to this block's
    // try/catch (fail-open teardown). The restore above (Part 1b) stays unconditional.
    const swept = await sweepRetiredIfAllowed(backend, process.cwd());
    if (swept.length > 0) {
      process.stderr.write(`opensquid: retention sweep — ${String(swept.length)} reclaimed\n`);
      try {
        await notifyRetentionSweep(swept, process.cwd());
      } catch {
        // fail-open — a notify failure must never break session-end;
        // the stderr line above is the unconditional fallback.
      }
    }
  } catch (e) {
    process.stderr.write(`opensquid: retention sweep skipped — ${String(e)}\n`);
  }

  // GVM.1 (wg-7f4df49787cb) — snapshot the per-file memory+op store to git AFTER compression, so the
  // forensic archive + retention rollback floor captures this session's writes + retired_at demotes.
  try {
    const sha = await commitMemoryStore(`memory snapshot: session ${sessionId.slice(0, 8)}`);
    if (sha !== null) process.stderr.write(`opensquid: memory-store snapshot ${sha}\n`);
  } catch {
    /* fail-soft: a snapshot failure must never block session-end */
  }

  // T-AUTO-HANDOFF — the SessionEnd BACKUP writer. MUST run BEFORE
  // archiveActiveTask/clearFsmState below: those destroy the exact state the
  // deterministic dump reads (active-task signal + FSM file). Best-effort —
  // a handoff failure never blocks session close.
  // AHO.3 SUBSTANCE GATE: trivial sessions (every codex exec probe and hook
  // subprocess carries a session id) left 26+ junk docs/issues in one day and
  // clobbered the MEMORY.md resume block. Back up ONLY when the dying session
  // holds resumable state; the explicit command and the SessionStart lazy
  // generator are unaffected.
  try {
    // AHO.4: ONE substance predicate shared with the tier-3 lazy generator
    // (the AHO.3 FSM-exists probe passed for scope-intent trivia whose FSM
    // this very hook then deleted — the evidence self-erased).
    const { hasResumableState } = await import('../handoff/substance.js');
    if (await hasResumableState(sessionId)) {
      const { runHandoff } = await import('../handoff/index.js');
      const result = await runHandoff(sessionId, process.cwd());
      process.stderr.write(`opensquid: auto-handoff written — ${result.docPath}\n`);
    } else {
      process.stderr.write('opensquid: auto-handoff skipped — no resumable state\n');
    }
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
