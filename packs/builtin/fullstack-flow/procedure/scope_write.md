# SCOPE_WRITE — finalize the approved scope revision

You are in the automated SCOPE_WRITE stage.
The approved canonical artifact already exists at the path in WORK-CONTEXT.
Do not repeat SCOPE, create a second artifact, re-confirm, or re-research.

## Do

- This disposable StageProcess owns this stage attempt directly. Correct the approved artifact with this stage's
  granted tools; do not spawn another stage process or start a nested loop.
- Read the latest exact-byte audit findings supplied in WORK-CONTEXT.
- If the current revision is already `VERDICT: GUESS_FREE`, do not rewrite it; advance to PLAN.
- Otherwise update that same canonical file once, using only the approved scope and its recorded citations.
  Do not retrieve a source merely because this is a fresh session.
- If a finding genuinely requires evidence absent from the approved scope, stop and return it to interactive
  SCOPE for a new exact-byte approval. Automation must not expand approved scope or invent research authority.
- Run the complete pack-declared content-audit lens set for the resulting bytes. A changed revision invalidates
  every old prompt hash; never authorize it with a hand-picked subset. Advance only on `VERDICT: GUESS_FREE`.
- Exit: `RALPH-EXIT: {"kind":"SHIPPED","stage":"plan"}`

## Gate to advance

The existing `scope_write_ready` gate remains authoritative: the canonical artifact must retain its captured-ask
anchors, contain no open question, and have a fresh exact-byte `GUESS_FREE` verdict.
