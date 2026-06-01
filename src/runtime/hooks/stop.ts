#!/usr/bin/env node
/**
 * Claude Code `Stop` hook binary.
 *
 * Fires when the assistant emits a stop turn (end of an assistant message).
 * Payload carries the assistant's final text — used by destination-check
 * rules to evaluate "did the agent stay on the goal."
 *
 * Wired in `~/.claude/settings.json`:
 *
 *   { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
 *     "command": "opensquid-hook-stop" }] }] } }
 *
 * stdin = stop event JSON. exit 0 = allow (continue session normally),
 * exit 2 = block (in practice this surfaces a warning to the agent; the
 * stop itself can't be "blocked"). Stderr messages are shown.
 *
 * Fail-open on any internal error — see `main().catch()` below.
 */
import { buildRegistry, loadActivePacks } from '../bootstrap.js';
import { Event } from '../types.js';

import { dispatchEvent } from './dispatch.js';
import { extractSessionId } from './session_id.js';
import { readLastAssistantText } from './transcript.js';

interface StopPayload {
  assistantText?: string;
  assistant_text?: string;
  message?: string;
  transcript_path?: string;
  transcriptPath?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as StopPayload;
  return {
    kind: 'stop',
    // Claude Code's Stop payload field name isn't 100% pinned across versions;
    // accept camelCase, snake_case, or a generic `message` field.
    assistantText: obj.assistantText ?? obj.assistant_text ?? obj.message ?? '',
  };
}

/** Extract the transcript `.jsonl` path from a Stop payload (snake/camel). */
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

  // HH7.1: Claude Code omits the assistant response text from Stop stdin, so
  // `assistantText` is empty here. Recover the last assistant message from the
  // transcript `.jsonl` (CC always provides `transcript_path`) so destination /
  // recall-consumed gates evaluate what was actually written instead of an
  // empty string (the false-positive root cause). Fail-open: a transcript-read
  // failure leaves assistantText '' (pre-fix behavior), never crashes the hook.
  if (parsed.data.kind === 'stop' && parsed.data.assistantText === '') {
    const transcriptPath = extractTranscriptPath(raw);
    if (transcriptPath !== null) {
      parsed.data.assistantText = await readLastAssistantText(transcriptPath);
    }
  }

  const sessionId = extractSessionId(raw);
  const packs = await loadActivePacks(sessionId);
  const registry = await buildRegistry();
  const { exitCode, stderr } = await dispatchEvent(parsed.data, packs, registry, sessionId);
  if (stderr) process.stderr.write(stderr + '\n');
  process.exit(exitCode);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (stop): ${String(e)}\n`);
  process.exit(0);
});
