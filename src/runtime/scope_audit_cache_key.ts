/**
 * F5 — the BRANCHED scope-audit-cache key (post-ship logic fixes, §3.7 element 5).
 *
 * The content-audit SCOPE trigger writes ONE verdict cache for two DIFFERENT artifacts under one key today
 * (`fullstack-flow-scope-audit-cache`): the pre-research/SCOPE-stage doc (`docs/research/*-pre-research-*`) AND
 * the design doc (`docs/design/*.md`). Two readers consume it: (i) the loop's scope-STAGE gate
 * (`v2_supply.ts` → `audit.scope` → `scope_ready`/`plan_ready`/`scope_write_ready`) and (ii) the orchestrator
 * design-doc REWRITE gate (`pre-tool-use.ts`). Because the key is per-SESSION not per-DOC, a NEW design doc's
 * FIRST write inherits a PRIOR doc's stale verdict → wrongly blocked (the `undefined ⇒ first-write ⇒ ALLOW`
 * invariant broke).
 *
 * The fix keys the DESIGN-DOC verdict PER-DOC while KEEPING the session-wide key for the pre-research/SCOPE
 * artifact — so the loop's scope-stage read (which only ever concerns the pre-research doc) is NEVER stranded.
 * ONE derivation, used by BOTH sides (the skill WRITER and the design-doc READER) so their keys always agree.
 *
 * Imports from: ./guard/orchestrator_guard.js (the shared `isDesignDoc` classifier).
 * Imported by: ./hooks/pre-tool-use.ts (the reader) + ../functions/scope_audit_cache_key.ts (the skill writer).
 */
import { isDesignDoc } from './guard/orchestrator_guard.js';

/** The session-wide key the pre-research/SCOPE-stage verdict keeps (read by `v2_supply.ts` → `audit.scope`). */
export const SCOPE_AUDIT_SESSION_KEY = 'fullstack-flow-scope-audit-cache';

/**
 * The scope-audit-cache key for a given artifact path. A `docs/design/*.md` design doc keys PER-DOC (derived from
 * its path); every other path (the pre-research/SCOPE artifact) keeps {@link SCOPE_AUDIT_SESSION_KEY}. The per-doc
 * suffix is normalized to the `docs/design/...` segment (so an absolute and a repo-relative path agree) and
 * sanitized to `[A-Za-z0-9_-]` — `sessionStateFile` does NOT sanitize the key, so a raw path with `/` must never
 * reach it (no traversal, no nested dirs).
 */
export function scopeAuditCacheKey(filePath: string): string {
  if (!isDesignDoc(filePath)) return SCOPE_AUDIT_SESSION_KEY;
  const marker = 'docs/design/';
  const idx = filePath.lastIndexOf(marker);
  const rel = idx >= 0 ? filePath.slice(idx) : filePath;
  const safe = rel.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${SCOPE_AUDIT_SESSION_KEY}-doc-${safe}`;
}
