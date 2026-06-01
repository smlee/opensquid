/**
 * Transcript reader (T-HANDOFF-HARDENING HH7.1).
 *
 * Claude Code does NOT include the assistant's response text in a hook's stdin
 * payload — but it DOES provide `transcript_path` (the session `.jsonl`). This
 * helper recovers the last assistant message text from the transcript so
 * Stop-event gates that read `event.assistantText` (honesty-ledger,
 * phase-logging) see what was written instead of an empty string.
 *
 * ⚠️ KNOWN LIMITATION (SG.3, 2026-06-01): at the moment a Stop hook fires, the
 * response that TRIGGERED it may not be flushed to the transcript yet — so this
 * returns the PRIOR assistant message (off-by-one). A Stop gate therefore
 * cannot reliably judge its own triggering response. `recall-consumed` was
 * REMOVED for exactly this (it judged the wrong message → 9× loop). The rule:
 * gates that judge the just-emitted response belong at the next
 * `UserPromptSubmit` (prior response settled + turn ledger reset), NOT at Stop.
 * Remaining Stop consumers (honesty-ledger, phase-logging) inherit this
 * off-by-one and should be audited.
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

/**
 * Return the last `n` text-bearing turns (user + assistant), oldest→newest,
 * role-labeled (`User:` / `Assistant:`). Used by the wedge-gate `lesson-capture`
 * skill (FU.2), which classifies the recent conversation for offloadable
 * lessons — it needs multi-turn context, not just the single prior assistant
 * turn `readLastAssistantText` provides.
 *
 * Same defensive contract as `readLastAssistantText`: per-line try/catch,
 * pure-tool_use turns skipped, `''` on absent/unreadable/all-malformed. `n <= 0`
 * returns `''`.
 */
export async function readLastNTurns(transcriptPath: string, n: number): Promise<string> {
  if (n <= 0) return '';
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split('\n');
  const collected: string[] = []; // newest→oldest while collecting
  for (let i = lines.length - 1; i >= 0 && collected.length < n; i--) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    const role =
      entry.message?.role ??
      (entry.type === 'assistant' || entry.type === 'user' ? entry.type : undefined);
    if (role !== 'assistant' && role !== 'user') continue;
    const text = (entry.message?.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    if (text.trim().length === 0) continue; // skip pure tool_use turns
    const label = role === 'assistant' ? 'Assistant' : 'User';
    collected.push(`${label}: ${text}`);
  }
  return collected.reverse().join('\n\n'); // oldest→newest
}
