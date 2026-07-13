# AUTHOR — author the task spec(s): 11 fields, real code, full spec

You are in the AUTHOR (tasking) stage. Turn the plan into self-contained task specs a fresh lap can execute.

## Research (AUTHOR-specific)

- AUTHOR is parent-owned orchestration/specification work. Perform the existing-solution search and PLAN
  re-audit directly; do not send read-only authoring assignments to implementation executors. Preserve the
  executor handoff for bounded repository implementation at CODE.
- EXISTING-SOLUTION SEARCH (reuse belongs HERE — reuse shortens coding): for any NEW capability, search the
  local codebase + the external/primary docs (record the consultation) and either reuse what exists or cite
  why none fits. Speccing a reinvention with no recorded search is a guess about novelty.
- RE-AUDIT the PLAN: confirm it still holds guess-free at author time; if it drifted, fix it first.

## Do

- Every `### Task` block carries all 11 fields; every Key-code-shapes block is REAL code (no pseudocode);
  every 7-phase step names concrete files/decisions.
- Cover 100% of the scope (or a named, tracked deferral). Each Deliverable's acceptance proves the artifact
  works IN ITS LIVE PATH (wired into its real caller) — a built-but-dormant component needs a tracked wiring
  task, else it is INCOMPLETE. Simplest correct design; no MVP/reduced subset of the scoped design.

## (Optional) emit your sub-phase to the live feed

This stage ALREADY appears on the live status feed at STAGE granularity via the enforced `stage_advance` (it is
never silent). OPTIONAL: for finer per-sub-phase visibility you MAY emit each phase via the `set_loop_phase` MCP
tool — `lifecycle: "running"` on ENTER (⟳), `lifecycle: "done"` on LEAVE (✓) — a nicety, not what makes the stage
appear (pack-owned cadence; `wg_id` defaults to this lap's item — do not pass it):

- `set_loop_phase(phase: "research", index: 1, total: 2, lifecycle: "running")` during the existing-solution
  search / PLAN re-audit, then `set_loop_phase(phase: "research", index: 1, total: 2, lifecycle: "done")` after,
- `set_loop_phase(phase: "author", index: 2, total: 2, lifecycle: "running")` while authoring the task spec(s) +
  coverage (leave with `lifecycle: "done"`).

## Gate to advance (author → code): `author_ready`

Passes when `author.manifest_complete` (no gated export lacks a covering requirement) ∧ `author.real_code`
(every requirement MET — a reachable/binding one requires its proof-test to pass; a stub with no passing proof
fails). Satisfy both and the gate advances you.
