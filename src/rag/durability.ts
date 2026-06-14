/**
 * `classifyDurability` — the write-time durability classifier (T-stale-context-injection SCI.1,
 * wg-4f91e0b5cb8c).
 *
 * A memory is `point_in_time` iff its truth is bound to a specific moment/session/version that
 * becomes false once acted on (a handoff/resume/status/version snapshot); otherwise `durable`
 * (a principle/architecture fact). This distinction has no existing home on `Lesson` — `author`
 * spans BOTH classes (the live store has user-authored point-in-time handoffs, e.g.
 * `mem-0eac71e81ae814ab` "2026-06-09 HANDOFF — …", AND user-authored durable principles), so the
 * classifier keys off explicit caller intent first, then a deterministic content-marker signal.
 *
 * Cheap-deterministic-first (the locked trigger model, wg-3d175ec06767): an explicit `durability`
 * arg wins; absent it, a leading-prose marker (`HANDOFF`/`RESUME`/`TO SHIP`) classifies
 * `point_in_time`; no signal ⇒ `durable` (fail-safe — a misclassified durable memory keeps full
 * recall, the safe direction). The marker set covers the OBSERVED class; prefix-less point-in-time
 * memories are a known residual (measured by the S-classify spike) — NOT claimed exhaustive.
 *
 * Imported by: src/mcp/tools/memorize.ts (write path), the SCI.1 backfill, durability.test.ts.
 */

import type { Durability } from './types.js';

// Markers are a LEADING-prose signal (a memory that opens "…HANDOFF —" / "RESUME: …" / "… TO SHIP
// …"), not body-wide — a durable principle that merely mentions the word "handoff" deep in its body
// must NOT be mis-flagged. Scanned over the first ~200 chars only. Case-insensitive, multiline.
const PIT_MARKERS = /\b(HANDOFF|RESUME|TO SHIP)\b/i;
const LEAD_CHARS = 200;

/**
 * Classify a memory body's durability. `explicit` (the caller's `memorize` arg) always wins; absent
 * it, the deterministic content-marker signal decides; no signal ⇒ `durable` (fail-safe).
 */
export function classifyDurability(content: string, explicit?: Durability): Durability {
  if (explicit !== undefined) return explicit;
  return PIT_MARKERS.test(content.slice(0, LEAD_CHARS)) ? 'point_in_time' : 'durable';
}
