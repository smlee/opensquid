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
import { emitDriftStderrAndExit, squidPrefix } from './hook_output.js';
import { claimUmbrellaLeaseForSession } from '../chat/claim_lease.js';
import { maybeDriveInbound, extractCwd } from './stop_drive.js';
import { maybeStreamOutput } from './stop_stream.js';
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
  // transcript `.jsonl` (CC always provides `transcript_path`) so Stop-event
  // gates that read assistantText (honesty-ledger, phase-logging) see what was
  // written instead of an empty string. Fail-open: a transcript-read failure
  // leaves assistantText '' (pre-fix behavior), never crashes the hook.
  // ⚠️ SG.3 caveat: this is off-by-one (returns the PRIOR response if the
  // triggering one isn't flushed yet) — see transcript.ts. recall-consumed was
  // removed for relying on this to judge its own triggering response.
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

  // A drift BLOCK (exit≠0) takes precedence over an inbound drive — handle the
  // agent's drift first; the chat backlog drives on a later, clean turn.
  if (exitCode !== 0) emitDriftStderrAndExit(exitCode, stderr);

  const cwd = extractCwd(raw);

  // Interactive responder: this live session claims its umbrella's chat lease
  // (acquire-if-free) so the drive below owns the turn + the headless stands
  // down. No-op in `responder: headless` mode or when another session holds it.
  await claimUmbrellaLeaseForSession(sessionId, cwd);

  // CAT.3 — "see": if THIS just-completed turn was chat-driven (CAT.2 left the
  // marker), stream the agent's answer back to the source topic automatically
  // (reply-to-source; the agent never picks the channel). No-op otherwise.
  const assistantText = parsed.data.kind === 'stop' ? parsed.data.assistantText : '';
  await maybeStreamOutput(sessionId, cwd, assistantText);

  // CAT.2 — "drive": if this session holds the umbrella's chat lease and has
  // unacked inbound, block the stop and feed the inbound as the next turn so a
  // chat message DRIVES a turn without a keystroke (the remote-terminal "drive").
  const driveReason = await maybeDriveInbound(sessionId, cwd);
  if (driveReason !== null) {
    if (stderr.length > 0) process.stderr.write(squidPrefix(stderr) + '\n');
    process.stdout.write(JSON.stringify({ decision: 'block', reason: driveReason }) + '\n');
    process.exit(0);
  }

  emitDriftStderrAndExit(0, stderr);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (stop): ${String(e)}\n`);
  process.exit(0);
});
