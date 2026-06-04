# Track T-MEMORY-AUDIT-FIXES — fix the 3 actionable findings from the memory audit

**Pre-research:** `docs/research/T-memory-audit-fixes-pre-research-2026-06-04.md` (from the
`/research-audit` run `wf_a99b6c01-cf6`; 10/36 findings survived refutation, 3 actionable).

Execution order: **MF.3 → MF.2 → MF.1** (test seam first, then the two behavior fixes).

---

### Task MF.1: Reconcile re-checks drift after sync (the fail-loud self-audit) [H1]

**Required skills:** opensquid runtime/hooks expert; fail-loud/fail-open contract expert; Vitest dependency-injection expert; Audit expert
**Deliverable:** `reconcileMemoryOnSessionEnd` calls `computeMemoryDrift` after `snapshotAuto` and, when `!inSync`, surfaces the divergence LOUDLY on stderr — so the design's "loudly self-auditing" promise holds at the session boundary, not only on `doctor memory`. Stays fail-open (never throws / blocks session end).
**Depends on:** None.

**Files affected:**
- `src/runtime/hooks/memory_reconcile.ts` (modify) — add the post-sync drift check.
- `src/runtime/hooks/memory_reconcile.test.ts` (modify) — assert the loud surface on drift.

**Key code shapes:**
```ts
// memory_reconcile.ts — inside the existing inner try, after snapshotAuto (line 71):
import { computeMemoryDrift, renderMemoryDrift } from '../../setup/migrate/memory_drift.js';
const r = await snapshotAuto(autoMemDir, home(), engine);
err(`opensquid: memory reconcile — imported ${r.imported}, refreshed ${r.refreshed}, skipped ${r.skipped}, errors ${r.errors.length}\n`);
// MF.1 (H1): the design's loud self-audit — a NON-empty drift AFTER reconcile is a real bug.
const drift = await computeMemoryDrift(autoMemDir, engine);
if (!drift.inSync) err(`opensquid: ${renderMemoryDrift(drift)} — post-reconcile drift (expected in-sync)\n`);
```

**Test fixtures:** inject a stub engine whose post-`snapshotAuto` state is OUT of sync (e.g. an orphaned import-marked entry, or a stale one) and assert `stderr` carries a `DRIFT`/`post-reconcile drift` line; the in-sync case emits NO drift line; an engine that throws during the drift check is caught by the outer catch → the `FAILED` stderr line, session end not blocked.

**Acceptance criteria:**
- [ ] reconcile calls `computeMemoryDrift` after `snapshotAuto`; `!inSync` → loud stderr
- [ ] in-sync → no drift line; a thrown drift check → caught, loud `FAILED`, no throw
- [ ] engine not double-closed (check runs before the `finally` close)
- [ ] full gate chain green

