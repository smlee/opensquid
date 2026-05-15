/**
 * Shared transcript-JSONL helpers for hooks that need to read what the
 * last user or assistant message was.
 *
 * Claude Code writes one event per line. Schema is duck-typed because
 * the official shape isn't documented as stable — fields we don't
 * recognize are ignored.
 */

import { promises as fs } from "node:fs";

interface TranscriptEvent {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Walk the transcript JSONL backwards and return the most recent USER
 * message text. Tool-result events (which also have `type: "user"`
 * but carry an array `content` of tool_result blocks) are skipped — we
 * only return user-typed plain-string utterances.
 *
 * Returns "" on any error or if no plain-string user message exists.
 */
export async function readLastUserText(transcriptPath: string): Promise<string> {
  const lines = await readTranscriptLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = safeParseLine(lines[i]);
    if (!event || event.type !== "user") continue;
    const content = event.message?.content;
    // Only accept plain string utterances. Tool-result events carry
    // an array `content` and aren't real user speech.
    if (typeof content === "string" && content.trim()) return content;
  }
  return "";
}

/**
 * Walk the transcript JSONL backwards and return the most recent
 * ASSISTANT message text. Concatenates text blocks if content is an
 * array of typed blocks.
 */
export async function readLastAssistantText(transcriptPath: string): Promise<string> {
  const lines = await readTranscriptLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = safeParseLine(lines[i]);
    if (!event || event.type !== "assistant") continue;
    const text = extractAssistantText(event);
    if (text) return text;
  }
  return "";
}

async function readTranscriptLines(transcriptPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(transcriptPath, "utf8");
    return raw.split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

function safeParseLine(line: string): TranscriptEvent | null {
  try {
    return JSON.parse(line) as TranscriptEvent;
  } catch {
    return null;
  }
}

function extractAssistantText(event: TranscriptEvent): string {
  const content = event.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}
