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
import { exitIfSubagent } from './subagent_guard.js';
import type { SessionStartEvent } from '../event.js';
import { Event } from '../types.js';

import { defaultLifecyclePipeline } from './lifecycle/pipeline.js';
import {
  formatDirectiveBlock,
  projectExistingHostLifecycleContext,
} from './lifecycle/projector.js';
import { extractSessionId } from './session_id.js';

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
  source?: string;
  agent_id?: string;
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
  exitIfSubagent('session-start'); // SUB.1: before stdin read / any state write
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
  const event = parsed.data as SessionStartEvent;
  const { exitCode, stderr, contextInjections, directives } =
    await defaultLifecyclePipeline.runSessionStart(
      { event },
      projectExistingHostLifecycleContext({
        sessionId,
        cwd: event.cwd ?? process.cwd(),
        raw,
      }),
    );

  // HH6.1 L2: emit the additionalContext envelope when any rule contributed
  // an inject_context payload (the dispatcher aggregates inject_context for
  // session_start per the HH6.1 widening). Raw stdout is silently discarded
  // by Claude Code 2.x — the JSON envelope is the ONLY channel that injects.
  const contextParts = [...contextInjections];
  const directiveBlock = formatDirectiveBlock(directives);
  if (directiveBlock !== null) contextParts.push(directiveBlock);
  if (contextParts.length > 0) {
    const envelope = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: contextParts.join('\n\n'),
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
