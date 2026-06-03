# Track T-FSM-UNIFY — one behavior-pattern FSM (coding-flow becomes FSM-driven)

**Status:** scoping / spec-documentation (this doc IS the spec — every detail
filled so implementation has no holes to guess at). Supersedes the `scope-fsm` +
`workflow-fsm` split and upgrades the `coding-flow` track (`loop/docs/tasks/T-coding-flow-pack.md`)
to be FSM-driven. Pre-research/surface-map: agent run 2026-06-03 (mapped below).

---

## 0. The realization (why this exists)

Three artifacts encode the SAME coding lifecycle (research → spec → tasks → 7-phase):

| Implementation              | Where                                                                        | Form                                     | Built                         |
| --------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------- |
| Skill-gate discipline       | `scope-architect` (9 skills) + `default-discipline/{workflow,phase-logging}` | hand-written detect→verdict skills       | pre-2026-06-01                |
| `coding-flow` consolidation | `loop/docs/tasks/T-coding-flow-pack.md` (CF.1–CF.6)                          | re-home those skills into one guard pack | designed 2026-06-01 (pre-FSM) |
| FSM substrate               | `scope-fsm` + `workflow-fsm`                                                 | `fsm.yaml` + state-driven guards         | this session (2026-06-02/03)  |

These are not three things — they are one discipline implemented three times. The
governing principle (`docs/lexicon.md`, [[feedback-simple-logical-solutions]]:
**no-implicit-state — every lifecycle is an explicit total-transition FSM**) makes
the FSM the canonical substrate. Therefore:

> **`coding-flow` is the single FSM-driven pack.** Its `fsm.yaml` is the union
> lifecycle; its guards read/advance that state via `read_fsm_state`/`advance_fsm`
> instead of re-deriving stage from file-existence or scattered state keys.
> `scope-fsm` and `workflow-fsm` are absorbed into it and retired. Task-type is a
> **region** of the one machine, not a separate machine.

This reconciles CF's locked decisions (L1 one builtin pack; L2 extend-the-artifact-
contract; L3 retire recall-consumed) WITH the pack-FSM stack — they stop being two
plans.

### 0.1 The canonical flow (the backbone — three peer stages, each handed off)

The original, user-authored flow (= the coding-flow doc's "3 stages"):

```
SCOPE ──handoff──▶ TASK AUTHORING ──handoff──▶ CODE (the 7 layers)
```

Each stage is structurally identical — **entry handoff → persona → content gate →
exit handoff** — and that uniformity is the design. A stage marker WITHOUT a content
gate is implicit state (a checkbox), which is the bug that "lost" task authoring this
session (only its persona + handoff survived; its gate was dropped).

| Stage               | Persona (handed off to) | States                                         | **Content gate**                                                                              | Hands off to   |
| ------------------- | ----------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------- |
| **SCOPE**           | researcher              | `scoping → researching → researched`           | guess-audit (no unresolved guesses) + 3 sections                                              | task authoring |
| **TASK AUTHORING**  | `task-spec-author`      | `spec_authored → spec_complete → tasks_loaded` | **spec-audit (all 11 fields + real code)**                                                    | code           |
| **CODE (7 layers)** | executor                | `phases_in_flight → phases_complete`           | phase-log + the 7 phases (pre-research→learn→code→test→audit→post-research→fix) before commit | done           |

The handoffs are the `handoffs` guard's `directive` verdicts (the connective tissue:
"SCOPE done → now author the spec"; "AUTHOR done → now write code"). Personas remain
distinct (you embody the researcher, then the spec-author, then the executor).

### 0.2 Domain is a PROFILE, not the FSM's identity (avoid re-task-scoping)

