# Pre-research — T-PACK-RUNTIME-DOC-DRIFT (sync the authoritative pack-runtime reference)

**Date:** 2026-06-03. **Repo:** opensquid. **Trigger:** the user flagged
`docs/pack-runtime.md` as "very outdated and lots of drifts." It carries a
`Version: 0.5.226` header and predates this session's chain_state→pack-FSM
unification (0.5.289) + guards template (B1) + FSM engine (A1–A3b).

This is a documentation-accuracy fix; the "research" is verifying every drifted
claim against current source (done below, file:line). Docs are not gated by the
scope-fsm research-before-code gate, so no code-path enforcement applies — but
the never-guess rule does: every correction is cited.

## Drift ledger (each verified against live source)

1. **Header** — `Version: 0.5.226 · 2026-05-30 · T-IDENTITY-FOUNDATION`. Stale →
   0.5.292 / 2026-06-03 / + T-PACK-FSM-STANDARDIZATION.
2. **chain_state is DELETED** (`ls` confirms `src/runtime/chain_state.ts`,
   `src/functions/chain_state.ts`, `workflow_map.ts`, `workflow_fsm.ts` all gone).
   The doc still documents it as live in:
   - §5.2 state-primitive table — `read_chain_state` row (the primitive is gone;
     replaced by `read_fsm_state` / `advance_fsm` in `src/functions/fsm.ts:37,52`).
   - §6.1 files-written table — `<sess>/chain-state.json` via `transitionChainStage`.
   - §6.3 "Chain state stages" — cites `src/runtime/chain_state.ts:60-200` (gone).
   - §7.4 "Chain-handoff directives + chain_state transitions" — `transition_chain_stage`.
   - Appendix A — `Chain state | src/runtime/chain_state.ts` + `chain_state` in the
     primitives file list.
   - Appendix B glossary — "Chain stage" row.
3. **`chain_stage` precondition removed** (`skill_requires.ts:48-49` now has only
   `automation_mode_on` + `active_task_present`; the header comment at :11 records
   the removal). §2.3's example still lists `chain_stage: tasks_loaded` AND uses the
   wrong entry shape (`{automation_mode: true}` — real shape is `{kind: automation_mode_on}`).
4. **NOT documented (all shipped this session):**
   - `fsm.yaml` side-file — auto-loaded by filename (NOT a `*_ref`); `loader.ts:199`
     `loadOptionalFsm`, folded to `pack.fsm` (`types.ts:415`), validated total
     (`fsm.ts` `validateFsm`). Missing from §1 dir listing + §1.5 side-files table.
   - `guards:[]` manifest block — `manifest.ts:460-479` (Guard schema), compiled to
     a synthetic `<pack>/guards` skill (`loader.ts:130`, `guards_compiler.ts`).
     Missing from §1.1 fields table; needs its own subsection (peer to §1.11
     verify_gates).
   - `read_fsm_state` / `advance_fsm` primitives (`fsm.ts:37,52`); `read_fsm_state`
     takes optional `pack:` (cross-pack read), returns the state string (null if
     unstarted); `advance_fsm` takes `event:`, returns the next state.
   - Companion doc `docs/pack-fsm-architecture.md` (exists) — add to cross-refs.
5. **`user_pinned` trap** — §1.4 table says `user_pinned` is "True iff
   ctx.userPinned (active.json pin: true flag)". But `userPinned` is never
   populated (`bootstrap.ts` `buildDetectionContext` leaves it false), so a pack
   gated solely on `user_pinned` is silently DISABLED even when opted in (the EWG.3.1
   bug). Needs an explicit "currently inert — do not gate on it" caveat.

## Decisions (no unresolved guess)

1. Surgical edits in place (not a rewrite) — the doc's structure is sound; only the
   chain_state-era claims + the missing FSM/guards surfaces drifted.
2. FSM mechanics stay light here and DEFER to `docs/pack-fsm-architecture.md` (the
   thorough all-levels doc); pack-runtime.md documents the schema/loader/primitive
   surface + cross-links the companion.
3. Keep the `user_pinned` row but annotate it as inert (it IS in the schema; the
   drift is the implication that it works today).

## Open questions — none that block.
