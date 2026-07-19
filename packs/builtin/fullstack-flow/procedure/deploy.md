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
branch="$(opensquid gate branch)" || exit 1             # fail before mutation unless env.local/default matches checkout
git add <the exact files this task changed>       # explicit paths ONLY — never `git add -A` / `-p` / `.`
git commit -m "<type>(<scope>): <subject>"        # sole author — NO Co-Authored-By trailer (project rule)
git push --no-follow-tags origin "HEAD:refs/heads/$branch" # explicit refspec; pre-push gate re-runs the suite
```

- **NO `--no-verify`.** The suite is genuinely green, so there is nothing to bypass; `--no-verify` is a
  human-only override, never your unblock. The commit gate independently hard-requires suite-green (belt-and-
  suspenders): a commit that skipped the suite is blocked at the gate.
- **Sole author.** The commit message carries no `Co-Authored-By` trailer (hard project rule, pack skill
  `sole-author`). Author identity is the project's configured author, nobody else.
- **Explicit paths.** `git add <paths>` names exactly the files this task touched — never a blanket `-A` (that
  would sweep unrelated drive-by changes into the task commit).
- **Push the already-selected semantic local branch.** The explicit `HEAD:refs/heads/$branch` refspec pushes the
  commit from the current checkout without inventing another ref. The current serial coordinator selects
  `version-control.environments.local` (default: the existing current branch), and the equality check fails closed
  if configuration and checkout diverge. Parallel worktrees are a named GF.9 deferral (`wg-7e48d5fa5d70`): before
  any future parallel coordinator is enabled, it must explicitly select a unique semantic branch and carry that
  branch and checkout cwd through every stage. It must never derive the ref from a WorkGraph ID. WorkGraph owns
  item identity and commit evidence, while Git refs describe the work.
- **No per-item tag.** DEPLOY creates no WorkGraph-derived marker and explicitly uses `--no-follow-tags` so local
  `push.followTags=true` configuration cannot re-enable tag fan-out. Verified
  2026-07-19 against the installed Git 2.50.1 primary manuals: `git-push(1)` says the option also pushes missing
  annotated tags reachable from the ref being pushed, so it can publish an unrelated tag; `git-tag(1)` says
  annotated tags are intended for releases while lightweight tags are private/temporary labels. This flow
  therefore reserves Git tags for meaningful version boundaries: the
  single-writer RC tag on a green staging integration and the release tag at the production merge. DEPLOY itself
  creates and pushes neither.
- A RED suite yields NO commit — the fix-loop (§2) owns it first. Commit is reached only from green.

## (Optional) emit your sub-phase to the live feed

This stage ALREADY appears on the live status feed at STAGE granularity via the enforced `stage_advance` (it is
never silent). OPTIONAL: at each step of the DEPLOY loop you MAY emit the phase via the `set_loop_phase` MCP tool
— `lifecycle: "running"` on ENTER (⟳), `lifecycle: "done"` on LEAVE (✓) — a nicety, not what makes the stage
appear (pack-owned cadence; `wg_id` defaults to this lap's item — do not pass it):

- `set_loop_phase(phase: "verify", index: 1, total: 4, lifecycle: "running")` while running the full suite (§1),
  then `set_loop_phase(phase: "verify", index: 1, total: 4, lifecycle: "done")` when it is green,
- `set_loop_phase(phase: "fix", index: 2, total: 4, lifecycle: "running")` while in the DEPLOY-LOCAL fix-loop
  (§2) (leave with `lifecycle: "done"`),
- `set_loop_phase(phase: "commit", index: 3, total: 4, lifecycle: "running")` while committing + pushing (§3)
  (leave with `lifecycle: "done"`),
- `set_loop_phase(phase: "accept", index: 4, total: 4, lifecycle: "running")` once surfaced for the human ACCEPT
  touchpoint (§4) (leave with `lifecycle: "done"`).

## 4. ACCEPT — the human touchpoint (RELOCATED to the production PR under the automated git-flow)

For a configured automated git-flow, the per-item human ACCEPT is removed and the single human gate is the
production pull request. After the item's green commit is pushed on the configured semantic local branch (§3),
routing is derived only from `version-control.environments`:

- with `staging`, the local branch is integrated into the configured staging branch, the suite is re-run on that
  integration, one RC version tag is created on green, and the staging → production PR is opened or refreshed;
- without `staging`, the local → production PR is opened or refreshed directly.

Nothing reaches production without the human MERGE. That merge creates the meaningful release version tag and CI
publishes when configured. No WorkGraph-ID branch or per-item tag participates in either route; the item's DEPLOY
terminus is the green commit pushed on the semantic local branch.

Mechanically the `accept` decision auto-advances when the configured environment makes deploy reversible; the
auto-advance remains visible in the log. The human gate is the production PR, not a per-item acceptance prompt.

For a NON-automated project (no worktree/stage/PR flow) the classic rule still holds: you CANNOT accept your own
work — acceptance is recorded ONLY by the human via `opensquid accept <taskId>` — UNLESS the project declares the
deploy `reversible: true`, in which case ACCEPT auto-advances. FAIL-CLOSED: absent or `false` ⇒ irreversible ⇒ the
human gate holds. Do NOT set `reversible: true` for deploys that cannot be cheaply undone.

## Gate map (deploy → verify → [deploy_fix ⇄ verify] → accept → done)

`deploy_ready = deploy.capability_ok` (the CapabilityGate; SKIPPED→true when no deploy env is wired). Then the
`verify` decision branches (first match wins): `deploy.clean` → ACCEPT; `deploy.bugfix_exhausted` (round cap) →
the human ACCEPT touchpoint; `deploy.needs_redesign` (the `opensquid redesign` flag) → AUTHOR; else (mechanical
red, under cap) → `deploy_fix` (DEPLOY-LOCAL fixing, §2). `deploy_fix` re-checks `deploy.clean`: clean → back to
`verify` → ACCEPT; red → held. The `accept` decision then branches on `deploy.accepted`: accepted → `done`
(shipped); otherwise → loop back to PLAN (never auto-ship). Get the suite green, commit, and push the
configured semantic local branch; the configured acceptance route then finishes the run.
