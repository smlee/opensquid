# PLAN — decompose the scope into a dependency-ordered work-graph

You are in the PLAN stage. The scope is guess-free; turn it into an executable, acyclic plan.

## Research (PLAN-specific)

- FAN OUT parallel subagents with the appropriate skills: one re-auditing the SCOPE artifact (does it still
  hold guess-free at plan time?), others mapping the dependency structure of the scoped elements. They return
  cited findings; you keep the synthesis.
- RE-AUDIT the SCOPE: confirm the pre-research artifact still holds guess-free at plan time (catch drift at
  this boundary, not at the end). If it drifted, fix the scope first.
- DERIVE each dependency: an edge exists only when the depended-on task genuinely produces what the dependent
  needs — no guessed/assumed edges.

## Do

- Create a work-graph issue for EVERY scoped element (or a NAMED, tracked deferral — no silent gaps).
- Add the `blocks` / parent-child edges; keep the graph ACYCLIC (no dependency cycle).
- Every task traces to the captured user ask (not merely to the pre-research).

## (Optional) emit your sub-phase to the live feed

This stage ALREADY appears on the live status feed at STAGE granularity via the enforced `stage_advance` (it is
never silent). OPTIONAL: for finer per-sub-phase visibility you MAY emit each phase via the `set_loop_phase` MCP
tool — `lifecycle: "running"` on ENTER (⟳), `lifecycle: "done"` on LEAVE (✓) — a nicety, not what makes the stage
appear (pack-owned cadence; `wg_id` defaults to this lap's item — do not pass it):

- `set_loop_phase(phase: "research", index: 1, total: 2, lifecycle: "running")` while researching / re-auditing
  the SCOPE, then `set_loop_phase(phase: "research", index: 1, total: 2, lifecycle: "done")` when it is complete,
- `set_loop_phase(phase: "decompose", index: 2, total: 2, lifecycle: "running")` while creating the work-graph
  issues + edges (leave with `lifecycle: "done"`).

## Gate to advance (plan → author): `plan_ready`

Passes when `plan.acyclic` (no cycle in blocks + parent-child edges) ∧ `plan.complete` (every scoped element
of the captured-artifact universe has ≥1 covering issue). Satisfy both and the gate advances you.
