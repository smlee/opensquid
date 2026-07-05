# Findings report — full drift-free audit of this session's v2 changes (loop-driven)

Track: `T-drift-audit-loop` · Work-item: `wg-5877a33450be` · Date: 2026-07-04 · Stage: AUTHOR (deliverable)
Method: per-target, evidence-first DRIFT/CLEAN classification against the 5-criterion rubric captured in
`docs/research/T-drift-audit-loop-pre-research-2026-07-04.md` (design-match · simplicity · no-invention ·
blast-radius · tested), each verdict WITH `file:line` evidence. Read-only — no audited surface was edited or
committed.

Driven by the ralph loop via three fan-out reviewer subagents (one re-anchoring pass per target group), then
the load-bearing dead-code / gate-removal claims were independently re-verified before this synthesis.

## Verdict table

| # | Target | Verdict |
|---|--------|---------|
| 1 | blast-radius re-deadlock (`discovery.ts` + `harness_graph_sync.ts`) | **DRIFT** |
| 2 | #16 prune cycle-gating (`session_end_prune_gate.ts` / `session-end.ts`) | **CLEAN** |
| 3 | accessibility lens `serves:` (`accessibility/skill.yaml`) | **DRIFT** |
| 4 | stale `depth≥3` evidence line (`v2_supply.ts`) | **CLEAN** (label removal) — audit premise corrected |
| 5 | `THE_3X_100`→`THE_4X_100` rename (`stage_context.ts`) | **CLEAN** |
| 6 | #26 workgraph↔harness sync (`harness_map/sync/graph_sync.ts`) | **DRIFT** |
| 7 | orchestrator-guard opt-in (`bootstrap.ts` + `pre-tool-use.ts`) | **CLEAN** |

Plus a **meta-finding (M1)** surfaced by the audit: the AUTHOR gate's repo-global `manifest_complete` facet is
currently RED (77 uncovered gated exports), several of which ARE the audit-target symbols — see §M1.

---

## Target 1 — blast-radius re-deadlock — **DRIFT**

The ask conflated two concerns; audited separately. Concern (b) is CLEAN; concern (a) drives the DRIFT.

### 1(a) deadlock guard `hasActiveProjectPacks` — DRIFT (orphaned dead code + stale doc)

- `hasActiveProjectPacks` (`src/packs/discovery.ts:355`, empty-`packs[]`→`false` at `:360`) has **zero
  production callers**: `grep -rn hasActiveProjectPacks src --include=*.ts` (excl. its own def + tests) returns
  only a comment at `src/runtime/bootstrap.ts:534` stating it was *replaced* by the finer predicate.
- The orchestrator guard actually resolves via **`projectDeclaresOrchestratorOnly`**
  (`src/runtime/bootstrap.ts:543`), called at `src/runtime/hooks/pre-tool-use.ts:268` behind the
  `OPENSQUID_AUTOMATION==='1'` gate. The deadlock IS prevented — by `bootstrap.ts:545`
  (`projectRoot === null → false`), NOT by the audited empty-packs branch.
- Failing criteria: **#1 design-match** (the pre-research's own anchor "consumed by the guard at
  `pre-tool-use.ts:248`" is stale — the guard moved) and **#2 simplicity** (`hasActiveProjectPacks` + its
  ~8-case test block in `src/packs/discovery.test.ts` are leftover dead code after the guard upgrade). The
  doc-comment at `discovery.ts:352` still claims "the GS1 orchestrator guard consults it directly" — false now.
- Blast-radius / no-invention: PASS (pure fail-open read). Tested: `discovery.test.ts:659` still asserts the
  return value but, the fn being unwired, no longer proves deadlock-prevention end-to-end.
- **Impact: harmless functionally** (deadlock still prevented via `projectDeclaresOrchestratorOnly`); the
  audited mechanism is orphaned. Remediation: delete `hasActiveProjectPacks` + its test block + the stale doc,
  or re-wire it (the finer predicate is the correct end state, so deletion is simplest).

### 1(b) blast-radius gate `isTaskTick` — CLEAN

`src/runtime/hooks/harness_graph_sync.ts:129` (`if (!isTaskTick(tool)) return null`) fires before any I/O;
`isTaskTick` (`:40`) admits only TaskCreate/TaskUpdate. All 5 criteria hold: matches #26
(`~/projects/loop/docs/reports/v2-scope-clarifications-2026-07-01.md:185`), one guard clause, double fail-open
(`:138-140` + `pre-tool-use.ts:179`), tested (`harness_graph_sync.test.ts:39` non-task never reads;
`:51` both Task* ticks fire).

