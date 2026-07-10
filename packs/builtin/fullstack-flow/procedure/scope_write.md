# SCOPE_WRITE — write the guess-free pre-research artifact

You are in the SCOPE_WRITE stage.
SCOPE_WRITE is automated: write the formal pre-research artifact that captures the scope you gathered and the user confirmed in the interactive SCOPE stage.
The user already confirmed the scope — do not re-confirm or re-research; just write the artifact.

## Do

- Write the pre-research artifact to `docs/research/<track>-pre-research-<date>.md`.
- Every claim must be cited (`file:line` / memory / the user's words) — no bare assertions.
- Flag any residual uncertainty as `- [ ] OPEN QUESTION: …` then resolve it before exiting.
- Capture the FULL scope against the design you cite — no MVP / convenient-slice reduction.
- After writing, run the content-audit skill (`cached_audit`) to obtain the GUESS_FREE verdict.
- Exit: `RALPH-EXIT: {"kind":"SHIPPED","stage":"plan"}`

## (Optional) emit your sub-phase to the live feed

This stage ALREADY appears on the live status feed at STAGE granularity via the enforced `stage_advance` (it is
never silent). OPTIONAL: for finer per-sub-phase visibility you MAY emit each phase via the `set_loop_phase` MCP
tool — `lifecycle: "running"` on ENTER (⟳), `lifecycle: "done"` on LEAVE (✓) — a nicety, not what makes the stage
appear (pack-owned cadence; `wg_id` defaults to this lap's item — do not pass it):

- `set_loop_phase(phase: "write", index: 1, total: 2, lifecycle: "running")` while writing the artifact,
  then `set_loop_phase(phase: "write", index: 1, total: 2, lifecycle: "done")` when it is written,
- `set_loop_phase(phase: "audit", index: 2, total: 2, lifecycle: "running")` while running the content-audit for
  the GUESS_FREE verdict (leave with `lifecycle: "done"`).

## Gate to advance (scope_write → plan): `scope_write_ready`

Passes when the pre-research write is: `anchors_ok` (every scoped element traces to the captured ask)
∧ `!open_question` (no unchecked `- [ ] OPEN QUESTION` remains in the artifact)
∧ `contains(audit.scope, "VERDICT: GUESS_FREE")` (the content-audit judged the artifact guess-free).
Satisfy all three and the gate advances you automatically.
The work-graph is auto-populated from the artifact's scoped elements on the scope_write → plan transition.
