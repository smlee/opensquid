#!/usr/bin/env node
/** Claude Code `SessionEnd` hook binary. */
import { exitIfSubagent } from './subagent_guard.js';
import type { SessionEndEvent } from '../event.js';
import { Event } from '../types.js';

import { defaultLifecyclePipeline } from './lifecycle/pipeline.js';
import { projectExistingHostLifecycleContext } from './lifecycle/projector.js';

interface SessionEndPayload {
  sessionId?: string;
  session_id?: string;
  agent_id?: string;
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
  exitIfSubagent('session-end');
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

  const event = parsed.data as SessionEndEvent;
  const sessionId = event.sessionId;
  const lifecycle = projectExistingHostLifecycleContext({
    sessionId,
    cwd: process.cwd(),
    raw,
  });
  const result = await defaultLifecyclePipeline.runSessionEnd(
    { event, isLoopLap: lifecycle.role !== 'interactive' },
    lifecycle,
  );
  if (result.stderr) process.stderr.write(result.stderr + '\n');
  process.exit(result.exitCode);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (session-end): ${String(e)}\n`);
  process.exit(0);
});
