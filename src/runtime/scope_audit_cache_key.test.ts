/**
 * F5 (post-ship logic fixes §3.7 element 5) — the BRANCHED scope-audit-cache key.
 *
 * The bug it fixes: one session-wide key (`fullstack-flow-scope-audit-cache`) held the verdict for EVERY design
 * doc, so a NEW doc's FIRST write inherited a PRIOR doc's stale not-GUESS_FREE verdict → wrongly blocked (the
 * `undefined ⇒ first-write ⇒ ALLOW` invariant broke). PURE — no `.opensquid` I/O; the integration case composes
 * the real {@link scopeAuditCacheKey} with the real {@link checkDesignDocRewrite} over an in-memory verdict map.
 */
import { describe, expect, it } from 'vitest';

import { scopeAuditCacheKey, SCOPE_AUDIT_SESSION_KEY } from './scope_audit_cache_key.js';
import { checkDesignDocRewrite } from './guard/orchestrator_guard.js';

describe('scopeAuditCacheKey (F5 — the branched key derivation)', () => {
  it('a design doc keys PER-DOC (distinct docs → distinct keys → no stale inheritance)', () => {
    const a = scopeAuditCacheKey('docs/design/opensquid-reporting-model.md');
    const b = scopeAuditCacheKey('docs/design/opensquid-release-flow.md');
    expect(a).not.toBe(b);
    expect(a).not.toBe(SCOPE_AUDIT_SESSION_KEY);
    expect(b).not.toBe(SCOPE_AUDIT_SESSION_KEY);
  });

  it('the pre-research / SCOPE artifact KEEPS the session-wide key (v2_supply scope read never stranded)', () => {
    expect(
      scopeAuditCacheKey(
        'docs/research/opensquid-post-ship-logic-fixes-pre-research-2026-07-08.md',
      ),
    ).toBe(SCOPE_AUDIT_SESSION_KEY);
    // any non-design path (empty, a src file) → the session default, never a per-doc key.
    expect(scopeAuditCacheKey('')).toBe(SCOPE_AUDIT_SESSION_KEY);
    expect(scopeAuditCacheKey('src/x.ts')).toBe(SCOPE_AUDIT_SESSION_KEY);
  });

  it('normalizes to the docs/design/ segment (absolute + repo-relative paths of the same doc agree)', () => {
    expect(scopeAuditCacheKey('/Users/x/projects/loop/opensquid/docs/design/foo.md')).toBe(
      scopeAuditCacheKey('docs/design/foo.md'),
    );
  });

  it('the same doc → a STABLE key (a rewrite reads its own verdict)', () => {
    expect(scopeAuditCacheKey('docs/design/foo.md')).toBe(scopeAuditCacheKey('docs/design/foo.md'));
  });

  it('sanitizes the key — no `/` reaches sessionStateFile (no traversal, no nested dirs)', () => {
    const key = scopeAuditCacheKey('docs/design/nested/deep-doc.md');
    expect(key).not.toContain('/');
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('F5 end-to-end: per-doc verdict isolation through the real rewrite gate', () => {
  // The real gate + the real key over an in-memory verdict store: exactly what pre-tool-use wires, minus fs.
  const cache = new Map<string, string>();
  const gateFor = (filePath: string) =>
    checkDesignDocRewrite('Write', { file_path: filePath }, undefined, {
      readScopeVerdict: () => Promise.resolve(cache.get(scopeAuditCacheKey(filePath))),
    });

  it("a NEW doc's first write is ALLOWED even though ANOTHER doc's verdict is UNRESOLVED; the same doc's rewrite still DENIES", async () => {
    const docA = 'docs/design/doc-a.md';
    const docB = 'docs/design/doc-b.md';
    // doc A was audited UNRESOLVED (a not-GUESS_FREE rewrite verdict), stored under A's per-doc key.
    cache.set(scopeAuditCacheKey(docA), 'VERDICT: UNRESOLVED\n- a redundancy defect');

    // doc B has NEVER been audited → its per-doc key is absent → first write ALLOWED (invariant restored).
    expect((await gateFor(docB)).deny).toBe(false);
    // doc A's own rewrite still reads A's UNRESOLVED verdict → DENIED (the gate still bites the right doc).
    expect((await gateFor(docA)).deny).toBe(true);
  });
});
