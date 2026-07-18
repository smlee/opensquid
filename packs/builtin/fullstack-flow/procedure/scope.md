# SCOPE — capture the guess-free scope of the work

You are in the SCOPE stage. SCOPE is the ONE interactive stage; everything after it is automated.

## Do

- Research first (need ≥3 real research calls this turn: `recall` + Read + Grep) before writing anything —
  AND when the task's subject or a load-bearing dependency is an EXTERNAL tool/service, at least one external
  primary-source call (`WebSearch` / `WebFetch` / repo read) is PART OF that mandatory minimum, not optional.
  A scope of an external tool with zero external-source calls has not met the research bar.
- Perform the required research directly. A pack-declared bounded read-only reviewer may cover an independent
  lens when useful, but reviewer fan-out is optional and never delegates SCOPE ownership or stage progression.
- Climb the source ladder once: the user's words → memory → prior research → local code → and the EXTERNAL
  primary source (the tool's own docs/repo, via WebSearch/WebFetch) — record the reusable citation in the
  artifact. Reuse still-current cited research; do not fetch the same source again just because the session changed.
- For an external subject, satisfy the single exhaustive contract in SCOPE rubric criterion 6. Do not create a
  second checklist here; the rubric owns what the capability sweep covers.
- Create the configured destination with `mkdir -p -- "{docsRoot}/research"`, then write the pre-research artifact
  to `{docsRoot}/research/<track>-pre-research-<date>.md`. The shared strict policy has already validated the
  configured value; this creation supports a fresh project whose default `docs` or configured sibling root does
  not exist yet. Every claim is cited
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
3. On confirmation, invoke exactly:
   `opensquid loop scope-done <active-wg-id> <approved-absolute-artifact>`
4. Parse exactly one complete LF-terminated result. For `scope_handoff`, stop immediately: report pid-bearing
   success, or report `loop.status:"error"` because the coordinator already exhausted its three liveness attempts.
   For `scope_handoff_error`, stop on `validation`, `conflict`, or `stale`; retry only `persistence`, because that
   typed result states no receipt committed. Also retry an uncertain response (signal, timeout, EOF, malformed or
   unterminated JSON, or nonzero exit with no structured result). Use the identical command at most twice more,
   waiting 250 ms then 1 second. Stop after command attempt 3. A committed receipt makes uncertain-response retry
   idempotent; deterministic caller/data errors are never multiplied.

The user's confirmation is the human permission. Do **not** emit `RALPH-EXIT` here: that tag is an autonomous-lap
result protocol and cannot persist interactive approval. `scope_write` may formalize the approved artifact at the
same canonical path after the durable handoff starts the loop.
