# DEPLOY — final pre-ship verification, then the human accept

You are in the DEPLOY stage: the last guard before `done`. The gate conditions are deterministic, but you have
ONE real action here — verify, and act on anything negative. Do not ship on red. (No content rubric — this is
a verification + acceptance gate, not a content stage.)

## Do — verify, and act on the negative
- Run the pre-ship verification. If the project configures a `verifyCommand` in `.opensquid/active.json`, run
  EXACTLY that command (verbatim — its real exit code is recorded deterministically as `deploy.clean`; an
  ad-hoc variation will not be captured). Otherwise run the pre-push checklist: `pnpm typecheck` + lint +
  prettier + the test suite + `pnpm build`. All must be green.
- ACT ON ANY NEGATIVE — the FSM does this FOR you now (DBL.1): a failing verification sets `deploy.clean:false`,
  and the `verify` decision routes `bugs_found → AUTHOR` automatically — re-task the fix so it flows forward
  AUTHOR → CODE → DEPLOY and gets RE-VERIFIED, never patched blind at the ship gate. Do NOT fix it ad-hoc here
  and do NOT ship broken. The git **pre-push gate is the hard backstop** (a push that didn't complete the flow
  fails closed). This is the BUG loop — distinct from a SCOPE rejection (accept→plan).
- If verification is green (`deploy.clean:true`), the `verify` decision routes to ACCEPT — surface the work for
  the human. You CANNOT accept your own work — acceptance is recorded ONLY by the human via
  `opensquid accept <taskId>` (the start-up handoff re-surfaces waiting items).

## Gate to advance (deploy → verify → accept → done)
`deploy_ready` = `deploy.capability_ok` (the CapabilityGate; SKIPPED→true when no deploy env is wired). Then the
`verify` decision branches on `deploy.clean`: clean → `accept`; bugs → `author` (the bug-fix loop, DBL.1).
`deploy.clean` SKIPs to true when no `verifyCommand` is configured (ships as today). The `accept` decision then
branches on `deploy.accepted` (the durable acceptance item): accepted → `done` (shipped); otherwise → loop back
to PLAN (never auto-ship). Get verification green, surface for accept, and the human's `opensquid accept`
finishes the run.

**Exception — reversible deploys (`reversible: true` in `.opensquid/active.json`):** when the project declares its
deploy reversible (e.g. a feature-flag roll-out, a preview-channel push, or any change with an instant rollback
path), the `accept` decision auto-advances to `accepted` without a human `opensquid accept <taskId>`. The
acceptance audit item is still created (the trail is preserved — the auto-advance is visible in the log).
FAIL-CLOSED: absent or `false` ⇒ irreversible ⇒ the human gate holds as usual. Do NOT set `reversible: true`
for deploys that cannot be cheaply undone.
