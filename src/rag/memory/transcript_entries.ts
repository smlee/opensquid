/**
 * Per-entry parser for the Claude Code transcript JSONL — the always-on RAG ingest's read side
 * (T-memory-foundation, design §5). The existing `runtime/hooks/transcript.ts` readers return a JOINED
 * text string and model a stripped text-only `TranscriptEntry` (no uuid/timestamp, no tool blocks), and
 * they feed the SG.3-sensitive live wedge gate — so this is a dedicated, isolated parser, not a reuse.
 *
 * Grounded in the live transcript JSONL (inspected 2026-06-24): every message entry carries a unique,
 * stable top-level `uuid` + `timestamp`; `message.content` is a string OR an array of blocks; block types
 * are `text` / `thinking` / `tool_use` / `tool_result`. `thinking` is EXCLUDED — §5 captures "everything
 * said … the conversation"; internal reasoning is not "said".
 */
import { readFile } from 'node:fs/promises';

export interface TranscriptMessageEntry {
  uuid: string;
  timestamp: string;
  role: 'user' | 'assistant';
  /** Serialized verbatim content (text + tool_use + tool_result; `thinking` excluded). */
  content: string;
  /** True when the entry carries any `tool_use` / `tool_result` block. */
  hasTool: boolean;
}

interface RawBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown; // tool_result payload: string OR array
}

interface RawEntry {
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | RawBlock[] };
}

function serializeContent(content: string | RawBlock[]): { text: string; hasTool: boolean } {
  if (typeof content === 'string') return { text: content, hasTool: false };
  let hasTool = false;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (typeof b.text === 'string') parts.push(b.text);
    } else if (b.type === 'tool_use') {
      hasTool = true;
      parts.push(`[tool_use ${b.name ?? '?'}] ${JSON.stringify(b.input ?? null)}`);
    } else if (b.type === 'tool_result') {
      hasTool = true;
      const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null);
      parts.push(`[tool_result] ${c}`);
    }
    // `thinking` and any unknown block type are skipped (capture the conversation, not internal reasoning).
  }
  return { text: parts.join('\n'), hasTool };
}

/**
 * Parse the transcript JSONL into per-message records. Skips non-message lines (no `message.role` / no
 * `uuid`) and empty-after-serialization entries (e.g. a thinking-only assistant turn). Fail-soft: an
 * unreadable file yields `[]`; a malformed line is skipped — never throws.
 */
export async function readTranscriptEntries(path: string): Promise<TranscriptMessageEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: TranscriptMessageEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let e: RawEntry;
    try {
      e = JSON.parse(line) as RawEntry;
    } catch {
      continue;
    }
    const role = e.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof e.uuid !== 'string' || e.message?.content === undefined) continue;
    const { text, hasTool } = serializeContent(e.message.content);
    if (text.length === 0) continue;
    out.push({
      uuid: e.uuid,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString(),
      role,
      content: text,
      hasTool,
    });
  }
  return out;
}
