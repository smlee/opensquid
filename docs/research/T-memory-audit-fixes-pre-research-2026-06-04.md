# Pre-research — T-MEMORY-AUDIT-FIXES (2026-06-04)

Source: the `/research-audit` adversarial audit of the memory subsystem (run
`wf_a99b6c01-cf6`, 36 findings → 10 survived refutation). Three are actionable code/test
work; this scopes their fixes. All evidence re-verified by direct read (never-guess).

## §1 — Findings being fixed (verified)

- **MF.1 [H1] — fail-loud self-audit missing at the session boundary.** The design promises
  the sync is "automatic, self-healing, and LOUDLY self-auditing", and the MAU.3 spec says
  "a non-empty drift AFTER reconcile surfaces loudly." But
  `src/runtime/hooks/memory_reconcile.ts:60-81` calls `snapshotAuto` (line 71), writes
  import/refresh/skip/error counts (72-74), and **never calls `computeMemoryDrift`.** The
  detector exists (`src/setup/migrate/memory_drift.ts`) and is wired into `doctor.ts:297`
  (on-command ONLY). So the loud self-audit is a manual command, absent at the exact
  automatic surface where the original silent-drift failure occurred. SEVERITY HIGH.
- **MF.2 [H3] — change-detection is body-only; an undocumented + sub-optimal choice.**
  `src/setup/migrate/auto_memory_importer.ts:112-113` refreshes only when
  `current.content !== parsed.body`. A description-only edit (body identical) is NOT
  detected → the engine keeps the stale description. The spec
  (`loop/docs/tasks/T-memory-architecture-unification.md:103`) left this as a fork to lock;
  the code chose body-only silently (No-Implicit-State violation). SEVERITY HIGH (the audit
  framed it as documentation; see §2 for the corrected scope).
- **MF.3 [M1] — drift fail-loud propagation untested on the `memoryGet` path.**
  `memory_drift.test.ts:116-120` proves propagation but only mocks `listThrows`
  (`fetchExistingImportIndex`/`memoryList`). The per-entry `engine.memoryGet` loop
  (`memory_drift.ts:74`) has no test for a mid-loop rejection — and `mkEngine`'s own comment
  (`memory_drift.test.ts:41`) promises a `getThrows` option that is NOT in its type/impl
  (line 45, 65). SEVERITY MED.

NOT actionable (no code): H4 (safety moved into loop-engine — out of this repo's reach),
L1–L5 (confirmations / enforced invariants).

## §2 — Fix design (simplest correct, per lexicon)

- **MF.1:** in `reconcileMemoryOnSessionEnd`, AFTER `snapshotAuto` (line 71), call
  `computeMemoryDrift(autoMemDir, engine)` (same dir, same engine instance, already in
  scope) and if `!inSync`, surface it LOUDLY via the existing `err()` + `renderMemoryDrift`
  (both importable from `../../setup/migrate/memory_drift.js`). Reuse, don't reinvent —
  the detector + renderer already exist. Stays fail-loud-but-never-throw (inside the
  existing try; a drift-check failure is caught by the outer catch → loud stderr, no block).
- **MF.2:** the BEST solution is not merely to document body-only — it is to compare the
  `description` too, because ADR-0005 makes `description` "load-bearing" for retrieval (a
  stale description = wrong recall). Change the detection to
  `current.content !== parsed.body || current.description !== parsed.frontmatter.description`
  → refresh (the `memoryUpdate` call already writes both fields, lines 114-119, so no other
  change). Document the decision (description IS part of the identity/retrieval surface) at
  the comparison site — closing the No-Implicit-State gap by making the choice explicit AND
  correct. (Alternative — document-body-only — rejected: it locks a sub-optimal choice the
  design's own retrieval principle argues against.)
- **MF.3:** add `getThrows?: string` to `mkEngine`'s opts (the comment already promises it);
  make `memoryGet` reject when `id === opts.getThrows`; add a test: ≥2 disk files, engine
  with `getThrows` set to the 2nd id, assert `computeMemoryDrift` REJECTS (propagates the
  mid-loop failure — never a falsely-clean `inSync`).

## §3 — Decomposition

- **MF.1** — reconcile post-sync drift check (memory_reconcile.ts + memory_reconcile.test.ts).
- **MF.2** — description-aware change detection (auto_memory_importer.ts + its test).
- **MF.3** — `getThrows` test seam + the memoryGet-rejection test (memory_drift.test.ts).

## §4 — Risks / invariants

- MF.1 must NOT change the fail-open contract: the drift check is inside the existing
  try/finally; a thrown drift check is caught → loud stderr, session-end never blocked.
  It must also not double-close the engine (the check runs before the `finally` close).
- MF.2 must keep the body-change path working (existing tests) and only ADD the
  description-change trigger; the `memoryUpdate` already writes `description`.
- MF.3 is test-only (a stronger fail-loud proof); no production behavior change.
- All three are opensquid-only; loop-engine (H4's safety) is untouched.
