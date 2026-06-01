/**
 * Transcript reader (T-HANDOFF-HARDENING HH7.1).
 *
 * Claude Code does NOT include the assistant's response text in a hook's stdin
 * payload — but it DOES provide `transcript_path` (the session `.jsonl`). The
 * `recall-consumed` (DPC.3) gate relied on `event.assistantText`, which was
 * therefore always `''`, so it regex-matched consumption vocabulary against an
 * empty string and false-positive-looped. This helper recovers the last
 * assistant message text from the transcript so the gate sees what was actually
 * written.
 *
 * Defensive by construction: the transcript schema is harness-owned and can
 * shift across Claude Code versions, so EVERY line is parsed in its own
 * try/catch with optional chaining, and any failure (absent file, unreadable,
 * all-malformed) returns `''`. The caller (a Stop hook) must never crash over a
 * transcript read — `''` degrades to the pre-fix behavior, never throws.
 *
 * Imports from: node:fs/promises.
 * Imported by: src/runtime/hooks/stop.ts.
 */

import { readFile } from 'node:fs/promises';

interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: { type?: string; text?: string }[];
  };
}

/**
 * Return the concatenated text of the most recent assistant entry that carries
 * text. Pure tool_use turns (no text blocks) are skipped — the gate wants the
 * agent's prose, not a tool-call-only turn. `''` on absent/unreadable/no-text.
 */
export async function readLastAssistantText(transcriptPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // a malformed line must not abort the walk
    }
    if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue;
    const text = (entry.message?.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    if (text.trim().length > 0) return text; // skip pure tool_use turns
  }
  return '';
}
