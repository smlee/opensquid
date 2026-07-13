#!/usr/bin/env node
/** Claude Code `Stop` hook binary. */
import { exitIfSubagent } from './subagent_guard.js';
import type { StopEvent } from '../event.js';
import { Event } from '../types.js';

import { defaultLifecyclePipeline } from './lifecycle/pipeline.js';
import { projectExistingHostLifecycleContext } from './lifecycle/projector.js';
import { extractSessionId } from './session_id.js';
import { emitDriftStderrAndExit, squidPrefix } from './hook_output.js';
import { readLastAssistantText } from './transcript.js';

interface StopPayload {
  assistantText?: string;
  assistant_text?: string;
  message?: string;
  transcript_path?: string;
  transcriptPath?: string;
  agent_id?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as StopPayload;
  return {
    kind: 'stop',
    assistantText: obj.assistantText ?? obj.assistant_text ?? obj.message ?? '',
  };
}

function extractTranscriptPath(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as StopPayload;
    const p = obj.transcript_path ?? obj.transcriptPath;
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk as string;
  return data;
}

async function main(): Promise<void> {
  exitIfSubagent('stop');
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('opensquid: empty Stop payload — proceeding\n');
    process.exit(0);
  }

  let normalized: unknown;
  try {
    normalized = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`opensquid: invalid Stop JSON — ${String(e)}\n`);
    process.exit(0);
  }

  const parsed = Event.safeParse(normalized);
  if (!parsed.success) {
    process.stderr.write('opensquid: invalid Stop payload schema\n');
    process.exit(0);
  }

  if (parsed.data.kind === 'stop' && parsed.data.assistantText === '') {
    const transcriptPath = extractTranscriptPath(raw);
    if (transcriptPath !== null) {
      parsed.data.assistantText = await readLastAssistantText(transcriptPath);
    }
  }

  const sessionId = extractSessionId(raw);
  const event = parsed.data as StopEvent;
  const lifecycle = projectExistingHostLifecycleContext({
    sessionId,
    cwd: process.cwd(),
    raw,
  });
  const result = await defaultLifecyclePipeline.runStop(
    { event, raw, isLoopLap: lifecycle.role !== 'interactive' },
    lifecycle,
  );

  if (result.continuationReason !== undefined) {
    if (result.stderr.length > 0) process.stderr.write(squidPrefix(result.stderr) + '\n');
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: result.continuationReason }) + '\n',
    );
    process.exit(0);
  }

  emitDriftStderrAndExit(result.exitCode, result.stderr);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (stop): ${String(e)}\n`);
  process.exit(0);
});
