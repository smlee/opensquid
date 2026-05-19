/**
 * Drift catalog — automated SessionEnd scan that surfaces this session's
 * drift signals (0.7.22 / drift D10).
 *
 * D10 in the catalog: previously the agent only catalogued its drifts
 * AFTER the user prompted "please put in all the drifting issues found
 * recently." The whole project is anti-drift; the agent should be
 * cataloguing its own drifts continuously as the dogfood proof.
 *
 * This module scans the session's JSONL transcript at SessionEnd for
 * three classes of drift markers:
 *
 *   1. User-correction phrases in user messages ("you drifted",
 *      "stop X-ing", "no not that", "wrong")
 *   2. Locked-rule citations in user OR assistant messages
 *      (feedback_*, mem-*, drift D\d+)
 *   3. Agent mea-culpa phrases in assistant messages ("I should
 *      have", "my mistake", "I drifted", "I false-stopped")
 *
 * Hits are appended to `<dataRoot>/projects/<uuid>/drift-catalog.jsonl`.
 * One JSON record per line: `{timestamp, session_id, kind, evidence}`.
 *
 * If the project UUID can't be resolved (no `.opensquid/project.json`
 * card in any ancestor of cwd), entries fall back to
 * `<dataRoot>/sessions/<session_id>/drift-catalog.jsonl` so the data
 * isn't lost.
 *
 * Fail-open: any error (missing transcript, bad JSONL, write failure)
 * is swallowed with a stderr warning. SessionEnd is cleanup, not
 * blocking.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";
import { findProjectCard } from "../project.js";

import { readTranscriptLines } from "./transcript.js";

export type DriftMarkerKind = "user_correction" | "rule_citation" | "mea_culpa";

export interface DriftCatalogEntry {
  /** ISO timestamp the entry was recorded. */
  timestamp: string;
  /** Claude Code session id. */
  session_id: string;
  /** Which class of marker fired. */
  kind: DriftMarkerKind;
  /** The matched substring (capped at 200 chars). */
  evidence: string;
  /** Optional surrounding context (up to 200 chars on either side). */
  context?: string;
}

/**
 * Locked-rule citation pattern. Matches:
 *   - `feedback_xxx` style memory file names
 *   - `mem-<hex>` style memory ids
 *   - `drift D1` through `drift D99` (the in-session catalog)
 */
const RULE_CITATION_REGEX = /\b(feedback_\w+|mem-[a-f0-9]+|drift\s+D\d+)\b/i;

/**
 * User-correction phrases. Conservative on purpose — false-positives in
 * the catalog are tolerable (it's a dogfood log, not user-facing) but
 * we don't want to flood with every "wrong" in unrelated prose.
 */
const USER_CORRECTION_REGEX =
  /\b(you drifted|you're drifting|that'?s wrong|that'?s drift|stop (asking|doing|that|it)|don'?t (ask|do|repeat|forget)|no,? not that|you keep (drifting|doing))\b/i;

/**
 * Agent mea-culpa phrases. Catches the patterns the agent uses when
 * acknowledging it drifted — useful retroactive signal.
 */
const MEA_CULPA_REGEX =
  /\b(I should have|I drifted|sorry,? I (drifted|missed)|that was a drift|I false-?stopped|I false-?started|I keep drifting|my (mistake|drift))\b/i;

interface TranscriptEvent {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Scan a transcript and return all detected drift markers. Pure
 * function; exported for direct testing.
 */
export function scanTranscriptForDrift(
  lines: string[],
  sessionId: string,
  now: () => Date = () => new Date(),
): DriftCatalogEntry[] {
  const entries: DriftCatalogEntry[] = [];
  for (const line of lines) {
    const event = safeParseLine(line);
    if (!event) continue;

    if (event.type === "user") {
      const text = extractUserText(event);
      if (!text) continue;
      pushIfMatch(entries, text, USER_CORRECTION_REGEX, "user_correction", sessionId, now);
      pushIfMatch(entries, text, RULE_CITATION_REGEX, "rule_citation", sessionId, now);
    } else if (event.type === "assistant") {
      const text = extractAssistantText(event);
      if (!text) continue;
      pushIfMatch(entries, text, MEA_CULPA_REGEX, "mea_culpa", sessionId, now);
      pushIfMatch(entries, text, RULE_CITATION_REGEX, "rule_citation", sessionId, now);
    }
  }
  return entries;
}

function pushIfMatch(
  entries: DriftCatalogEntry[],
  text: string,
  regex: RegExp,
  kind: DriftMarkerKind,
  sessionId: string,
  now: () => Date,
): void {
  const match = text.match(regex);
  if (!match) return;
  const evidence = match[0].slice(0, 200);
  const idx = text.indexOf(match[0]);
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + match[0].length + 100);
  const context = text.slice(start, end);
  entries.push({
    timestamp: now().toISOString(),
    session_id: sessionId,
    kind,
    evidence,
    context,
  });
}

/**
 * Run the SessionEnd drift-catalog scan + persist results. Returns
 * the number of entries written (0 if nothing matched OR write failed).
 */
export async function runDriftCatalogScan(input: {
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  dataRoot?: string;
  now?: () => Date;
}): Promise<number> {
  if (!input.transcriptPath) return 0;

  let lines: string[];
  try {
    lines = await readTranscriptLines(input.transcriptPath);
  } catch {
    return 0;
  }

  const entries = scanTranscriptForDrift(lines, input.sessionId, input.now);
  if (entries.length === 0) return 0;

  const targetPath = await resolveCatalogPath(input.cwd, input.sessionId, input.dataRoot);
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const serialized = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.appendFile(targetPath, serialized, "utf8");
    return entries.length;
  } catch {
    return 0;
  }
}

/**
 * Decide where to write the catalog: project-scoped if we can resolve
 * a project UUID from cwd; session-scoped fallback otherwise.
 *
 * Exported for testing.
 */
export async function resolveCatalogPath(
  cwd: string | undefined,
  sessionId: string,
  dataRoot?: string,
): Promise<string> {
  const root = resolveDataRoot(dataRoot);
  if (cwd) {
    try {
      const found = await findProjectCard(cwd);
      if (found) {
        return path.join(root, "projects", found.card.uuid, "drift-catalog.jsonl");
      }
    } catch {
      // fall through to session-scoped fallback
    }
  }
  return path.join(root, "sessions", sessionId, "drift-catalog.jsonl");
}

// ---------------------------------------------------------------------
// Local duck-typed transcript parsing (mirrors transcript.ts patterns
// to avoid widening the public surface of that module).
// ---------------------------------------------------------------------

function safeParseLine(line: string): TranscriptEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as TranscriptEvent;
  } catch {
    return null;
  }
}

function extractUserText(event: TranscriptEvent): string {
  const content = event.message?.content;
  if (typeof content === "string") return content;
  return "";
}

function extractAssistantText(event: TranscriptEvent): string {
  const content = event.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}
