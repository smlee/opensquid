#!/usr/bin/env node
/** Claude Code `PostToolUse` hook binary. */
import { exitIfSubagent } from './subagent_guard.js';
import type { PostToolCallEvent } from '../event.js';
import { Event } from '../types.js';

import { defaultLifecyclePipeline } from './lifecycle/pipeline.js';
import { projectExistingHostLifecycleContext } from './lifecycle/projector.js';
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
  agent_id?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as PostToolUsePayload;
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
  exitIfSubagent('post-tool-use');
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
  const event = parsed.data as PostToolCallEvent;
  const result = await defaultLifecyclePipeline.runPostToolCall(
    { event },
    projectExistingHostLifecycleContext({
      sessionId,
      cwd: typeof event.cwd === 'string' ? event.cwd : process.cwd(),
      raw,
    }),
  );
  if (result.stderr) process.stderr.write(result.stderr + '\n');
  process.exit(result.exitCode);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (post-tool-use): ${String(e)}\n`);
  process.exit(0);
});
