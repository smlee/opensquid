#!/usr/bin/env node
/**
 * Claude Code `PreToolUse` hook binary.
 *
 * stdin = Claude Code's tool-call JSON. stdout carries either the deny envelope
 * or a non-blocking additionalContext envelope. Fail-open on internal error.
 */
import { exitIfSubagent } from './subagent_guard.js';
import type { ToolCallEvent } from '../event.js';
import { Event } from '../types.js';

import { defaultLifecyclePipeline } from './lifecycle/pipeline.js';
import {
  buildPreToolUseContext,
  buildPreToolUseDeny,
  emitDriftStderrAndExit,
} from './hook_output.js';
import { projectExistingHostLifecycleContext } from './lifecycle/projector.js';
import { extractSessionId } from './session_id.js';

interface PreToolUsePayload {
  tool?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  transcript_path?: string;
  transcriptPath?: string;
  agent_id?: string;
}

function extractTranscriptPath(raw: string): string | undefined {
  try {
    const obj = JSON.parse(raw) as PreToolUsePayload;
    const p = obj.transcript_path ?? obj.transcriptPath;
    return typeof p === 'string' && p.length > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as PreToolUsePayload;
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
  exitIfSubagent('pre-tool-use');
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

  const sessionId = extractSessionId(raw);
  const event = parsed.data as ToolCallEvent;
  const transcriptPath = extractTranscriptPath(raw);
  const decision = await defaultLifecyclePipeline.runPreToolCall(
    { event, ...(transcriptPath === undefined ? {} : { transcriptPath }) },
    projectExistingHostLifecycleContext({
      sessionId,
      cwd: typeof event.cwd === 'string' ? event.cwd : process.cwd(),
      raw,
    }),
  );

  if (decision.block) {
    process.stdout.write(JSON.stringify(buildPreToolUseDeny(decision.reason ?? '', '')));
    process.exit(0);
  }

  const ctxOut = buildPreToolUseContext(decision.contextInjections.join('\n\n'));
  if (ctxOut !== null) process.stdout.write(JSON.stringify(ctxOut));
  emitDriftStderrAndExit(0, decision.diagnostics.join('\n'));
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (pre-tool-use): ${String(e)}\n`);
  process.exit(0);
});
