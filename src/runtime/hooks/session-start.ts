#!/usr/bin/env node
/**
 * Claude Code `SessionStart` hook binary (T-HANDOFF-HARDENING HH6.1).
 *
 * Fires ONCE when a session begins — the enforcement point opensquid was
 * missing (it previously registered only PreToolUse / UserPromptSubmit / Stop
 * / SessionEnd, so "check chat connections / start chat watch at session
 * start" was a convention with nowhere to hang). Claude Code delivers a
 * `source` discriminator: `startup` (new), `resume` (--resume/--continue/
 * /resume), `clear` (/clear), `compact` (auto/manual compaction). This bin
 * acts only on `startup`/`resume` — `clear`/`compact` fire MID-session and
 * would re-inject session-start noise after the connection was established.
 *
 * Wired in `~/.claude/settings.json` (installed by `opensquid setup` via
 * src/setup/wizard/settings-writer.ts):
 *
 *   { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
 *     "command": "opensquid-hook-sessionstart" }] }] } }
 *
 * stdin = SessionStart JSON ({session_id, transcript_path, cwd, source,
 * model}). Output: VERIFIED 2026-05-24 — Claude Code 2.x silently DISCARDS
 * raw stdout from a hook; ONLY `hookSpecificOutput.additionalContext` (with
 * the matching `hookEventName`) injects context. So this bin emits the JSON
 * envelope, never plain stdout. Modeled 1:1 on user-prompt-submit.ts.
 *
 * Fail-open on any internal error: a SessionStart hook must NEVER block the
 * session from starting (exit 0 throughout; main().catch → exit 0).
 *
 * The mechanism ships with ZERO rules subscribed; the first consumer is the
 * connection-check pack rule (HH6.2). Until a pack rule emits an
 * inject_context on `session_start`, this bin produces no stdout.
 */
import { buildRegistry, loadActivePacks } from '../bootstrap.js';
import { claimUmbrellaLeaseForSession } from '../chat/claim_lease.js';
import { Event } from '../types.js';

import { dispatchEvent } from './dispatch.js';
import { extractSessionId } from './session_id.js';

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
  source?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as SessionStartPayload;
  return {
    kind: 'session_start',
    // CC always supplies `source`; default to 'startup' if a future/edge
    // payload omits it so the event still parses (Event.safeParse enforces
    // the enum — an unknown source value fails parse → fail-open exit 0).
    source: obj.source ?? 'startup',
    cwd: obj.cwd ?? process.cwd(),
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
    process.stderr.write('opensquid: empty SessionStart payload — proceeding\n');
    process.exit(0);
  }

  let normalized: unknown;
  try {
    normalized = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`opensquid: invalid SessionStart JSON — ${String(e)}\n`);
    process.exit(0);
  }

  const parsed = Event.safeParse(normalized);
  if (!parsed.success) {
    process.stderr.write('opensquid: invalid SessionStart payload schema\n');
    process.exit(0);
  }

  // HH6.1 L3: only act on a genuine session begin. `clear`/`compact` fire
  // mid-session; re-running session-start discipline there would re-inject
  // the connection report after the connection was already established.
  if (
    parsed.data.kind === 'session_start' &&
    (parsed.data.source === 'clear' || parsed.data.source === 'compact')
  ) {
    process.exit(0);
  }

  const sessionId = extractSessionId(raw);
  // Interactive responder (chat mirrors the live session): the moment a session
  // opens for an umbrella it claims that umbrella's chat lease (acquire-if-free)
  // so a chat message drives THIS session + the headless stands down — even
  // before the first keystroke. No-op in `responder: headless` mode / no umbrella.
  const startCwd = parsed.data.kind === 'session_start' ? parsed.data.cwd : process.cwd();
  await claimUmbrellaLeaseForSession(sessionId, startCwd);
  const packs = await loadActivePacks(sessionId);
  const registry = await buildRegistry();
  const { exitCode, stderr, contextInjections } = await dispatchEvent(
    parsed.data,
    packs,
    registry,
    sessionId,
  );

  // HH6.1 L2: emit the additionalContext envelope when any rule contributed
  // an inject_context payload (the dispatcher aggregates inject_context for
  // session_start per the HH6.1 widening). Raw stdout is silently discarded
  // by Claude Code 2.x — the JSON envelope is the ONLY channel that injects.
  if (contextInjections.length > 0) {
    const envelope = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: contextInjections.join('\n\n'),
      },
    };
    process.stdout.write(JSON.stringify(envelope));
  }

  if (stderr) process.stderr.write(stderr + '\n');
  process.exit(exitCode);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (session-start): ${String(e)}\n`);
  process.exit(0);
});
