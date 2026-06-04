# Pre-research — FU.3: region profiles (track-type → required regions)

**Date:** 2026-06-04. **Repo:** opensquid. **Spec origin:** `docs/tasks/T-fsm-unify.md:459-504`
(§1.4 `TRACK_PROFILES`). **Research this turn:** Read of `entry-and-handoffs/skill.yaml`
(enter-scoping), `scope-lifecycle/skill.yaml` (taskcreate-spec-required, the AUTHOR gate),
the §1.4 table + the FU.3 spec; grep of the profile table.

## 1. The mechanism (verified)

§1.4 `TRACK_PROFILES`: `feature: [SCOPE,AUTHOR,EXECUTE]`, `fix:[SCOPE,EXECUTE]`,
`doc:[SCOPE,EXECUTE]`, `trivial:[EXECUTE]`. Only AUTHOR is profile-dependent — SCOPE
(code-gate) and EXECUTE (commit-gate) are universal. So FU.3 = (a) classify track-type
at scope entry + record it, (b) make the AUTHOR gate (`taskcreate-spec-required`,
`scope-lifecycle/skill.yaml:146-161`) consult it.

## 2. Allow-list decision (the spec's open question)

The FU.3 risk callout asks whether list-membership (`contains(track.regions, "AUTHOR")`)
is expressible. **Avoided entirely:** the only profile-dependent region is AUTHOR, and
only `feature` (and unclassified) needs it. So a STRING-EQUALITY gate suffices — already in
the frozen allow-list (`scope-lifecycle` uses `st != "researched"` etc.). The AUTHOR gate
fires unless `track ∈ {fix,doc,trivial}`. No new evaluator surface (Simplicity; mirrors the
D4 disjunction choice the spec cites).

## 3. Fail-safe = strictest (the critical correctness point)

`read_state` of an unset/absent key reads as null → `null != "fix"` is true → the AUTHOR
gate FIRES (treats unclassified as `feature`). Default is therefore strictest, as required.
BUT state persists across turns: a prior `fix` track would leak into a later `feature`
task and wrongly skip AUTHOR (a fail-OPEN under-gate). FIX: `enter-scoping` RESETS
`coding-flow-track` to `feature` on every scope entry BEFORE applying any downgrade — so a
stale value can never under-gate.

## 4. Implementation (derived)

- `enter-scoping` (entry-and-handoffs): after `advance_fsm scope_start`, in the SAME rule
  process: `write_state{coding-flow-track: feature}` (reset), then re-`text_pattern_match`
  the prompt for fix / doc / trivial keyword sets and `write_state` the matched type
  (later steps overwrite — ambiguity among fix/doc/trivial is harmless, all skip AUTHOR).
- `taskcreate-spec-required`: add `read_state{coding-flow-track} as track`; the block `if`
  gains `&& track != "fix" && track != "doc" && track != "trivial"`.
- `packs/builtin/coding-flow/PROFILES.md` (new) — the profile table as single source.

## 5. Test fixtures (coding-flow.test.ts)

- `feature` intent (e.g. "add a new task") → AUTHOR gate fires on TaskCreate.
- `fix` intent ("fix the flaky test") → track=fix → AUTHOR gate SKIPS; scope-before-code
  still requires SCOPE.
- unclassified / stale-track-from-prior-fix + a feature prompt → reset → AUTHOR fires
  (default strictest). Open questions: none that block.
