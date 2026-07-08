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
git add <the exact files this task changed>       # explicit paths ONLY — never `git add -A` / `-p` / `.`
git commit -m "<type>(<scope>): <subject>"        # sole author — NO Co-Authored-By trailer (project rule)
git tag "<wg-id>-$(git rev-parse --short HEAD)"    # AGF.4 — lightweight ITEM marker on the green commit ("no untagged state", step 7)
git push origin <branch> --follow-tags            # push the auto/wg-<id> branch + the item tag; pre-push gate re-runs the suite
```

- **NO `--no-verify`.** The suite is genuinely green, so there is nothing to bypass; `--no-verify` is a
  human-only override, never your unblock. The commit gate independently hard-requires suite-green (belt-and-
  suspenders): a commit that skipped the suite is blocked at the gate.
- **Sole author.** The commit message carries no `Co-Authored-By` trailer (hard project rule, pack skill
  `sole-author`). Author identity is the project's configured author, nobody else.
- **Explicit paths.** `git add <paths>` names exactly the files this task touched — never a blanket `-A` (that
  would sweep unrelated drive-by changes into the task commit).
- **AGF.4 — auto-tag + branch push (the automated git-flow, `wg-732b2b68a168`).** Under the automated loop the
  item drives in its own `auto/wg-<id>` worktree (AGF.3, cut from fresh `main` by AGF.2); its terminus is
  commit + a lightweight ITEM marker tag (`<wg-id>-<shortsha>`, satisfying "no untagged state" for the item's
  work) + a push of the `auto/wg-<id>` branch with that tag (`--follow-tags`). The item marker is a NON-version
  tag — it carries NO `v<major>.<minor>.<patch>` bump. The VERSION-bearing tags are SINGLE-WRITER downstream: the
  `rc` tag at the one `stage` integration (AGF.5) and the release tag at the one `main` merge (AGF.6), both via
  the locked-prefix computer (`nextLockedTag`); the DEPLOY terminus NEVER computes an intent-from-commit bump
  (that would race all N concurrent items to the same patch). Do NOT push a version tag from here.
- A RED suite yields NO commit — the fix-loop (§2) owns it first. Commit is reached only from green.

## Emit your phase to the live status feed

At each step of the DEPLOY loop, emit the phase via the `set_loop_phase` MCP tool so the harness status line /
Monitor shows where this item is (pack-owned cadence; `wg_id` defaults to this lap's item — do not pass it):

Emit each phase with `lifecycle: "running"` on ENTER (⟳) and `lifecycle: "done"` on LEAVE (✓):

- `set_loop_phase(phase: "verify", index: 1, total: 4, lifecycle: "running")` while running the full suite (§1),
  then `set_loop_phase(phase: "verify", index: 1, total: 4, lifecycle: "done")` when it is green,
- `set_loop_phase(phase: "fix", index: 2, total: 4, lifecycle: "running")` while in the DEPLOY-LOCAL fix-loop
  (§2) (leave with `lifecycle: "done"`),
- `set_loop_phase(phase: "commit", index: 3, total: 4, lifecycle: "running")` while committing + pushing (§3)
  (leave with `lifecycle: "done"`),
- `set_loop_phase(phase: "accept", index: 4, total: 4, lifecycle: "running")` once surfaced for the human ACCEPT
  touchpoint (§4) (leave with `lifecycle: "done"`).

## 4. ACCEPT — the human touchpoint (RELOCATED to the batched PR under the automated git-flow)

**AGF.4 — the per-item human ACCEPT is REMOVED in the automated git-flow (`wg-732b2b68a168`).** The single human
gate is RELOCATED off the per-item touchpoint and onto the batched `stage → main` pull request (AGF.6): the ONLY
human action is clicking MERGE on that PR. After the item's green commit + item-tag + branch push (§3), the loop
proceeds automatically — the pushed `auto/wg-<id>` branch is auto-merged into the persistent `stage` integration
branch with the suite re-run on the merge and an `rc` tag (AGF.5), and the batched `stage → main` PR is
opened/refreshed (AGF.6). Nothing reaches `main` without the human MERGE; on merge, `main` is release-tagged
(locked-prefix patch, `0.5.N → 0.5.N+1`) and CI publishes (version-difference-guarded). The item's DEPLOY terminus
is therefore commit + item-tag + branch push — NOT a per-item human touchpoint.

Mechanically the `accept` decision AUTO-ADVANCES for this flow (opensquid declares `reversible: true` in
`.opensquid/active.json`, so the acceptance audit item is created and the decision advances without a per-item
human gate — the auto-advance is visible in the log). This is the precedent AGF.4 relocates onto: the human gate
is the PR, not the per-item accept.

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
(shipped); otherwise → loop back to PLAN (never auto-ship). Get the suite green, commit + push, surface for
accept, and the human's `opensquid accept` finishes the run.