**Risk callouts:** keep the drift check INSIDE the existing inner try (before `finally` close) so the engine is still open; a throw is caught by the outer catch (fail-loud, never block). Do not change the import/refresh counts line.
**References:** `src/runtime/hooks/memory_reconcile.ts:60-81`; `src/setup/migrate/memory_drift.ts:48-103` (computeMemoryDrift + renderMemoryDrift); MAU.3 spec `loop/docs/tasks/T-memory-architecture-unification.md:337`.
**Verification commands:** `pnpm vitest run src/runtime/hooks/memory_reconcile.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE (H1). 2 learn: reuse computeMemoryDrift+renderMemoryDrift, stay in the try. 3 code: the post-sync check. 4 test: drift-surfaced / in-sync-silent / throw-caught. 5 audit: fail-open preserved, no double-close. 6 post-research: n/a. 7 fix.

---

### Task MF.2: Description-aware change detection (description is load-bearing) [H3]

**Required skills:** opensquid migrate/importer expert; memory-retrieval (ADR-0005) expert; Vitest expert; Audit expert
**Deliverable:** the importer refreshes an existing entry when EITHER the body OR the description changed (not body-only) — because ADR-0005 makes `description` load-bearing for retrieval; the body-only-vs-identity decision the spec left open is now made explicit AND correct.
**Depends on:** None.

**Files affected:**
- `src/setup/migrate/auto_memory_importer.ts` (modify) — compare description too + document.
- `src/setup/migrate/auto_memory_importer.test.ts` (modify) — description-only-change refreshes.

**Key code shapes:**
```ts
// auto_memory_importer.ts:112-113 — refresh on body OR description change.
const current = await engine.memoryGet({ id: existing.id });
// MF.2 (H3): description is part of the identity/retrieval surface (ADR-0005: description
// is load-bearing for recall), so a description-only edit MUST refresh — not body-only.
if (current.content !== parsed.body || current.description !== parsed.frontmatter.description) {
  await engine.memoryUpdate({ id: existing.id, description: parsed.frontmatter.description, content: parsed.body, scope });
  result.refreshed += 1;
} else {
  result.skipped += 1;
}
```

**Test fixtures:** an entry whose body matches but description differs → `refreshed` (was `skipped` pre-fix); body+description both match → still `skipped`; body differs → `refreshed` (unchanged).

**Acceptance criteria:**
- [ ] a description-only change refreshes (not skips)
- [ ] identical body+description still skips; a body change still refreshes
- [ ] the body-only→identity decision is documented at the comparison site
- [ ] full gate chain green

**Risk callouts:** `memoryUpdate` already writes `description` (lines 114-119) — only the DETECTION changes. Confirm `parsed.frontmatter.description` is always present (reader contract) or default to '' to avoid an undefined-compare.
**References:** `src/setup/migrate/auto_memory_importer.ts:112-123`; ADR-0005 `loop/docs/decisions/0005-hybrid-memory-retrieval.md:49` ("description quality is load-bearing"); the open fork `loop/docs/tasks/T-memory-architecture-unification.md:103`.
**Verification commands:** `pnpm vitest run src/setup/migrate/auto_memory_importer.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE (H3 + ADR-0005). 2 learn: description-as-identity is correct. 3 code: the OR-compare + comment. 4 test: description-only refreshes. 5 audit: body path intact, decision documented. 6 post-research: n/a. 7 fix.

---

### Task MF.3: Drift fail-loud — test the `memoryGet` rejection path [M1]

**Required skills:** Vitest stub-engine expert; fail-loud-propagation expert; Audit expert
**Deliverable:** `mkEngine` gains the `getThrows` option its own comment already promises, and a test proves `computeMemoryDrift` PROPAGATES a mid-loop `memoryGet` rejection (never a falsely-clean `inSync`). Test-only; no production change.
**Depends on:** None.

**Files affected:**
- `src/setup/migrate/memory_drift.test.ts` (modify) — add `getThrows` to `mkEngine` + the test.

**Key code shapes:**
```ts
// mkEngine opts + memoryGet — honor getThrows (the comment at line 41 already promises it).
opts: { listThrows?: boolean; getThrows?: string } = {},
// ...
const memoryGet = vi.fn().mockImplementation(({ id }: { id: string }) =>
  opts.getThrows === id
    ? Promise.reject(new Error('engine down'))
    : Promise.resolve({ id, description: id, content: engineEntries[id] ?? '', created_at: 't', scope: 'user' }));
```
```ts
it('PROPAGATES a mid-loop memoryGet rejection (never a falsely-clean inSync)', async () => {
  await write('a.md', fixture('a')); await write('b.md', fixture('b'));
  const engine = mkEngine({ a: bodyOf('a'), b: bodyOf('b') }, { getThrows: 'b' });
  await expect(computeMemoryDrift(dir, engine)).rejects.toThrow(/engine down/);
});
```

**Test fixtures:** as above — 2 disk files, engine throws on the 2nd id's `memoryGet`; assert reject.

**Acceptance criteria:**
- [ ] `mkEngine` honors `getThrows`; the memoryGet-rejection test passes
- [ ] the existing `listThrows` test stays green
- [ ] full gate chain green

**Risk callouts:** keep `memoryGet`'s resolved shape identical (only add the reject branch) so other tests are unaffected.
**References:** `src/setup/migrate/memory_drift.test.ts:41,43-71,116-120`; `memory_drift.ts:74` (the memoryGet loop).
**Verification commands:** `pnpm vitest run src/setup/migrate/memory_drift.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE (M1). 2 learn: getThrows seam. 3 code: opts + reject branch + test. 4 test: reject propagates, listThrows green. 5 audit: resolved shape unchanged. 6 post-research: n/a. 7 fix.
