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

## Gate to advance (scope → plan): `scope_ready`
Passes only when the pre-research write is: `anchors_ok` (every scoped element traces to the captured ask)
∧ `depth ≥ 3` (≥3 research calls this turn) ∧ `!open_question` (no unchecked `- [ ] OPEN QUESTION` remains).
Satisfy all three IN the artifact and the gate advances you automatically.