## Target 2 — #16 prune cycle-gating — **CLEAN**

All 5 criteria hold with evidence:
- **Design-match**: predicate is exactly "cycle complete AND committed" — `session_end_prune_gate.ts:91`
  (`openWorkCount(cwd) !== 0 → false`, cycle not complete) then `:92` (`gitClean(cwd)`), matching the corrected
  #16 (`v2-scope-clarifications-2026-07-01.md:140`, "activates only when the cwd project's work-graph cycle is
  complete AND committed").
- **Simplicity**: 2-line short-circuit predicate + thin `sweepRetiredIfAllowed` seam; reuses the shipped
  `workGraphStore` + `git status --porcelain` (no new store).
- **No-invention**: namespace/actor resolution mirrors the server chain; `notifyRetentionSweep` is the
  separately-landed sibling.
- **Blast-radius**: genuinely **fail-closed on the decision** (`:93-94` bare `catch { return false }`),
  independently fail-open on the hook (`session-end.ts:194-196`); restore stays unconditional, only the
  destructive sweep is gated (`session-end.ts:183-184`).
- **Tested**: `session_end_prune_gate.test.ts:24-67` — full truth table + both throw paths + git short-circuit;
  gate-consulted-before-sweep proven (only `sweepRetiredIfAllowed` reaches `backend.sweepRetired`).

## Target 3 — accessibility lens `serves:` — **DRIFT**

Definitive judgment: the design table's `coding.frontend` grouping is the true target; the shipped tag drifted
to the cross-cutting `coding` domain.

- Shipped: `packs/builtin/fullstack-flow/skills/accessibility/skill.yaml:13-17` —
  `serves: [{domain: coding, intent: produce}, {domain: coding, intent: decide}]`.
- Design: `~/projects/loop/docs/design/pack-taxonomy.md:138` groups `accessibility` under the
  `coding.frontend | lens (gated)` frontend lenses (with `motion`, `visual-design`, `design-tokens`, …).
- **Peer frontend lenses honor the table**: `motion`, `visual-design`, `ux-heuristics`, `design-tokens` each
  declare bare `serves: { domain: coding.frontend }`. Accessibility is the lone table-frontend lens tagged
  `coding`.
- **The matcher supports the granularity** — so this is a per-lens mistag, not a platform limitation:
  `src/packs/skill_serves.ts:37-50` resolves `domain` hierarchically via `contains()` (a `coding.frontend` lens
  fires only on `coding.frontend` turns; a `coding` lens fires on any `coding.*` turn).
- **Behavioral divergence**: under the shipped tag, the a11y lens fires on pure `coding.backend`
  produce/decide turns (e.g. a Rust API handler) where it is noise — an unintended blast-radius expansion.
- Failing criteria: **#1 design-match** (tagged `coding`, design says `coding.frontend`) and **#4 blast-radius**
  (fires on backend turns). #3 no-invention: PASS. Tested: PASS at the matcher level
  (`skill_serves.test.ts`) but **no test pins accessibility to `coding.frontend`**, so the mistag is untested
  against the design.
- Note: prior research (`docs/research/pa-b-lens-gating-pre-research-2026-07-04.md:65-67`) logged this as
  "observed, non-blocking" — but that framing measured against the "tag the 18 lenses" checklist element, not
  against the governing design table's node assignment. Measuring against the touched slice rather than the
  design IS the drift. Remediation: retag to `domain: coding.frontend` (+ optional intent), matching peers.

## Target 4 — stale `depth≥3` evidence line — **CLEAN** (label removal); audit premise corrected

The label-removal refactor is CLEAN:
- Module header `src/runtime/loop/v2_supply.ts:59-68` documents the deleted per-stage switch, replaced by the
  generic pack-declared `stageEvidence()` renderer (`:71`).
- The only surviving `depth 4≥3` literal is a pure-renderer test fixture (`stage_report.test.ts:107,113`) —
  harmless; it does not depend on the deleted switch. **No live code reads the deleted label** (verified).
- 5 criteria PASS for the change: generic render matches the "core carries ZERO stage vocabulary" design; one
  map replaces a five-arm switch; reuses the `reads:`/`EvidenceRef` primitive; render deletion is
  blast-bounded; tested (`stage_report.test.ts:98-113`).

