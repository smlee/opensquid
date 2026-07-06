# DEPLOY — full-suite verify → guess-free fix-loop → auto commit + push

You are in the DEPLOY stage: the last stage before `done`, and the one that actually **ships**. DEPLOY is a loop
the agent drives to green: run the whole verification suite, FIX anything red in place, then commit + push. The
gate conditions are deterministic — your job is to run the real commands and act on the real results. Never ship
on red; never patch blind; never bypass the suite.

## 1. VERIFY — run the FULL project suite (the mandatory floor)

Run the project's declared verification suite — the WHOLE pre-push bar, repo-wide:

- If `.opensquid/active.json` declares a `verifySuite`, run **EXACTLY** that command (verbatim — its real exit
  code is recorded deterministically as `deploy.clean`; an ad-hoc variation is NOT captured). For opensquid that
  is `bash scripts/pre-push.sh` (`pnpm lint` → `typecheck` → `build` → `test` → `format:check`).
- If a `verifyCommand` (e2e / smoke) is also configured, run it verbatim too — it is **additive** on top of the
  suite floor (`deploy.clean = suite green AND (verifyCommand green OR unconfigured)`).
- A project that declares neither ships as today (legacy) — but any suite-bearing project MUST run its suite: an
  unconfigured `verifyCommand` no longer means "skip." The suite is the floor; the git **pre-push gate is the
  hard backstop** (a push that skipped the suite fails closed).

`deploy.clean:true` only when the suite (and any additive `verifyCommand`) came back green.

## 2. FIX-LOOP — the "proper fixing phase" (DEPLOY-LOCAL, guess-free)

When the suite is RED (`deploy.clean:false`), the `verify` decision routes you to **DEPLOY-LOCAL fixing**
(`deploy_fix`) — you stay in DEPLOY and fix in place. Do NOT route back through AUTHOR for a mechanical failure,
and do NOT ship broken:

1. **Read the real failure output** — the actual lint / type / test / build / format error, cited. No guessing.
2. **Fix the cited errors guess-free** — change exactly what the failure names; if you are not certain of the
   cause, investigate until you are (read the code, reproduce), never patch blind.
3. **Re-run the suite** (the same verbatim command) — its exit code is re-recorded. Green → `deploy_fix` advances
   → re-VERIFY → ACCEPT. Still red → repeat.

This covers **every** failure class (lint / format / type / test / build / audit), not just a `verifyCommand`.

**Bounded, never infinite.** Each RED suite re-run counts a bug-fix round. At the round cap
(`deploy.bugfix_exhausted`) the loop escalates to the human ACCEPT touchpoint instead of grinding forever —
a genuinely-unfixable failure becomes a human residual, never a silent give-up and never `--no-verify`.

**Escalate to AUTHOR ONLY for genuine design rework.** If (and only if) a red genuinely cannot be resolved
without re-authoring — the design itself is wrong, not the code — run `opensquid redesign <taskId>`. That flags
the task so the `verify` decision routes `→ AUTHOR` (re-spec the fix → code → deploy → re-verify). This is the
**narrowed** route: it is for design-level fixes, NOT for mechanical lint/type/test fixes, which you fix in place.
The flag clears automatically on a clean verify (`opensquid redesign <taskId> --clear` reverts it manually).

## 3. COMMIT + PUSH — auto, only when green (NO `--no-verify`)

When the suite is green AND the commit gate passes (the active task's 7-phase ledger is complete and the CODE
guess-free audit is `VERDICT: GUESS_FREE` for the CURRENT diff — regenerate it with `opensquid gate reaudit` if
the diff changed), **commit and push**:

```bash
git add <the exact files this task changed>   # explicit paths ONLY — never `git add -A` / `-p` / `.`
git commit -m "<type>(<scope>): <subject>"    # sole author — NO Co-Authored-By trailer (project rule)
git push                                        # the pre-push gate re-runs the suite; green → pushes
```

- **NO `--no-verify`.** The suite is genuinely green, so there is nothing to bypass; `--no-verify` is a
  human-only override, never your unblock. The commit gate independently hard-requires suite-green (belt-and-
  suspenders): a commit that skipped the suite is blocked at the gate.
- **Sole author.** The commit message carries no `Co-Authored-By` trailer (hard project rule, pack skill
  `sole-author`). Author identity is the project's configured author, nobody else.
- **Explicit paths.** `git add <paths>` names exactly the files this task touched — never a blanket `-A` (that
  would sweep unrelated drive-by changes into the task commit).
- A RED suite yields NO commit — the fix-loop (§2) owns it first. Commit is reached only from green.

## 4. ACCEPT — the human touchpoint

Once green + committed + pushed, the `verify` decision routes to ACCEPT. You CANNOT accept your own work —
acceptance is recorded ONLY by the human via `opensquid accept <taskId>` (the start-up handoff re-surfaces
waiting items), unless the project declares the deploy `reversible: true` in `.opensquid/active.json`, in which
case ACCEPT auto-advances (the acceptance audit item is still created — the auto-advance is visible in the log).
FAIL-CLOSED: absent or `false` ⇒ irreversible ⇒ the human gate holds. Do NOT set `reversible: true` for deploys
that cannot be cheaply undone.

## Gate map (deploy → verify → [deploy_fix ⇄ verify] → accept → done)

`deploy_ready = deploy.capability_ok` (the CapabilityGate; SKIPPED→true when no deploy env is wired). Then the
`verify` decision branches (first match wins): `deploy.clean` → ACCEPT; `deploy.bugfix_exhausted` (round cap) →
the human ACCEPT touchpoint; `deploy.needs_redesign` (the `opensquid redesign` flag) → AUTHOR; else (mechanical
red, under cap) → `deploy_fix` (DEPLOY-LOCAL fixing, §2). `deploy_fix` re-checks `deploy.clean`: clean → back to
`verify` → ACCEPT; red → held. The `accept` decision then branches on `deploy.accepted`: accepted → `done`
(shipped); otherwise → loop back to PLAN (never auto-ship). Get the suite green, commit + push, surface for
accept, and the human's `opensquid accept` finishes the run.
