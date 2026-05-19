/**
 * CLAUDE.md sentinel-block management.
 *
 * Two managed blocks live inside `~/.claude/CLAUDE.md`:
 *
 *   1. `opensquid-automation:start vX.Y.Z` ... `opensquid-automation:end`
 *      — the outer behavioral instructions block, written by
 *      `opensquid install` (src/cli.ts).
 *
 *   2. `opensquid-rules:start (auto-managed)` ... `opensquid-rules:end`
 *      — an inner block nested INSIDE the automation block, holding
 *      one-line summaries of promoted lessons. Auto-managed at
 *      runtime: every `lesson.promote` success appends an entry here
 *      so the agent reads promoted rules at session start with no
 *      recall lag.
 *
 * This module exposes the runtime updater for the inner rules block.
 * The CLAUDE.md installer / uninstaller (src/cli.ts) owns the outer
 * block; this module ONLY touches what's between the inner sentinels.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RULES_START = "<!-- opensquid-rules:start (auto-managed) -->";
const RULES_END = "<!-- opensquid-rules:end -->";

const PLACEHOLDER = "(no promoted lessons yet";

/** Resolved path to the user's global CLAUDE.md. */
export function defaultClaudeMdPath(): string {
  return path.join(os.homedir(), ".claude", "CLAUDE.md");
}

export interface PromotedLessonEntry {
  /** Engine lesson id (e.g. "les-abc12345"). */
  id: string;
  /** One-line description (trigger phrase + concise summary). */
  description: string;
  /** ISO timestamp the promotion happened. */
  promoted_at: string;
}

/**
 * Append a one-line entry for a newly promoted lesson into the
 * CLAUDE.md rules sub-block. Idempotent — if an entry for `id` already
 * exists, the line is left untouched. Returns the path written + the
 * new content of the rules block (without sentinels).
 *
 * No-op (silent) when:
 *   - CLAUDE.md doesn't exist
 *   - The rules sub-block isn't installed yet (user hasn't run
 *     `opensquid install` against this CLAUDE.md)
 *
 * Failure is intentionally non-fatal: lesson promotion is the
 * authoritative event; CLAUDE.md is downstream display. We never block
 * the promote on a CLAUDE.md write failure.
 */
export async function appendPromotedLessonToClaudeMd(
  entry: PromotedLessonEntry,
  options: { target?: string } = {},
): Promise<{ target: string; appended: boolean } | null> {
  const target = options.target ?? defaultClaudeMdPath();
  let content: string;
  try {
    content = await fs.readFile(target, "utf8");
  } catch {
    return null;
  }

  const block = findRulesBlock(content);
  if (!block) return null;

  // Idempotency: skip if this lesson id already appears in the block.
  const idMarker = `(lesson:${entry.id})`;
  if (block.inner.includes(idMarker)) {
    return { target, appended: false };
  }

  // Strip the placeholder if it's the only thing in the block.
  const cleaned = block.inner.includes(PLACEHOLDER) ? "" : block.inner.trimEnd();

  const newLine = `- ${entry.description.trim()} ${idMarker} — promoted ${entry.promoted_at}`;
  const nextInner = cleaned.length === 0 ? `\n${newLine}\n` : `${cleaned}\n${newLine}\n`;

  const nextContent =
    content.slice(0, block.innerStart) + nextInner + content.slice(block.innerEnd);
  await fs.writeFile(target, nextContent, "utf8");
  return { target, appended: true };
}

interface RulesBlock {
  /** Content between the two sentinels (excluding sentinels themselves). */
  inner: string;
  /** Index in `content` where inner content starts (after start sentinel + newline). */
  innerStart: number;
  /** Index in `content` where inner content ends (before end sentinel). */
  innerEnd: number;
}

function findRulesBlock(content: string): RulesBlock | null {
  const startIdx = content.indexOf(RULES_START);
  if (startIdx === -1) return null;
  const endIdx = content.indexOf(RULES_END, startIdx + RULES_START.length);
  if (endIdx === -1) return null;
  // inner starts right after the start sentinel (allowing a trailing newline).
  let innerStart = startIdx + RULES_START.length;
  if (content[innerStart] === "\n") innerStart++;
  // inner ends at the start of the end sentinel.
  const innerEnd = endIdx;
  return {
    inner: content.slice(innerStart, innerEnd),
    innerStart,
    innerEnd,
  };
}

/**
 * For tests + diagnostics: list the lesson ids currently appearing in
 * the rules sub-block of a given CLAUDE.md.
 */
export async function listRulesBlockLessonIds(
  options: { target?: string } = {},
): Promise<string[]> {
  const target = options.target ?? defaultClaudeMdPath();
  let content: string;
  try {
    content = await fs.readFile(target, "utf8");
  } catch {
    return [];
  }
  const block = findRulesBlock(content);
  if (!block) return [];
  const ids: string[] = [];
  const re = /\(lesson:([a-z0-9-]+)\)/g;
  for (const m of block.inner.matchAll(re)) {
    ids.push(m[1]);
  }
  return ids;
}
