#!/usr/bin/env node
/**
 * Claude Code `PreToolUse` hook binary.
 *
 * Wired in `~/.claude/settings.json` (or per-project `.claude/settings.json`):
 *
 *   { "hooks": { "PreToolUse": [{ "matcher": "Bash",
 *     "hooks": [{ "type": "command",
 *       "command": "opensquid-hook-pretooluse" }] }] } }
 *
 * stdin = Claude Code's tool-call JSON. stdout = empty. stderr = drift
 * messages (shown to the user/agent). exit code 0 = allow, 2 = block.
 *
 * Payload normalization: Claude Code may use snake_case (`tool_name`,
 * `tool_input`, `session_id`); the runtime Event schema uses camelCase. We
 * normalize in `parsePayload` BEFORE handing to Zod so the schema stays pure.
 *
 * Fail-open: any internal crash exits 0 with a stderr message. NEVER block
 * the parent agent because of an opensquid bug. The `main().catch()` at the
 * bottom is the last line of defense.
 */
import { buildRegistry, loadActivePacks } from '../bootstrap.js';
import { Event } from '../types.js';

import { dispatchEvent } from './dispatch.js';

interface PreToolUsePayload {
  tool?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as PreToolUsePayload;
  // Claude Code uses snake_case (tool_name / tool_input). Normalize to the
  // runtime Event shape (tool / args). Either form accepted.
  return {
    kind: 'tool_call',
    tool: obj.tool ?? obj.tool_name ?? '',
    args: obj.args ?? obj.tool_input ?? {},
    ...(obj.cwd !== undefined ? { cwd: obj.cwd } : {}),
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
    process.stderr.write('opensquid: empty PreToolUse payload — proceeding\n');
    process.exit(0);
  }

  let normalized: unknown;
  try {
    normalized = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`opensquid: invalid PreToolUse JSON — ${String(e)}\n`);
    process.exit(0);
  }

  const parsed = Event.safeParse(normalized);
  if (!parsed.success) {
    process.stderr.write('opensquid: invalid PreToolUse payload schema\n');
    process.exit(0);
  }

  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'unknown';
  const packs = await loadActivePacks(sessionId);
  const registry = buildRegistry();
  const { exitCode, stderr } = await dispatchEvent(parsed.data, packs, registry, sessionId);
  if (stderr) process.stderr.write(stderr + '\n');
  process.exit(exitCode);
}

main().catch((e: unknown) => {
  // Fail-open: never crash the parent agent on opensquid's own bug.
  process.stderr.write(`opensquid hook crash (pre-tool-use): ${String(e)}\n`);
  process.exit(0);
});
