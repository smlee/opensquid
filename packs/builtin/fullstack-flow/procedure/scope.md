# SCOPE — capture the guess-free scope of the work

You are in the SCOPE stage. SCOPE is the ONE interactive stage; everything after it is automated.

## Do

- Research first (need ≥3 real research calls this turn: `recall` + Read + Grep) before writing anything —
  AND when the task's subject or a load-bearing dependency is an EXTERNAL tool/service, at least one external
  primary-source call (`WebSearch` / `WebFetch` / repo read) is PART OF that mandatory minimum, not optional.
  A scope of an external tool with zero external-source calls has not met the research bar.
- FAN OUT parallel research subagents, each with the skills appropriate to its angle (e.g. a codebase-explorer
  over the affected subsystems, an external/primary-docs researcher, an existing-solution scout). They burn
  THEIR context; you keep only the cited synthesis — that is how the main context stays clean.
- Climb the source ladder: the user's words → memory → prior research → local code → and the EXTERNAL primary
  source (the tool's own docs/repo, via WebSearch/WebFetch) — record it.
- **EXTERNAL-SUBJECT ⇒ mandatory exhaustive web grounding (rubric §6).** When the task's subject or a
  load-bearing dependency IS an external tool/service (e.g. adding a harness), the local `recall`+Read+Grep bar
  is NOT enough: also sweep the tool's FULL capability surface against its primary docs/repo/examples
  (invocation + I/O framing, output/cost format, config, auth, extension API, and EVERY sub-capability the
  procedures require — subagents/fan-out, hooks/enforcement, MCP — do not assume a barebones tool has one).
  A publicly-findable fact MUST be grounded here — it may NOT be parked as an OPEN QUESTION or deferred to
  PLAN / a live-acceptance. Leaning on downstream review to surface web-findable facts is a scope failure.
- Write the pre-research artifact to `{docsRoot}/research/<track>-pre-research-<date>.md`. Every claim is cited
  (`file:line` / memory / the user's words) OR flagged as an unchecked `- [ ] OPEN QUESTION: …`.
- Capture the FULL scope against the design you cite — no MVP / convenient-slice reduction (see the rubric).
- CITE THE AUTHORITATIVE design-of-record. Before scoping, confirm the design you cite is the CURRENT one, NOT a
  superseded or narrower predecessor: check for a newer doc on the same topic that says it SUPERSEDES this one —
  if two cover the same ground, the superseding one wins. Scoping against a stale/narrow design yields a
  "complete" scope of the WRONG target (the reporting-MVP failure: the build faithfully matched a superseded
  narrow task instead of the full model).
- Resolve every open question here (ask the user only if it is unanswerable after research OR an
  architecture-changing fork). CHECK the box / remove the item before you leave SCOPE.

## (Optional) emit your sub-phase to the live feed

This stage ALREADY appears on the live status feed at STAGE granularity via the enforced `stage_advance` (it is
never silent — every stage transition pushes it). OPTIONAL: for finer per-sub-phase visibility you MAY emit each
phase via the `set_loop_phase` MCP tool — `lifecycle: "running"` on ENTER (⟳), `lifecycle: "done"` on LEAVE (✓)
— a nicety, not what makes the stage appear (pack-owned cadence; `wg_id` defaults to this lap's item — do not
pass it):

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