**Material premise correction (reported faithfully, not rubber-stamped):** the pre-research's audit obligation
— "verify the `depth ≥ 3` bar is STILL ENFORCED by the SCOPE gate" — is **false for the live pack**. The live
`scope_ready` gate carries **no depth term** (`packs/builtin/fullstack-flow/pack.yaml:66`), and `:65` states
explicitly: *"GS1: `depth >= 3` removed — research depth is human-paced guidance (procedure), not a
machine-enforced gate."* The `scope.depth >= 3` assertion at `v2_supply.test.ts:489` is a **synthetic** test
pack, not the live gate; `scope_dwell.ts:8-9` keeps depth only as a soft dwell-nudge. Minor loose end:
`v2_supply.ts:263` still sets `scope.depth` into ctx but no live gate/evidence expression consumes it — a dead
ctx write left by the GS1 gate removal (a simplicity nit, not a functional defect).

## Target 5 — `THE_3X_100`→`THE_4X_100` rename — **CLEAN**

- Old name fully gone: `grep -rn "THE_3X_100" src packs` → **zero matches** (verified).
- `THE_4X_100` defined `src/functions/stage_context.ts:140`, four rungs at `:142-151`
  (EVIDENCE / COVERAGE / CONFIDENCE / BEST-SOLUTION), consumed in the stage bundle `:176-177`.
- 5 criteria: design-match (rung 4 BEST-SOLUTION mirrors `rubric/scope.md:33-35`), simplicity (pure `const`
  array), no-invention (extends the prepend-to-bundle pattern paired with `PROCEDURE_INTEGRITY`), blast-radius
  (single call site, no dangling old refs), tested (justified absence — static instructional prompt text with
  no runtime branching; the gate-enforced rungs are tested via their gates).

## Target 6 — #26 workgraph↔harness sync — **DRIFT**

The core mechanism is exemplary; one dead exported API with a false doc-claim drives the DRIFT.

- **CLEAN core**: `harness_map.ts` monotonic overlay (`bind` uses `ON CONFLICT … DO NOTHING`, `:52`; tested
  `harness_map.test.ts:35` "MONOTONIC + idempotent — a re-bind never re-points"); `syncHarnessToWorkgraph`
  (`harness_sync.ts:91`) pure + total (unknown-status skip `:106`, vanished-issue skip `:124`, monotonic-closed
  `:126-132`); the outbound nudge fires ONLY on stale-open drift (a closed wg issue meeting an open task,
  `:130`); the impure shell `runHarnessGraphSync` (`harness_graph_sync.ts:121`) is `isTaskTick`-gated + fail-open.
  Fully tested (`harness_sync.test.ts:101-160`, `harness_graph_sync.test.ts:38-83`).
- **RALPH.md note CONFIRMED**: `RALPH_MD` (`src/runtime/ralph/ralph_template.ts:18`) carries no #26 text; the
  real "outbound" is the `additionalContext` write-back nudge (`pre-tool-use.ts:353-354`), NOT a RALPH.md edit.
- **DRIFT finding**: `isHarnessOwnedBody` (`harness_sync.ts:62`) has **zero consumers** (`grep` returns only its
  def + a self-referential doc comment at `:56`). Its header claims *"The ralph loop uses this to drive the
  SYNCED task-list mirror items first"* — **that consumer does not exist**; the provenance stamp is written
  (`:67`) but never read back. Failing criteria: **#2 simplicity** (exported dead code / speculative
  generality), **#3 no-invention** (an exported read-side API documenting an unbuilt ralph consumer = scope the
  design did not deliver), **#5 tested** (the read path + "drive-synced-first" behavior are untested +
  unimplemented). Remediation: delete the read-side API + provenance-read doc-claim, or build the ralph
  consumer it promises.
- **Secondary (defensible) deviation**: the resolved #26 answer
  (`v2-scope-clarifications-2026-07-01.md:194`) named the kanban STORY schema (`src/kanban/story.ts`) as the
  single source; the impl instead builds a dedicated `harness_map.db` overlay (modeled on
  `src/kanban/map_store.ts`, never references `story.ts`). Authorized by the settled scope's "durable
  id-mapping" and mechanically sounder (a derived story can't hold a durable binding), but a literal deviation
  from the user's stated answer — noted, not counted as DRIFT.

## Target 7 — orchestrator-guard opt-in — **CLEAN**

Ask-naming note: `discovery.ts readOrchestratorOnly` does not exist; the real resolver is
`projectDeclaresOrchestratorOnly` (`src/runtime/bootstrap.ts:543`) — imprecision in the ask, not code drift.

