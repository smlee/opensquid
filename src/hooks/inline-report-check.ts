/**
 * Inline report-format check (0.7.30 / D3 follow-up).
 *
 * D3's existing `checkChatSendReportFormat` (pre-tool-use.ts, 0.7.25)
 * only fires when the agent calls `mcp__opensquid__chat_send` with a
 * report-shaped body that lacks the PHASES block. But the agent can
 * also write a status report inline in the session — which never
 * touches chat_send and so escaped D3.
 *
 * This module adds a Stop-hook side check: scan the last assistant
 * message for the shape of a completion report (multiple version
 * references and/or multiple commit hashes), and flag a broken
 * promise when the PHASES heading is missing. UPS surfaces it next
 * turn via the existing broken-promises pipeline.
 *
 * Heuristic (intentionally conservative to keep FPs low):
 *   - 2+ version refs of the form `0.X.Y` or 2+ short-hash refs
 *     `[0-9a-f]{7,}` AND the text lacks `PHASES` heading
 *   - Skipped if no signal at all (single-version mention in prose
 *     doesn't fire)
 */

export interface InlineReportViolation {
  /** First ~120 chars of the assistant text (for the broken-promise's
   * matched_text field). */
  matched_text: string;
  /** Counts of the signals that triggered the check. */
  signals: {
    version_refs: number;
    hash_refs: number;
  };
}

/**
 * Pure: examine assistant text, return a violation descriptor when
 * the shape suggests a completion report but PHASES is missing.
 * Returns null when no violation (either no signal, or PHASES present).
 *
 * Exported for direct testing.
 */
export function checkInlineReportFormat(text: string): InlineReportViolation | null {
  if (!text) return null;
  const versionRefs = countVersionRefs(text);
  const hashRefs = countCommitHashes(text);
  if (versionRefs < 2 && hashRefs < 2) return null;
  if (hasPhasesBlock(text)) return null;
  return {
    matched_text: condense(text),
    signals: { version_refs: versionRefs, hash_refs: hashRefs },
  };
}

/**
 * Count distinct version references of the form `0.X.Y` (semver-shaped).
 * Used as a "this looks like a release summary" signal. Single-version
 * mentions in prose are common; 2+ versions strongly indicate a
 * multi-patch status report.
 *
 * Exported for direct testing.
 */
export function countVersionRefs(text: string): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b\d+\.\d+\.\d{1,3}\b/g)) {
    seen.add(m[0]);
  }
  return seen.size;
}

/**
 * Count distinct short-hash references (`[0-9a-f]{7,40}`). A run of
 * commit hashes is a strong "this is a release/ship summary" signal.
 *
 * Word-boundary anchored so longer sha-like strings still match the
 * 7-char prefix exactly once. Filters out matches that are followed by
 * non-hex digits to reduce noise (e.g. matching only the hex prefix of
 * a long random string).
 *
 * Exported for direct testing.
 */
export function countCommitHashes(text: string): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    // Require at least one a-f letter so we don't false-fire on
    // 7-digit decimal numbers (timestamps, IDs, line counts).
    if (!/[a-f]/.test(m[0])) continue;
    seen.add(m[0]);
  }
  return seen.size;
}

/** True when the text contains a `PHASES` heading line. */
export function hasPhasesBlock(text: string): boolean {
  return /\bPHASES\s*[:\n]/i.test(text);
}

function condense(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
}
