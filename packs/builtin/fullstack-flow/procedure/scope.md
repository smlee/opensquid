# SCOPE — capture the guess-free scope of the work

You are in the SCOPE stage. SCOPE is the ONE interactive stage; everything after it is automated.

## Do

- Research first (need ≥3 real research calls this turn: `recall` + Read + Grep) before writing anything.
- FAN OUT parallel research subagents, each with the skills appropriate to its angle (e.g. a codebase-explorer
  over the affected subsystems, an external/primary-docs researcher, an existing-solution scout). They burn
  THEIR context; you keep only the cited synthesis — that is how the main context stays clean.
- Climb the source ladder: the user's words → memory → prior research → local code → and when local cannot
  answer, the EXTERNAL primary source (the tool's own docs/repo, via WebSearch/WebFetch) — record it.
- Write the pre-research artifact to `docs/research/<track>-pre-research-<date>.md`. Every claim is cited
  (`file:line` / memory / the user's words) OR flagged as an unchecked `- [ ] OPEN QUESTION: …`.
- Capture the FULL scope against the design you cite — no MVP / convenient-slice reduction (see the rubric).
- Resolve every open question here (ask the user only if it is unanswerable after research OR an
  architecture-changing fork). CHECK the box / remove the item before you leave SCOPE.

## Emit your phase to the live status feed

As you move through SCOPE, emit each phase via the `set_loop_phase` MCP tool so the harness status line / Monitor
shows where this item is (pack-owned cadence; `wg_id` defaults to this lap's item — do not pass it):

Emit each phase with `lifecycle: "running"` on ENTER (⟳) and `lifecycle: "done"` on LEAVE (✓), so the feed
shows whether the phase is in flight or finished:

- `set_loop_phase(phase: "research", index: 1, total: 3, lifecycle: "running")` while researching,
  then `set_loop_phase(phase: "research", index: 1, total: 3, lifecycle: "done")` when it is complete,
- `set_loop_phase(phase: "write-artifact", index: 2, total: 3, lifecycle: "running")` while writing the
  pre-research artifact (leave with `lifecycle: "done"`),
- `set_loop_phase(phase: "confirm", index: 3, total: 3, lifecycle: "running")` when you present the scope for
  the user's confirmation (leave with `lifecycle: "done"`).

## Gate during SCOPE (scope → scope_write): `scope_ready`

Passes only when the pre-research write is: `anchors_ok` (every scoped element traces to the captured ask)
∧ `!open_question` (no unchecked `- [ ] OPEN QUESTION` remains).
Satisfy both in the artifact (the FSM transitions scope → scope_write on the next advance event).

## Exit SCOPE (the human permission to advance)

SCOPE is interactive and human-paced — it does NOT end automatically.
When your research is complete and the artifact quality checks above hold:

1. Present a summary of the gathered scope to the user: "Here is the scope I gathered — does this look correct?"
2. Wait for the user's explicit confirmation.
3. On confirmation, emit: `RALPH-EXIT: {"kind":"SHIPPED","stage":"scope_write"}`
   The user's confirmation IS the human permission.
   The next automated lap (SCOPE_WRITE) will write the formal pre-research artifact.
