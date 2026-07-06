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

## Gate to advance (scope_write → plan): `scope_write_ready`

Passes when the pre-research write is: `anchors_ok` (every scoped element traces to the captured ask)
∧ `!open_question` (no unchecked `- [ ] OPEN QUESTION` remains in the artifact)
∧ `contains(audit.scope, "VERDICT: GUESS_FREE")` (the content-audit judged the artifact guess-free).
Satisfy all three and the gate advances you automatically.
The work-graph is auto-populated from the artifact's scoped elements on the scope_write → plan transition.
