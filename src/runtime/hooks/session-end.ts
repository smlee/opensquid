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
import { archiveActiveTask } from '../session_state.js';
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

  // AP.2 / rule #16 — archive (not delete) the active-task signal at session
  // close, so an abandoned in-progress task leaves a trace. Best-effort.
  await archiveActiveTask(sessionId);

  process.exit(exitCode);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (session-end): ${String(e)}\n`);
  process.exit(0);
});
