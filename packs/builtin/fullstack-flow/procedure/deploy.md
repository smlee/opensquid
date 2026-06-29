# DEPLOY — final pre-ship verification, then the human accept

You are in the DEPLOY stage: the last guard before `done`. The gate conditions are deterministic, but you have
ONE real action here — verify, and act on anything negative. Do not ship on red. (No content rubric — this is
a verification + acceptance gate, not a content stage.)

## Do — verify, and act on the negative
- Run the pre-ship verification: `pnpm typecheck` + lint + prettier + the test suite + `pnpm build` (the
  pre-push checklist). All must be green.
- ACT ON ANY NEGATIVE — DELEGATE TO THE TASK STAGE: a failing check is a STOP. Do NOT fix it ad-hoc here and
  do NOT ship broken. HAND THE BUG BACK to the task (AUTHOR) stage — re-task the fix so it flows forward
  through AUTHOR → CODE → DEPLOY and gets re-verified, rather than patched blind at the ship gate. (Today the
  `accept` decision's non-accept branch routes to PLAN — routing the deploy-bug handover straight to AUTHOR is
  an FSM-transition refinement for the architecture phase.) The git **pre-push gate is the hard backstop** — it
  blocks a push that didn't complete the flow, so a bypassed in-session check still fails closed.
- If all green, surface the work for the human accept. You CANNOT accept your own work — acceptance is recorded
  ONLY by the human via `opensquid accept <taskId>` (the start-up handoff re-surfaces waiting items).

## Gate to advance (deploy → accept → done)
`deploy_ready` = `deploy.capability_ok` (the CapabilityGate; SKIPPED→true when no deploy env is wired). The
`accept` decision then branches on `deploy.accepted` (the durable acceptance item): accepted → `done`
(shipped); otherwise → loop back to PLAN (never auto-ship). Get verification green, surface for accept, and the
human's `opensquid accept` finishes the run.
