#!/usr/bin/env node
/**
 * Claude Code `PostToolUse` hook binary (T-POSTPUSH POSTPUSH.1, 2026-05-29).
 *
 * Fires AFTER a tool call completes. Mirrors the pre-tool-use bin shape but
 * carries the tool's exit code so gate skills can react to success/failure
 * (canonical case = `verify-ci-after-push` fires only on
 * `^git\s+(?:-[cC]\s+\S+\s+)*push\b` with exit_code === 0).
 *
 * Wired in `~/.claude/settings.json`:
 *
 *   { "hooks": { "PostToolUse": [{ "matcher": "Bash",
 *     "hooks": [{ "type": "command",
 *       "command": "opensquid-hook-posttooluse" }] }] } }
 *
 * stdin = Claude Code's post-tool-use JSON (includes `tool_result` with
 * `exit_code`, `stdout`, `stderr`). exit code 0 = no surface; 2 reserved
 * for future block-style verdicts (not used today — PostToolUse is too
 * late to block).
 *
 * Payload normalization: Claude Code uses snake_case nested under
 * `tool_result`; we flatten to the Event schema's top-level
 * `exit_code` / `stdout` / `stderr`.
 *
 * Active-task mirror NOT re-fired from this hook — PreToolUse already
 * handles that surface; double-firing would duplicate writes.
 *
 * Fail-open: any internal crash exits 0 with a stderr message.
 */
import { buildRegistry, loadActivePacks } from '../bootstrap.js';
import { exitIfSubagent } from './subagent_guard.js';
import { Event } from '../types.js';

import { dispatchEvent } from './dispatch.js';
import { floorMessage, observeCall } from '../guard/floor_hook.js';
import { extractSessionId } from './session_id.js';

interface PostToolUsePayload {
  tool?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  exit_code?: number;
  duration_ms?: number;
  stdout?: string;
  stderr?: string;
  tool_result?: {
    exit_code?: number;
    duration_ms?: number;
    stdout?: string;
    stderr?: string;
  };
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as PostToolUsePayload;
  // Claude Code nests result fields under `tool_result`; the runtime Event
  // schema flattens them. Accept either form; prefer `tool_result.*` because
  // that's the canonical Claude Code shape per the documented PostToolUse
  // payload (claude-code-guide 2026-05-29 confirmation).
  const result = obj.tool_result ?? {};
  return {
    kind: 'post_tool_call',
    tool: obj.tool ?? obj.tool_name ?? '',
    args: obj.args ?? obj.tool_input ?? {},
    exit_code: result.exit_code ?? obj.exit_code ?? 0,
    ...(result.stdout !== undefined || obj.stdout !== undefined
      ? { stdout: result.stdout ?? obj.stdout }
      : {}),
    ...(result.stderr !== undefined || obj.stderr !== undefined
      ? { stderr: result.stderr ?? obj.stderr }
      : {}),
    ...(obj.cwd !== undefined ? { cwd: obj.cwd } : {}),
    ...(result.duration_ms !== undefined || obj.duration_ms !== undefined
      ? { duration_ms: result.duration_ms ?? obj.duration_ms }
      : {}),
  };
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk as string;
  return data;
}

async function main(): Promise<void> {
  exitIfSubagent('post-tool-use'); // SUB.1: before stdin read / any state write
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('opensquid: empty PostToolUse payload — proceeding\n');
    process.exit(0);
  }

  let normalized: unknown;
  try {
    normalized = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`opensquid: invalid PostToolUse JSON — ${String(e)}\n`);
    process.exit(0);
  }

  const parsed = Event.safeParse(normalized);
  if (!parsed.success) {
    process.stderr.write('opensquid: invalid PostToolUse payload schema\n');
    process.exit(0);
  }

  const sessionId = extractSessionId(raw);
  const packs = await loadActivePacks(sessionId);
  const registry = await buildRegistry();
  const { exitCode, stderr } = await dispatchEvent(parsed.data, packs, registry, sessionId);
  // P0.3 — the live Progress-floor failure-loop detector. Observe the call against the persisted
  // floor; a non-`pass` action surfaces on the same drift-stderr channel. Fail-open: a floor error
  // never breaks the hook.
  let floorMsg = '';
  try {
    const ev = parsed.data;
    if (ev.kind === 'post_tool_call') {
      const action = await observeCall(sessionId, {
        tool: ev.tool,
        args: ev.args,
        exitCode: ev.exit_code,
      });
      if (action !== 'pass') floorMsg = floorMessage(action, ev.tool);
    }
  } catch {
    /* the Progress floor never breaks the hook */
  }
  const combined = [stderr, floorMsg].filter(Boolean).join('\n');
  if (combined) process.stderr.write(combined + '\n');
  // PostToolUse is too late to block the tool call (already ran). Treat any
  // non-zero exit as informational stderr only.
  process.exit(exitCode === 2 ? 0 : exitCode);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (post-tool-use): ${String(e)}\n`);
  process.exit(0);
});