All 5 criteria hold:
- **Design-match**: guard is a project-selected pack discipline — activation reads
  `loaded.pack.discipline?.orchestrator_only === true` (`bootstrap.ts:549`), declared by
  `packs/builtin/fullstack-flow/pack.yaml:45`; fires only under `OPENSQUID_AUTOMATION==='1'`
  (`pre-tool-use.ts:268`), matching the env-only automation-binding
  (`~/projects/loop/docs/design/opensquid-project-only-operation.md:95-96`).
- **Simplicity**: single guard condition; pure deny-list default-allow guard (`orchestrator_guard.ts:36,81-89`).
- **No-invention**: schema field pre-exists with default OFF (`pack_v2.ts:175`
  `orchestrator_only: z.boolean().default(false)`); automation gate mirrors the existing v2-enforce cartridge gate.
- **Blast-radius**: fails OPEN (`pre-tool-use.ts:267,279-281`); OFF by default (schema `false` + pack-less/
  content project resolves `false` at `bootstrap.ts:545` — the content/SEO-project misfire fix); executor
  exemption preserved (`orchestrator_guard.ts:119-120`); safety floor untouched.
- **Tested**: unit `orchestrator_guard.test.ts:13-147`; integration `hooks.integration.test.ts:269-288`
  (automation → deny) and `:289+` (INTERACTIVE, no env → ALLOWED), proving no interactive misfire.

---

## M1 — meta-finding: the AUTHOR gate is repo-globally RED (`manifest_complete` = false)

Surfaced while completing this AUTHOR-stage lap. The v2 AUTHOR gate
(`packs/builtin/fullstack-flow/pack.yaml:89`) requires
`author.manifest_complete && author.real_code && …`. `author.manifest_complete` is defined as
`report.orphans.length === 0` (`src/runtime/loop/author_coverage.js` header; computed by
`runCoverageReport` over `docs/ARCHITECTURE.md` vs the gated `src/`/`packs/` CodeIndex, filtered by
`docs/coverage-allowlist.txt`).

Running that exact checker over the current tree yields **77 orphan gated exports** (`manifest_complete: false`,
`real_code: true`). The orphans include **this session's own v2 additions**, several of which ARE audit-target
symbols: `hasActiveProjectPacks`, `projectDeclaresOrchestratorOnly` (targets 1/7), `resolveConfiguredChannel`,
`resolvePlatformChannel` (the #26-adjacent channel work), `skillServesDomainMatches`, `TaskCheckpoint`. All are
committed on `feat/v2-enforcement` (e.g. `resolvePlatformChannel` in `src/channels/routing.ts` at HEAD) and are
absent from both `docs/ARCHITECTURE.md` and the 1958-line allowlist.

Root cause: the coverage CI (`src/runtime/coverage/ci.test.ts`) is **report-only** — it asserts only 4 seeded
requirement statuses, never `orphans.length === 0` — so the test suite stays green while orphans accumulate.
The branch has been developed via ralph subagent laps (hooks disabled by `OPENSQUID_SUBAGENT=1`), so the AUTHOR
gate has never live-fired to force reconciliation. The manifest simply drifted from the code.

This is genuine drift, but its remediation (reconcile the 77 exports into `docs/ARCHITECTURE.md` or the
allowlist) is a **separate task**, out of this read-only audit's scope, and is what currently blocks any task's
AUTHOR gate — including this one (see §Stage outcome).

---

## Stage outcome (honest gate status)

The deliverable — this findings report classifying all seven targets with `file:line` evidence — is **complete**
and read-only (no audited surface edited/committed). But the AUTHOR gate cannot honestly be advanced this lap:
of `author_ready`'s conjuncts, `author.real_code` is true, `audit.plan` is cached GUESS_FREE, and
`external_needed` is false — but **`author.manifest_complete` is false** (§M1), a repo-global precondition this
read-only task must not fix. Applying `upsertTaskStage(wg,'code',…)` would route around a genuinely-unsatisfied
gate, which the discipline forbids. A fresh AUTHOR lap on this item would hit the same 77 orphans. The item is
therefore parked for a human to (a) reconcile the coverage manifest, (b) accept this report and close the item,
or (c) exempt audit-only tasks from `manifest_complete`.

## Open questions

None on the seven targets — every verdict is cited to `file:line` in the current tree or a governing-design doc.
The one policy question (M1: how to unblock the AUTHOR gate given committed coverage-manifest drift) is a human
decision, surfaced above.