Per the same principle that motivates this track: the FSM lifecycle above is
**domain-general** (it's the shape of any deliberate problem-solving). "Coding" is the
first **profile** over it — which path-predicates the code-gate blocks
(`src/∪packs/∪test/`) and which audits run. The pack is activated as `coding-flow`
(the user's framing) but its `fsm.yaml` is the general behavior substrate; a future
`writing-flow`/`research-flow` is another profile over the SAME machine, not a copy.
This keeps "task-type as region" true all the way up — we do NOT bake "coding" into the
FSM, only into the gate profile.

### Why FSMs were task-scoped (the root cause being fixed)

The engine (`src/runtime/fsm.ts`) is fully general — states + total transitions,
zero knowledge of "tasks." `scope-fsm`/`workflow-fsm` got scoped to a task-type
only because each was built reactively to plug one enforcement gap. That accretion
is what produced the duplication (both carry the `scoping→researched` spine + the
`guess_found` loop-back). The fix is to model the **behavioral pattern** once and
let task-types select regions. This is the n=2→consolidation move; B2 flow-
templates stay deferred (the generality lives in one composable machine, not a
code-gen layer — see `T-fsm-completion.md` FC.2).

---

## 1. The union FSM (full design — every state + transition + decision)

### 1.1 States (9) and the region partition

```
idle ─▶┌──────── SCOPE region ────────┐  ┌──────── AUTHOR region ────────┐  ┌─ EXECUTE region ─┐
        scoping ⇄ researching ─▶ researched ─▶ spec_authored ⇄ (spec-audit) ─▶ spec_complete ─▶ tasks_loaded ─▶ phases_in_flight ─▶ phases_complete
        └ guess-audit loop-back ┘            └─ spec-audit loop-back ─┘
```

- **SCOPE** = `{scoping, researching, researched}` — research discipline; the
  **guess-audit** loop-back (`researched → guess_found → researching`) lives here.
  `researched` = SCOPE-complete.
- **AUTHOR** = `{spec_authored, spec_complete, tasks_loaded}` — task authoring. The
  **spec-audit** loop-back (`spec_authored` stays until the 11-field + real-code audit
  passes → `spec_complete`) is the SYMMETRIC TWIN of the guess-audit — this is the gate
  that was missing. `spec_complete` = AUTHOR-complete; only then can `tasks_loaded` fire.
- **EXECUTE** = `{phases_in_flight, phases_complete}` — per-task 7-phase; phase-logged-
  before-commit gate.
- `idle` is the pre-entry state. Each region has a CONTENT gate (not just a presence
  marker): SCOPE→guess-audit, AUTHOR→spec-audit, EXECUTE→phase-log.

### 1.2 Transitions (union of both machines, deduped — total)

| #   | from             | on            | to               | source                                | note                                                                |
| --- | ---------------- | ------------- | ---------------- | ------------------------------------- | ------------------------------------------------------------------- |
| 1   | idle             | scope_start   | scoping          | workflow-fsm:13                       | scope-intent prompt                                                 |
| 2   | idle             | research_done | researched       | workflow-fsm:14                       | robustness: pre-research write w/o a scope prompt                   |
| 3   | scoping          | research_done | researched       | both (scope-fsm:10 ≡ workflow-fsm:15) | the shared edge                                                     |
| 4   | researching      | research_done | researched       | scope-fsm:11                          | re-research after a failed audit                                    |
| 5   | researched       | guess_found   | researching      | scope-fsm:12                          | **keep scope-fsm's target** (richer than workflow-fsm's `→scoping`) |
| 6   | researched       | spec_drafted  | spec_authored    | workflow-fsm:17 (renamed event)       | a `T-*.md` written → enter AUTHOR (unverified)                      |
| 7   | spec_authored    | spec_verified | spec_complete    | **NEW (spec-audit)**                  | the 11-field + real-code audit passed                               |
| 8   | spec_complete    | tasks_loaded  | tasks_loaded     | workflow-fsm:18                       | TaskCreate w/ provenance, only when AUTHOR-complete                 |
| 9   | tasks_loaded     | phase_started | phases_in_flight | workflow-fsm:19                       | enter EXECUTE                                                       |
| 10  | phases_in_flight | phases_done   | phases_complete  | workflow-fsm:20                       |                                                                     |

Note transition 7 is the AUTHOR content gate: `spec_authored` is a STAY state until
the spec-audit fires `spec_verified` (mirrors `researched`/guess-audit). A failed audit
is simply no `spec_verified` event → the machine stays at `spec_authored` and
`taskcreate-spec-required` keeps blocking (no separate loop-back state needed; the stay
IS the loop, kept total by `validateFsm`).

**states (9):** `idle, scoping, researching, researched, spec_authored, spec_complete,
tasks_loaded, phases_in_flight, phases_complete`. **initial:** `idle`. Totality is
enforced by the existing `validateFsm` (`src/runtime/fsm.ts`) on the merged machine — a
non-matching event is an explicit stay, never a crash.

### 1.3 Design decisions (the holes, filled)

- **D1 — drop `building` + the `build` event.** Dead in both packs: NO skill fires
  `build` (surface-map §1). `scope-fsm`'s gate only kept `building` so its allow-set
  clause (`st != "building"`) had a defined target. Replaced by D4's region-based
  allow-set. (If a future "post-merge done" terminal is wanted, it's `phases_complete`.)
- **D2 — keep `researching` distinct from `scoping`.** `scope-fsm` separates initial
  scoping from re-research-after-audit; `workflow-fsm` collapsed them. Keep both so
  the loop-back target carries meaning (you came back because of a guess, not a fresh
  start). Transition #5 → `researching`, #4 re-advances. Strictly richer; loses no edge.
- **D3 — `guess_found` target = `researching`** (not `scoping`). Both old targets
  reach `researched` via a `research_done`; `researching` is the more precise state.
- **D4 — the code-gate allow-set is region-based, not a state enumeration.** Old:
  `st != "researched" && st != "building"`. New: block code while `state` is in the
  SCOPE-incomplete set, i.e. allow when `state` ∈ {researched, spec_authored,
  tasks_loaded, phases_in_flight, phases_complete} (SCOPE region passed). Expressed
  with the frozen `if:` allow-list as a disjunction or a `contains` over an allowed-
  states binding (see §2.1).
- **D5 — initial `idle`, not `scoping`.** Adopt workflow-fsm's `idle` so a session
  that never scopes anything sits inert (no false "you're mid-scope" state). scope-
  fsm's `scoping`-initial was a simplification that the gate worked around.
- **D7 — AUTHOR gets a content gate symmetric to SCOPE (the missing piece).** Neither
  old machine verified task-authoring QUALITY — `workflow-fsm` fired `spec_authored` on
  any `T-*.md` write and `tasks_loaded` on any TaskCreate-with-`metadata.spec`;
  `taskcreate-spec-required` only checked the spec FILE _exists_. Add `spec_complete` +
  the `spec-audit` (a `reasoning`-model adversarial check that EVERY task block carries
  all 11 fields AND real code, not pseudocode — task-spec-author's own "refuse to land
  if any field missing/pseudocode-only" contract, wired into the FSM). `tasks_loaded`
  can fire only from `spec_complete`. Each region now has a content gate: SCOPE→guess-
  audit, AUTHOR→spec-audit, EXECUTE→phase-log. This is the no-implicit-state principle
  applied evenly — a stage marker without a quality gate is implicit state. (This was
  the gap that let under-authored specs through this session.)

### 1.4 Task-type as REGION (the mechanism — the key conceptual hole)

One FSM; a task-type is a **required-region profile** the guards consult — NOT a
separate machine and NOT new FSM states. A small frozen table:

```ts
// track profiles: which regions a given entry-intent must traverse.
// Consumed by the guards (read-only); does not change the FSM.
const TRACK_PROFILES = {
  feature: ['SCOPE', 'AUTHOR', 'EXECUTE'], // full track (a new capability)
  fix: ['SCOPE', 'EXECUTE'], // research + 7-phase, no task decomposition
  doc: ['SCOPE', 'EXECUTE'], // same shape; audit phase = "render/observe"
  trivial: ['EXECUTE'], // already scoped; mechanical edit
} as const;
```

- The entry guard (`scope-detect`) classifies intent → records `track_type` in
  session state (`write_state{key: 'coding-flow-track', value: <type>}`).
- Each region-guard fires ONLY when its region is in the active profile:
  - code-gate (`scope-before-code`) requires SCOPE-complete for EVERY profile (code
    always needs research) — so it is profile-independent in practice.
  - task-gate (`taskcreate-spec-required`) requires AUTHOR — fires only when the
    profile includes AUTHOR (a `fix`/`doc` that creates no tasks never hits it).
  - commit-gate (phase-logged-before-commit) requires EXECUTE — universal.
- Default profile when unclassified = `feature` (strictest — safest default).

This is the literal expression of "task-type is a region": the same total machine,
the guards parameterised by a per-track region set. It also future-proofs the
non-coding variant (a different profile table, same FSM) without B2 templates.

---

## 2. The guards (FSM-state-driven) + guard harness

Each CF guard is reconceived to READ/ADVANCE the one FSM rather than re-derive
stage. The guard harness (event→guard binding) is unchanged in shape from CF.6.

### 2.1 Guard catalog (the full set the pack ships)

| Guard                                        | Harness event                                             | Reads/advances                                                                                                                                            | Verdict       | Replaces                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `enter-scoping`                              | `prompt_submit`                                           | `advance_fsm{scope_start}` + classify+`write_state` track_type                                                                                            | —             | workflow-fsm/enter-scoping + scope-architect/scope-detect                                                                              |
| `advance-on-research`                        | `tool_call` (Write/Edit `docs/research/…-pre-research-…`) | `advance_fsm{research_done}` + `write_state` artifact path                                                                                                | —             | scope-fsm/advance-on-research-doc **merged with** workflow-fsm/advance-research-done (surface-map §2 duplicate)                        |
| `guess-audit`                                | `tool_call` (same pre-research write)                     | `subagent_call{model: reasoning}` → `advance_fsm{guess_found}` if not GUESS_FREE                                                                          | warn          | scope-fsm/guess-audit (unchanged)                                                                                                      |
| `scope-complete`                             | `tool_call` (artifact read / pre-author)                  | `read_fsm_state` + 3-section check (CF.2)                                                                                                                 | block         | CF.2 keystone — now gates on FSM ≥ researched AND the 3 sections                                                                       |
| `scope-before-code`                          | `tool_call` (Write/Edit `src/`∪`packs/`∪`test/`)          | `read_fsm_state` → block if SCOPE-incomplete (D4)                                                                                                         | block         | scope-fsm/research-before-code + scope-architect/scope-before-code (one gate now)                                                      |
| `advance-on-spec`                            | `tool_call` (Write `docs/tasks/T-*.md`)                   | `advance_fsm{spec_authored}` + `write_state` spec path                                                                                                    | —             | workflow-fsm/advance-spec-authored                                                                                                     |
| `spec-audit`                                 | `tool_call` (same `docs/tasks/T-*.md` write)              | `subagent_call{model: reasoning}` adversarial 11-field + real-code check → `advance_fsm{spec_incomplete}` (loop-back to `spec_authoring`) if not COMPLETE | warn          | **NEW — the AUTHOR twin of `guess-audit`; nothing today does this**                                                                    |
| `spec-complete` / `taskcreate-spec-required` | `tool_call` (`TaskCreate`)                                | `read_fsm_state` → block if state ≠ `spec_complete` (i.e. spec-audit not passed); on success `advance_fsm{tasks_loaded}`                                  | block         | scope-architect/taskcreate-spec-required (presence-only) **upgraded to content-complete** + workflow-fsm/advance-tasks-loaded (merged) |
| `phase-advance`                              | `post_tool_call` (`log_phase`)                            | `advance_fsm{phase_started                                                                                                                                | phases_done}` | —                                                                                                                                      | workflow-fsm/advance-on-phase-log |
| `phase-logged-before-commit`                 | `tool_call` (`git commit`)                                | `read_fsm_state` + `workflow_phases_complete` → block                                                                                                     | block         | default-discipline/workflow (the commit gate)                                                                                          |
| `handoffs`                                   | `prompt_submit`                                           | `read_fsm_state` → `directive` (next persona)                                                                                                             | directive     | workflow-fsm/handoffs                                                                                                                  |

Notes:

- **Merges** (one per pack doing the same job, surface-map §2): research-advance
  (scope-fsm ∪ workflow-fsm) → ONE `advance-on-research` using the stricter
  `-pre-research-` predicate + the `write_state` side-effect; the two read the same
  state file post-merge instead of two `fsm-*.json` files.
- `scope-complete` (CF.2) is the keystone: it now reads `read_fsm_state` (must be ≥
  `researched`) AND greps the 3 required sections (`## Alternatives`, `## Failure
modes`, `## Empirical spikes`). The FSM advance to `researched` and the
  section-completeness become ONE coherent "SCOPE done" predicate.

### 2.2 The code-gate `if:` (D4, concrete, frozen-allow-list-safe)

```yaml
# scope-before-code — block code while SCOPE region incomplete.
process:
  - call: tool_name
    as: tool
  - call: tool_args
    as: targs
  - call: read_fsm_state # own pack's FSM
    as: st
  - call: verdict
    if: >-
      (tool == "Write" || tool == "Edit") &&
      (contains(targs.file_path, "src/") || contains(targs.file_path, "packs/") || contains(targs.file_path, "test/")) &&
      st != "researched" && st != "spec_authored" && st != "spec_complete" &&
      st != "tasks_loaded" && st != "phases_in_flight" && st != "phases_complete"
    args:
      level: block
      message: >-
        BLOCKED: research before code. SCOPE region incomplete (state={{st}}).
        Complete the pre-research artifact (docs/research/…-pre-research-…) with the
        three sections (Alternatives / Failure modes / Empirical spikes) first.
```

(Disjunction over the SCOPE-complete states keeps it within the frozen 5-fn
allow-list — no new evaluator surface. A future `in(x, [..])` helper could compress
this, but is NOT required and is out of scope.)

---

## 3. Migration surface (EXHAUSTIVE — from the surface-map; nothing silently breaks)

Every literal that must be re-pointed from `scope-fsm`/`workflow-fsm` to
`coding-flow` (the single missed reference = a silently-absent gate):

### 3.1 The enforcement-critical re-points (miss one → gate stops firing)

- `packs/builtin/pack-architect/skills/pack-scope-elicit/skill.yaml:33` —
  `read_fsm_state{pack: workflow-fsm}` → `{pack: coding-flow}`. (A bad `pack:`
  returns `null`, mis-firing the `null=="idle"` clause at :36.)
- `/Users/slee/projects/loop/.opensquid/active.json` — `["scope-fsm","workflow-fsm"]`
  → `["coding-flow"]`.
- `/Users/slee/projects/opensquid/.opensquid/active.json` — same.
- `src/runtime/hooks/session-end.ts:132` — `clearFsmState(sid, 'workflow-fsm')` →
  `'coding-flow'`. (Incidentally fixes the latent `scope-fsm`-never-cleared leak.)

### 3.2 State-file migration (D6)

- State lives at `<sess>/state/fsm-<packName>.json` (`fsm_state.ts:40-42`). Renaming
  orphans in-flight sessions → `readFsmState` ENOENT → falls back to `initial`
  (`fsm_state.ts:56-67`); a stored state string no longer in the union (`building`)
  self-heals to `initial` (:60). **Decision D6: accept the reset.** State is
  session-scoped, cross-session resume is already deferred (`session-end.ts:129`); a
  mid-cutover session simply re-scopes. No migration-copy code (Simplicity).

### 3.3 Tests to update (surface-map §5)

- `test/builtin/scope-fsm.test.ts` → becomes `coding-flow` FSM test (name, path,
  state set `[idle,scoping,researching,researched,spec_authored,tasks_loaded,
phases_in_flight,phases_complete]`, initial `idle`, merged rule ids).
- `test/builtin/scope-fsm-audit.test.ts` → name + loop-back target (`researching`).
- `test/builtin/workflow-fsm.test.ts` → name + path; full lifecycle unchanged in shape.
- `src/runtime/hooks/scope_fsm_guess_prevention.test.ts` → in-test pack name +
  inline FSM def (it uses a `researching` self-loop variant — align to D2/D3).
- `test/builtin/scope-architect.test.ts:32` — title-string only.
- `src/runtime/fsm.test.ts:7` — comment only.

### 3.4 Docs to update (surface-map §6)

- `docs/pack-fsm-architecture.md` — `workflow-fsm` is THE worked example (:76,80,98,
  113-119 the inline machine, :198-214 the walkthrough). Re-point to `coding-flow`
  as the worked example; update the inline states/transitions to the union + the
  `guess_found→researching` target.
- `docs/pack-runtime.md` — :246 (EWG.3.1 anecdote), :933-934 + :1042 + :1051 (the
  `fsm-workflow-fsm.json` path string) + :1056-1058 (cross-pack `pack: workflow-fsm`).
- Planning docs naming the old packs (`T-enforce-workflow-gates*`, `T-fsm-completion*`,
  `T-pack-runtime-doc-drift*`) — historical; add a one-line "superseded by T-fsm-unify"
  note rather than rewrite.

### 3.5 Pack-dir collateral (the merge itself)

- New `packs/builtin/coding-flow/` = manifest + `fsm.yaml` (union) + the §2.1 guard
  skills. Old `packs/builtin/scope-fsm/` + `packs/builtin/workflow-fsm/` removed AFTER
  behavioral-equivalence (CF.L5 / DPC.6 pattern: ship → verify live → delete; keep
  `.backup`). The CF track's skill re-homing (scope-architect + default-discipline/
  workflow,phase-logging) folds into the SAME pack so there is one home, not two.

---

## 4. Task blocks (11-field) — execution order

> Reconciliation note: these supersede/absorb CF.1–CF.6. Where a CF task already
> covered a piece (CF.2 the 3-section gate; CF.3 retire recall-consumed; CF.6 the
> harness map), it is referenced, not re-derived.

### Task FU.1: Author the union `fsm.yaml` + the `coding-flow` manifest (FSM backbone)

**Required skills:** YAML schema design expert (`yaml` npm package); opensquid pack loader expert; Architectural design expert; Audit / code review expert
**Deliverable:** `packs/builtin/coding-flow/{manifest.yaml,fsm.yaml}` exist; `fsm.yaml` is the §1.2 union machine; `loadPack` parses it and `validateFsm` confirms totality (9 states, 9 transitions, initial `idle`).
**Depends on:** None (new pack scaffold).

**Files affected:**

- `packs/builtin/coding-flow/manifest.yaml` (new) — name `coding-flow`, scope `workflow`, NO `detected_by` (opt-in IS the pin — the EWG.3.1 lesson, `pack-runtime.md` §1.4).
- `packs/builtin/coding-flow/fsm.yaml` (new) — §1.2 states + transitions.

**Key code shapes:**

```yaml
# packs/builtin/coding-flow/fsm.yaml
initial: idle
states:
  [
    idle,
    scoping,
    researching,
    researched,
    spec_authored,
    tasks_loaded,
    phases_in_flight,
    phases_complete,
  ]
transitions:
  - { from: idle, on: scope_start, to: scoping }
  - { from: idle, on: research_done, to: researched }
  - { from: scoping, on: research_done, to: researched }
  - { from: researching, on: research_done, to: researched }
  - { from: researched, on: guess_found, to: researching }
  - { from: researched, on: spec_authored, to: spec_authored }
  - { from: spec_authored, on: tasks_loaded, to: tasks_loaded }
  - { from: tasks_loaded, on: phase_started, to: phases_in_flight }
  - { from: phases_in_flight, on: phases_done, to: phases_complete }
```

**Test fixtures:**

- `loadPack('packs/builtin/coding-flow')` → `pack.fsm` defined; `validateFsm(pack.fsm)` returns `[]` (no errors).
- `step(fsm, 'researched', 'guess_found')` → `{next:'researching', transitioned:true}`.
- `step(fsm, 'researched', 'nonsense')` → `{next:'researched', transitioned:false}` (total/stay).

**Acceptance criteria:**

- [ ] `validateFsm` passes (total, all transition endpoints are declared states)
- [ ] initial `idle`; `building`/`build` absent (D1)
- [ ] `guess_found → researching` (D3); `researching → researched` present (D2)
- [ ] no `detected_by` block
- [ ] `pnpm typecheck && lint && format:check && build` green; PATCH bump; CHANGELOG

**Risk callouts:**

- Totality is on the MERGED machine — a transition whose `to` is a dropped state (`building`) fails `validateFsm` loudly. Good (catches D1 omissions).
- Do not set `detected_by: [user_pinned]` — it silently disables the pack (EWG.3.1).

**References:** `src/runtime/fsm.ts` (`Fsm`/`validateFsm`/`step`); `packs/builtin/{scope-fsm,workflow-fsm}/fsm.yaml` (the two sources); `docs/pack-fsm-architecture.md`.

**Verification commands:**

```bash
cd /Users/slee/projects/opensquid
node -e "import('./dist/packs/loader.js').then(m=>m.loadPack('packs/builtin/coding-flow')).then(p=>import('./dist/runtime/fsm.js').then(f=>console.log(f.validateFsm(p.fsm))))"
pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build
```

**7-phase steps:**

1. **pre-research:** Re-read both `fsm.yaml`; confirm the union table §1.2 loses no edge; confirm `validateFsm` totality rules.
2. **learn:** Lock D1–D5.
3. **code:** Write the manifest + `fsm.yaml`.
4. **test:** `coding-flow-fsm.test.ts` — validate + the 3 step fixtures.
5. **audit:** No dropped-state dangling endpoint; no `detected_by`; goal present.
6. **post-research:** Compare totality posture against `fsm.ts` step semantics.
7. **fix:** Apply.

### Task FU.2: Author the FSM-driven guards + merge the per-pack duplicates

**Required skills:** opensquid skill.yaml author expert; opensquid dispatcher/evaluator expert (frozen `if:` allow-list); Tool-sequence FSM design expert; Audit / code review expert
**Deliverable:** the §2.1 guard set lives under `coding-flow/skills/`, each reading/advancing the one FSM; the two research-advance rules are merged into one; the code-gate uses the D4 region allow-set; all behavior-equivalent to the retired skills.
**Depends on:** [FU.1](#task-fu1-author-the-union-fsmyaml--the-coding-flow-manifest-fsm-backbone)

**Files affected:**

- `packs/builtin/coding-flow/skills/{enter-scoping,advance-on-research,guess-audit,scope-before-code,advance-on-spec,taskcreate-spec-required,phase-advance,phase-logged-before-commit,handoffs}/skill.yaml` (new ×9)
- (CF.2 `scope-complete` 3-section gate authored in FU.4)

**Key code shapes:** see §2.2 (code-gate) + §2.1 (merge: stricter `-pre-research-`
predicate + `write_state` side-effect on the single research-advance rule).

**Test fixtures:**

- pre-`researched`: a `src/x.ts` Write → block; after a pre-research write advancing to `researched` → allowed.
- `TaskCreate` without `metadata.spec` while AUTHOR-incomplete → block.
- `log_phase` (incomplete) → state `phases_in_flight`; (complete) → `phases_complete`.
- a non-matching event → FSM stays (no spurious advance).

**Acceptance criteria:**

- [ ] every guard reads/advances `coding-flow`'s FSM (no chain_state, no file-existence stage derivation)
- [ ] the two research-advance rules are ONE rule
- [ ] code-gate blocks `src/∪packs/∪test/` pre-SCOPE for every track profile
- [ ] all `if:` expressions pass `parseExpression` (frozen allow-list)
- [ ] behavior parity with the retired scope-fsm/workflow-fsm skills (equivalence test)
- [ ] full suite green; PATCH bump; CHANGELOG

**Risk callouts:**

- The `guess-audit` `subagent_call` (model `reasoning`) runs synchronously in the PreToolUse hook — keep its `timeout_ms: 120000` (the EWG.1.1 bound).
- Merging the research-advance rules must preserve workflow-fsm's `write_state` of the artifact path (the `handoffs` guard reads it) — don't drop the side-effect.
- D4 allow-set is a disjunction; verify it parses (no `in()` helper exists).

**References:** §2; `packs/builtin/scope-fsm/skills/scope-lifecycle/skill.yaml`; `packs/builtin/workflow-fsm/skills/*`; `src/functions/fsm.ts` (primitive contracts).

**Verification commands:**

```bash
cd /Users/slee/projects/opensquid
pnpm vitest run test/builtin/coding-flow.test.ts
# gate smoke (fresh session blocks a src/ write pre-research):
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x/src/a.ts"},"session_id":"fu2-smoke"}' | opensquid-hook-pretooluse
pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build
```

**7-phase steps:**

1. **pre-research:** Re-read all 5 source skills (scope-lifecycle + 4 workflow-fsm); confirm the merge predicate + the `write_state` keys the handoffs guard depends on.
2. **learn:** Lock the §2.1 guard set + the D4 `if:`.
3. **code:** Author the 9 skills; merge the research-advance rule.
4. **test:** Per-guard fires/skips + the block-then-allow + the FSM-advance fixtures.
5. **audit:** No file-existence stage logic; `if:` allow-list clean; side-effects preserved.
6. **post-research:** Diff against the retired skills for behavior parity.
7. **fix:** Apply.

### Task FU.3: Region profiles (task-type → required regions)

**Required skills:** TypeScript discriminated union design expert; opensquid skill.yaml author expert; Architectural design expert
**Deliverable:** the §1.4 `TRACK_PROFILES` mechanism: `enter-scoping` classifies intent and `write_state`s a `track_type`; the AUTHOR-region guards (`taskcreate-spec-required`) consult it so a `fix`/`doc`/`trivial` track is not forced through task-authoring it doesn't need.
**Depends on:** [FU.2](#task-fu2-author-the-fsm-driven-guards--merge-the-per-pack-duplicates)

**Files affected:**

- `packs/builtin/coding-flow/skills/enter-scoping/skill.yaml` (modify) — classify + `write_state{key:'coding-flow-track'}`
- the AUTHOR-region guards (modify) — gate their fire on `read_state` of the track type
- `packs/builtin/coding-flow/PROFILES.md` (new) — the profile table as single source

**Key code shapes:** the §1.4 `TRACK_PROFILES` table + a `read_state` gate on each
region-guard (`if: 'contains(track.regions, "AUTHOR")'` style — confirm list-membership
expressibility in the allow-list; if not, store a flat `track_authors:bool` instead).

**Test fixtures:**

- a `feature` intent → AUTHOR guards active (TaskCreate gate fires).
- a `trivial` intent → AUTHOR guards skip; code-gate still requires SCOPE.
- unclassified → defaults to `feature` (strictest).

**Acceptance criteria:**

- [ ] track type recorded on entry; region-guards consult it
- [ ] `fix`/`doc`/`trivial` skip AUTHOR; SCOPE + EXECUTE always enforced
- [ ] default = `feature` when unclassified
- [ ] list/flag membership expressible in the frozen allow-list (or flattened)
- [ ] full suite green

**Risk callouts:**

- If list-membership isn't in the `if:` allow-list, flatten to booleans (`track_requires_author`) rather than add evaluator surface (Simplicity; mirror the D4 disjunction choice).
- Misclassification fail-safe = strictest profile (never under-gate).

**References:** §1.4; `src/functions/state.ts` (`read_state`/`write_state`); the frozen `if:` allow-list.

**Verification commands:**

```bash
cd /Users/slee/projects/opensquid
pnpm vitest run test/builtin/coding-flow.test.ts
pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build
```

**7-phase steps:** 1 pre-research: confirm allow-list list-membership; 2 learn: lock the table + flat-vs-list; 3 code: classify+write_state+consult; 4 test: the 3 profile fixtures; 5 audit: fail-safe strictest; 6 post-research: n/a; 7 fix.

### Task FU.4: The TWO content gates — SCOPE (scope-complete) + AUTHOR (spec-audit) — + retire recall-consumed

**Required skills:** scope-completeness-gate design expert; opensquid skill.yaml author expert; Tool-sequence FSM design expert; Audit / code review expert
**Deliverable:** BOTH region content gates exist and are symmetric. (a) `scope-complete`: gates SCOPE on `read_fsm_state ≥ researched` AND the three required sections (CF.2). (b) `spec-audit` (D7, the missing twin): on a `docs/tasks/T-*.md` write, a `reasoning`-model adversarial check that EVERY task block carries all 11 fields AND real code (not pseudocode) → advances `spec_authored → spec_complete` on pass, stays + `warn` on fail; `taskcreate-spec-required` blocks `tasks_loaded` until `spec_complete`. (c) `recall-consumed` retired (CF.3). Each region now has a content gate, not a presence marker.
**Depends on:** [FU.2](#task-fu2-author-the-fsm-driven-guards--merge-the-per-pack-duplicates)

**Files affected:** `coding-flow/skills/scope-complete/skill.yaml` (new, per CF.2 §134-173); `coding-flow/skills/spec-audit/skill.yaml` (new — mirrors `guess-audit`'s structure); `coding-flow/skills/taskcreate-spec-required/skill.yaml` (modify — gate on `st == spec_complete`); drop `recall-consumed` (CF.3); `CHANGELOG.md`.

**Key code shapes:**

```yaml
# spec-audit — the AUTHOR twin of guess-audit. On a docs/tasks/T-*.md write:
process:
  - call: tool_name
    as: tool
  - call: tool_args
    as: targs
  - call: subagent_call
    if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/tasks/T-")'
    args:
      model: reasoning
      timeout_ms: 120000
      prompt: >-
        You are an adversarial reviewer enforcing the 11-field task-spec contract.
        Begin EXACTLY with `VERDICT: SPEC_COMPLETE` only if EVERY task block has all 11
        fields (Required skills, Deliverable, Depends on, Files affected, Key code shapes,
        Test fixtures, Acceptance criteria, Risk callouts, References, Verification
        commands, 7-phase steps) AND every Key-code-shapes block is REAL code (not
        pseudocode) AND every 7-phase step names files/decisions. Otherwise
        `VERDICT: INCOMPLETE` + one bullet per missing/pseudocode field. SPEC:\n\n{{targs.content}}
    as: spec_audit
  - call: advance_fsm
    if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/tasks/T-") && contains(spec_audit, "VERDICT: SPEC_COMPLETE")'
    args: { event: spec_verified }
  - call: verdict
    if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/tasks/T-") && !contains(spec_audit, "VERDICT: SPEC_COMPLETE")'
    args:
      level: warn
      message: 'Task spec incomplete — stays at spec_authored (TaskCreate blocked) until all 11 fields + real code. Audit:\n\n{{spec_audit}}'
```

**Test fixtures:** all-3-sections + `researched` → scope passes; missing `## Empirical spikes` → block naming it; a full 11-field spec write → `spec_verified` → `spec_complete`; a pseudocode-only spec write → stays `spec_authored` + warn, and a subsequent TaskCreate → BLOCKED; `recall-consumed` absent.

**Acceptance criteria:** [ ] scope-complete = 3 sections + non-empty + FSM≥researched (CF.2 parity); [ ] spec-audit advances to `spec_complete` ONLY on a real 11-field spec; [ ] a pseudocode/thin spec stays `spec_authored` and TaskCreate is blocked; [ ] each region has a content gate (symmetry holds); [ ] `recall-consumed` absent, no dangling refs (CF.3); [ ] suite green.

**Risk callouts:** non-emptiness not just presence (CF.2 theater risk); the spec-audit `subagent_call` runs synchronously in PreToolUse — keep `timeout_ms: 120000` (EWG.1.1 bound, same as guess-audit); fail-CLOSED — no clear `SPEC_COMPLETE` verdict ⇒ treated as incomplete (stay), never advance on ambiguity; the gate must read `{{targs.content}}` (the spec text in the same write event) so it audits what's being written.

**References:** CF.2 + CF.3 in `loop/docs/tasks/T-coding-flow-pack.md`; `packs/builtin/scope-fsm/skills/scope-lifecycle/skill.yaml` guess-audit (the structural template); `packs/builtin/task-spec-author/{SKILL.md,team.yaml}` (the 11-field contract being enforced); `[[feedback-simple-logical-solutions]]`.

**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && grep -rn recall-consumed packs/ src/ docs/ || echo clean`.

**7-phase steps:** 1 pre-research: CF.2's `text_pattern_match` file-read surface + the guess-audit structure to mirror for spec-audit; 2 learn: lock both predicates + the 11-field verdict prompt; 3 code: author `scope-complete` + `spec-audit`, gate `taskcreate-spec-required` on `spec_complete`, remove `recall-consumed`; 4 test: scope fixtures + spec-complete/pseudocode-block fixtures + no-double-block; 5 audit: not theater, fail-closed, no dangling ref; 6 post-research: trade-study template (CF.2) + the task-spec-author contract; 7 fix.

### Task FU.5: Cut over — active.json + cross-refs + retire scope-fsm/workflow-fsm (behavioral-equivalence)

**Required skills:** opensquid pack loader expert; Claude Code hooks expert; opensquid pack-assembly/consolidation expert; Audit / code review expert
**Deliverable:** every §3 reference re-pointed to `coding-flow`; both `active.json`s opt into `coding-flow`; live equivalence confirmed (DPC.6/CF.L5); `scope-fsm` + `workflow-fsm` (and their `.backup`s) removed only after green.
**Depends on:** [FU.2](#task-fu2-author-the-fsm-driven-guards--merge-the-per-pack-duplicates), [FU.3](#task-fu3-region-profiles-task-type--required-regions), [FU.4](#task-fu4-fold-in-cf2-3-section-scope-gate--cf3-retire-recall-consumed-against-the-fsm)

**Files affected:** the §3.1 re-points (pack-architect skill, 2× active.json, session-end.ts); §3.3 tests; §3.4 docs; remove `packs/builtin/{scope-fsm,workflow-fsm}/` after equivalence.

**Key code shapes:**

```jsonc
// ~/projects/loop/.opensquid/active.json  AND  ~/projects/opensquid/.opensquid/active.json
{ "packs": ["coding-flow"] } // was ["scope-fsm", "workflow-fsm"]
```

```yaml
# packs/builtin/pack-architect/skills/pack-scope-elicit/skill.yaml:33 — re-point the cross-pack read
- call: read_fsm_state
  args: { pack: coding-flow } # was: workflow-fsm
  as: st
```

```ts
// src/runtime/hooks/session-end.ts:132 — re-point the state clear (also fixes the
// latent scope-fsm-never-cleared leak, since there is now one pack)
clearFsmState(sessionId, 'coding-flow'); // was 'workflow-fsm'
```

**Test fixtures:** fresh session loads `coding-flow` (not the old pair); `read_fsm_state{pack:'coding-flow'}` from pack-architect returns a real state; a `src/` write pre-research is DENIED by the unified gate; `git commit` pre-phase-log blocked.

**Acceptance criteria:** [ ] zero live refs to `scope-fsm`/`workflow-fsm` (grep clean in src/packs/active.json); [ ] both active.json → `coding-flow`; [ ] session-end clears `coding-flow`; [ ] live smoke: scope-intent → block-on-incomplete → research → code-allowed → task-gate → commit-gate all fire from `coding-flow`; [ ] old packs removed only after equivalence green; [ ] CI green.

**Risk callouts:** the single missed re-point = a silently-absent gate (surface-map: the pack-architect `pack:` arg + the two active.json are the easy-to-miss ones); do the equivalence smoke in an isolated `OPENSQUID_HOME` (`[[feedback-verify-with-isolated-state]]`); ship→verify→delete, never delete-then-hope (DPC.6).

**References:** surface-map §3; CF.5; `[[feedback-verify-with-isolated-state]]`.

**Verification commands:**

```bash
cd /Users/slee/projects/opensquid
grep -rn "scope-fsm\|workflow-fsm" src/ packs/ ; cat ~/projects/{loop,opensquid}/.opensquid/active.json
export TEST_HOME=$(mktemp -d); OPENSQUID_HOME=$TEST_HOME <equivalence smoke>; rm -rf $TEST_HOME
pnpm vitest run && pnpm build
```

**7-phase steps:** 1 pre-research: build the equivalence checklist (every retired skill behavior → its coding-flow guard); 2 learn: lock cutover order (ship → activate → verify → delete); 3 code: re-point §3.1, update §3.3 tests + §3.4 docs, edit active.json; 4 test: isolated live smoke + full suite; 5 audit: grep-clean of old names, nothing deleted pre-equivalence; 6 post-research: DPC.6 migration record; 7 fix: remove old packs + `.backup`s once green.

### Task FU.6: Documentation sync (the worked example becomes coding-flow)

**Required skills:** Technical-writing / docs expert; opensquid pack-format expert; Audit / code review expert
**Deliverable:** `docs/pack-fsm-architecture.md` + `docs/pack-runtime.md` describe the unified `coding-flow` FSM as the canonical worked example (union states, `guess_found→researching`, the region mechanism); planning docs get "superseded by T-fsm-unify" notes.
**Depends on:** [FU.5](#task-fu5-cut-over--activejson--cross-refs--retire-scope-fsmworkflow-fsm-behavioral-equivalence)

**Files affected:** §3.4 docs — `docs/pack-fsm-architecture.md` (the worked example + the inline machine at :113-119), `docs/pack-runtime.md` (:246, :933-934, :1042, :1051, :1056-1058); planning docs get one-line superseded notes.

**Key code shapes:**

```markdown
<!-- docs/pack-fsm-architecture.md — the worked example becomes coding-flow -->

initial: idle
states: [idle, scoping, researching, researched, spec_authored,
spec_complete, tasks_loaded, phases_in_flight, phases_complete]

# researched --guess_found--> researching (SCOPE content gate — guess-audit)

# spec_authored --spec_verified--> spec_complete (AUTHOR content gate — spec-audit)
```

```diff
- State persists … at `<sess>/state/fsm-workflow-fsm.json`   # docs/pack-runtime.md:1051
+ State persists … at `<sess>/state/fsm-coding-flow.json`
- Cross-pack reads pass `pack: workflow-fsm`.                # docs/pack-runtime.md:1057
+ Cross-pack reads pass `pack: coding-flow`.
```

**Test fixtures:** `grep -rn "scope-fsm\|workflow-fsm" docs/` returns only historical / superseded-note hits (no text presenting them as current); `npx prettier --check docs/pack-fsm-architecture.md docs/pack-runtime.md` → clean; a reader-check: `pack-fsm-architecture.md`'s worked example shows the 9-state machine with BOTH content-gate edges (`guess_found`, `spec_verified`).

**Acceptance criteria:** [ ] no doc shows the old two-machine split as current; [ ] the region + three-stage concept documented; [ ] both content-gate edges shown in the worked example; [ ] `prettier --check` green (CI gates `.md`).

**Risk callouts:** CI gates `prettier --check` on `.md` — run `format:check` LAST after authoring (the pre-push lesson).

**References:** surface-map §6.

**Verification commands:** `pnpm format:check && <CI verify per gh run view --json conclusion>`.

**7-phase steps:** 1 pre-research: list every doc hit (§6); 2 learn: lock the new worked-example; 3 code: rewrite the example + region section; 4 test: prettier; 5 audit: no stale two-machine language; 6 post-research: n/a; 7 fix.

### Task FU.7: The EXECUTE content gate — phase-logged-before-commit (DONE, 0.5.300)

**Required skills:** opensquid skill.yaml author expert; Claude Code hooks expert; Audit / code review expert
**Deliverable:** a `coding-flow/skills/execute-gate` skill blocks `git commit` while the active task's 7 phases are unlogged — the EXECUTE content gate, symmetric with SCOPE's guess-audit + AUTHOR's spec-audit; mode-independent (no `automation_mode_on`). SHIPPED 0.5.300 (`5b9d4d3`).
**Depends on:** [FU.2](#task-fu2-author-the-fsm-driven-guards--merge-the-per-pack-duplicates)

**Files affected:** `packs/builtin/coding-flow/skills/execute-gate/skill.yaml` (new); `docs/research/T-execute-gate-pre-research-2026-06-03.md` (pre-research).

**Key code shapes:**

```yaml
- call: match_command
  args: { pattern: '^git\s+(?:-[cC]\s+\S+\s+)*commit\b', target: tool_args.command }
  as: committing
- call: has_active_task
  if: 'committing'
  as: active
- call: workflow_phases_complete
  if: 'committing && active.present == true'
  as: phases
- call: verdict
  if: 'committing && active.present == true && phases.complete == false'
  args: { level: block, message: 'log the 7 phases via log_phase before commit' }
```

**Test fixtures:** no active task → commit passes; active task + <7 phases → block; active task + all 7 phases → pass.

**Acceptance criteria:** [x] gate blocks commit on incomplete phases; [x] ad-hoc commits pass; [x] mode-independent; [ ] behavioral dispatch test (FU.9).

**Risk callouts:** ad-hoc commits (no active task) pass by design — practicality; the SCOPE gate already forces code into the flow.

**References:** `sangmin-personal-rules/skills/workflow/skill.yaml:34-70` (the port source); `src/functions/active_task.ts`.

**Verification commands:** `node -e "loadPack('packs/builtin/coding-flow')"`; `pnpm build`.

**7-phase steps:** 1 pre-research: read the personal gate + primitives (DONE); 2 learn: lock mode-independent design; 3 code: author execute-gate; 4 test: FU.9; 5 audit: parity with the personal gate; 6 post-research: n/a; 7 fix.

### Task FU.8: Fix the dispatch first-verdict short-circuit suppressing FSM advances

**Required skills:** opensquid dispatcher expert; TypeScript expert; Architectural design expert; Audit / code review expert
**Deliverable:** a side-effect FSM advance (`advance_fsm`) is no longer suppressed when a HIGHER-precedence pack emits a verdict earlier in the same dispatch — so coding-flow's `advance-on-research`/`advance-on-spec` run even when a user-scope pack (e.g. `pre-research-authoring`) verdicts first. Today the first verdict short-circuits the whole walk (`dispatch.ts:14`), so the FSM stalls at `idle` and the gate jams.
**Depends on:** None (dispatcher fix).

**Files affected:** `src/runtime/hooks/dispatch.ts` (the pack/skill walk + verdict short-circuit, ~:331-481); `src/runtime/hooks/dispatch.test.ts` (new case).

**Key code shapes:**

```ts
// Decouple side-effect rules (advance_fsm/write_state → no_verdict) from the
// verdict short-circuit: walk ALL rules for their side effects, but stop
// adopting NEW verdicts after the first. (Or: run a side-effect pre-pass per
// event before the verdict walk.) The first verdict still wins exitCode.
```

**Test fixtures:** pack A (user scope) warns on a docs/research write; pack B (project scope) has an `advance_fsm` rule on the same write → after dispatch, B's FSM advanced (state persisted) AND A's warn still set the verdict.

**Acceptance criteria:** [ ] a higher-precedence verdict no longer suppresses a lower pack's `advance_fsm`; [ ] the first verdict still determines exitCode (no regression to existing short-circuit tests); [ ] full suite green.

**Risk callouts:** must NOT change which verdict wins (existing first-match contract); only side-effect advances should survive. Verify against `dispatch.ts` existing short-circuit tests.

**References:** `docs/research/T-execute-gate-pre-research-2026-06-03.md` §3 (the live observation); `dispatch.ts:14,331,347,462`.

**Verification commands:** `pnpm vitest run src/runtime/hooks/dispatch.test.ts && pnpm vitest run && pnpm build`.

**7-phase steps:** 1 pre-research: read the full walk + every short-circuit test; 2 learn: lock side-effect-survives-verdict vs pre-pass; 3 code: implement; 4 test: the cross-pack advance fixture + no verdict-order regression; 5 audit: first-verdict-wins preserved; 6 post-research: compare against other rule engines' side-effect ordering; 7 fix.

### Task FU.9: Behavioral dispatch test for execute-gate

**Required skills:** opensquid skill.yaml author expert; System integration test / CI fixtures expert; Audit / code review expert
**Deliverable:** `test/builtin/coding-flow.test.ts` gains an EXECUTE-gate describe: git commit with no active task passes; active task + incomplete phases blocks (exit 2); active task + all 7 phases passes.
**Depends on:** [FU.7](#task-fu7-the-execute-content-gate--phase-logged-before-commit-done-05300)

**Files affected:** `test/builtin/coding-flow.test.ts` (add a describe block).

**Key code shapes:**

```ts
await writeActiveTask(sid, { id: 't1', started_at: TS });
for (const p of REQUIRED_PHASES) await appendPhase(sid, 't1', p); // complete case
const reg = registry(); // + r.register(HasActiveTask); r.register(WorkflowPhasesComplete);
const ev = { kind: 'tool_call', tool: 'Bash', args: { command: 'git commit -m x' } };
expect((await dispatchEvent(ev, [pack], reg, sid)).exitCode).toBe(0); // complete → pass
```

**Test fixtures:** the 3 cases above (no-task pass, incomplete block, complete pass).

**Acceptance criteria:** [ ] all 3 cases assert the right exitCode; [ ] uses `writeActiveTask` + `appendPhase` + `REQUIRED_PHASES` to seed; [ ] green in the full suite.

**Risk callouts:** the registry must register `HasActiveTask` + `WorkflowPhasesComplete` (`src/functions/active_task.ts`) + `match_command` (verify it's in `registerEventFunctions`); set `OPENSQUID_HOME` to a temp dir per-test.

**References:** `src/functions/active_task.ts`, `src/runtime/workflow_phases.ts` (`appendPhase`, `REQUIRED_PHASES`, `isComplete`), `src/runtime/session_state.ts` (`writeActiveTask`).

**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts`.

**7-phase steps:** 1 pre-research: read the seed helpers (DONE — appendPhase(sid,taskId,phase), ActiveTask{id,started_at}); 2 learn: lock the 3 fixtures; 3 code: add the describe; 4 test: run; 5 audit: no over-block; 6 post-research: n/a; 7 fix.

### Task FU.11: The task-start hook — per-task flow enforcement

**Required skills:** opensquid skill.yaml author expert; opensquid FSM/dispatcher expert; Tool-sequence FSM design expert; Audit / code review expert
**Deliverable:** activating a task (`TaskUpdate(<id>, in_progress)`) on an UNSCOPED task (no generated spec on disk) resets the coding-flow FSM to `scoping` and emits a directive nudging "scope this first", so the always-on `scope-before-code` gate re-arms for the new task — closing the hole where the session-level FSM stays at `phases_complete` and waves new-task code through.
**Depends on:** [FU.8](#task-fu8-fix-the-dispatch-first-verdict-short-circuit-suppressing-fsm-advances) (advance must survive any earlier verdict)

**Files affected:**

- `packs/builtin/coding-flow/fsm.yaml` (modify) — add the wildcard reset transition.
- `packs/builtin/coding-flow/skills/task-start/skill.yaml` (new) — the guard.
- `test/builtin/coding-flow.test.ts` (modify) — FU.11 dispatch cases.

**Key code shapes:**

```yaml
# coding-flow/fsm.yaml — one wildcard transition (step supports from: '*', fsm.ts:106)
- { from: '*', on: task_unscoped, to: scoping }
```

```yaml
# coding-flow/skills/task-start/skill.yaml
triggers: [{ kind: tool_call }]
rules:
  - id: unscoped-task-rescopes
    process:
      - call: tool_name
        as: tool
      - call: tool_args
        as: targs
      - call: has_generated_spec
        if: '(tool == "TaskUpdate") && targs.status == "in_progress"'
        as: spec
      - call: advance_fsm
        if: '(tool == "TaskUpdate") && targs.status == "in_progress" && spec.present == true && spec.generated == false'
        args: { event: task_unscoped }
      - call: verdict
        if: '(tool == "TaskUpdate") && targs.status == "in_progress" && spec.present == true && spec.generated == false'
        args:
          level: directive
          next_action:
            profession: scope-architect
            rationale: >-
              New task activated with no generated spec — the flow reset to scoping.
              Research → 11-field spec → then code. Do not start coding this task yet.
```

**Test fixtures:** TaskUpdate(in_progress) on a task whose active-task mirror has a resolvable `spec` → no reset (FSM unchanged), no directive; TaskUpdate(in_progress) on a task whose mirror has no spec → FSM → `scoping` + a directive; a non-TaskUpdate event → no-op.

**Acceptance criteria:**

- [ ] activating an unscoped task resets the FSM to `scoping`
- [ ] activating a scoped task does NOT reset (per-task ledger handles EXECUTE)
- [ ] the reset emits a `directive` nudging scope-first
- [ ] `validateFsm` still passes with the wildcard transition
- [ ] full suite green

**Risk callouts:** `has_generated_spec` reads the active-task mirror (`active_task.ts:120`) — the just-activated task must already be mirrored when the guard runs (verify the mirror write precedes the guard in the same event, else read the spec from `targs.metadata.spec`). The wildcard `from:'*'` must not accidentally fire on unrelated events — gate it strictly on `tool == "TaskUpdate" && status == in_progress`. Keep the per-WRITE has_generated_spec gate OUT of this task (separate follow-up).

**References:** `docs/research/T-task-start-enforcement-pre-research-2026-06-03.md`; `src/functions/active_task.ts:120` (has_generated_spec); `src/runtime/fsm.ts:106` (`*` wildcard); `coding-flow/skills/entry-and-handoffs/skill.yaml` (directive pattern).

**Verification commands:**

```bash
cd /Users/slee/projects/opensquid
node -e "import('./dist/packs/loader.js').then(m=>m.loadPack('packs/builtin/coding-flow')).then(p=>import('./dist/runtime/fsm.js').then(f=>console.log(f.validateFsm(p.fsm))))"
pnpm vitest run test/builtin/coding-flow.test.ts && pnpm vitest run && pnpm build
```

**7-phase steps:** 1 pre-research: read fsm.yaml + fsm.ts `*` + has_generated_spec + the directive pattern (DONE); 2 learn: lock the trigger (`TaskUpdate in_progress`) + the reset transition + the has_generated_spec keying; 3 code: add the transition + the task-start skill; 4 test: the 3 dispatch fixtures; 5 audit: wildcard fires only on the intended event, validateFsm clean; 6 post-research: compare against the old scope-architect Gate A (has_generated_spec); 7 fix.

### Task FU.10: The phase-audit — gate `log_phase` on tool-ledger evidence

**Required skills:** opensquid skill.yaml author expert; Tool-sequence FSM design expert; opensquid dispatcher/evaluator expert; Audit / code review expert
**Deliverable:** a `phase-audit` guard blocks `log_phase` for a mechanically-verifiable phase that lacks this-turn evidence — `code`/`fix` need a Write/Edit, `test` needs a Bash. `learn`/`audit`/`post_research` are accepted (no proxy). Closes the "log a phase without doing it" gap the user surfaced ("does that need to be a gate itself?").
**Depends on:** [FU.7](#task-fu7-the-execute-content-gate--phase-logged-before-commit-done-05300) (the execute-gate this hardens)

**Files affected:** `packs/builtin/coding-flow/skills/phase-audit/skill.yaml` (new); `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
- call: session_tool_history
  if: '(tool == "mcp__opensquid__log_phase") && (targs.phase == "code" || targs.phase == "fix")'
  args: { scope: current_turn, filter_names: [Write, Edit, NotebookEdit] }
  as: writes
- call: verdict
  if: '(tool == "mcp__opensquid__log_phase") && (targs.phase == "code" || targs.phase == "fix") && writes.count == 0'
  args: { level: block, message: 'no Write/Edit this turn — do the work before logging' }
# test → require a Bash this turn (a run); learn/audit/post_research accepted.
```

**Test fixtures:** log_phase(code) with no Write this turn → block; log_phase(code) after a Write → pass; log_phase(test) with no Bash → block; log_phase(learn) always → pass.

**Acceptance criteria:** [ ] code/fix without writes → block; [ ] test without a run → block; [ ] learn/audit/post_research → pass; [ ] full suite green.

**Risk callouts:** `test = any Bash this turn` is a heuristic (a Bash ≠ provably a test) — the limit of name-only ledger evidence; documented. `current_turn` resets on UserPromptSubmit (`session_state.ts:138`) — a phase done in a prior turn then logged later would false-block; acceptable (log phases in the turn you do them).

**References:** `docs/research/T-phase-audit-pre-research-2026-06-03.md`; `src/functions/session_tool_history.ts:36-64`; `src/mcp/tools/log_phase.ts`.

**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm vitest run && pnpm build`.

**7-phase steps:** 1 pre-research: read session_tool_history + log_phase + the turn-ledger reset (DONE); 2 learn: lock which phases are gateable; 3 code: the phase-audit skill; 4 test: the 4 fixtures (seed the turn ledger); 5 audit: judgment phases accepted, no over-block; 6 post-research: the DPC.5 precedent (pre_research already gated); 7 fix.

---

## 5. Locked decisions

1. `coding-flow` is the ONE FSM-driven pack; `scope-fsm`+`workflow-fsm` absorbed + retired; the FSM is the canonical substrate (no-implicit-state).
2. Union FSM per §1.2; D1 drop `building`, D2 keep `researching`, D3 `guess_found→researching`, D4 region-based code-gate allow-set, D5 initial `idle`, D6 accept state reset on cutover (no migration-copy).
3. Task-type = region profile (§1.4), a guard-consulted table, NOT new states or a new machine; default `feature`; misclassification → strictest.
4. Reconciles CF.1–CF.6 (does not duplicate them): CF.2 + CF.3 fold into FU.4; CF.6 harness map is the §2.1 binding column; CF.5 cutover is FU.5.
5. B2 flow-templates stay deferred — the generality lives in this one composable machine, not a code-gen layer.
6. Behavioral-equivalence before deletion; isolated `OPENSQUID_HOME` for live smokes; ship→verify→delete.

## 6. Open questions (scoping) — for the user

1. **Pack name:** keep `coding-flow` (CF track's name) for the unified FSM pack, or a new name (`coding-flow-fsm`, `flow`)? Default: `coding-flow` (reuses the CF track's locked L1 name + active.json plan).
2. **Region granularity:** the §1.4 profile set is `{feature, fix, doc, trivial}`. Is that the right partition, or do you want a different/most-minimal set (e.g. just `full` vs `quick`)?
3. **Scope vs CF track:** this supersedes CF.1/CF.4–CF.6's _skill-consolidation_ framing by making it FSM-first. OK to mark `T-coding-flow-pack.md` as "superseded by T-fsm-unify (FSM-driven)" — or keep both and have this one reference it as the skill-inventory source?
