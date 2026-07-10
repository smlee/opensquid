# Config-Driven Git-Flow Integration (Design of Record)

This document is the design of record for the config-driven git-flow that the automated loop runs after an item ships.
It corresponds to task `T-gitflow-integration-fix` (tasks GF.1 through GF.10) and describes the SHIPPED reality, not a plan.
Every symbol cited below exists at HEAD in the module named beside it.

## Overview

Before this work the loop carried hardcoded `main`/`stage` branch literals and a destructive stage-integration path that could reset the main checkout and lose loop work.
The fix makes the entire post-ship flow derive from a single per-project config block, `version-control.environments` in `active.json`, so no core module carries a literal branch name.
Presence of a `staging` branch in that block IS the has-stage toggle — there is no separate `enabled` flag.
A project that has not configured the block is simply not on the automated git-flow and ships exactly as it did before (every routing element skips its hop).

The flow has seven live mechanisms plus one deferred one:
the config vocabulary and its setup elicitation (GF.1);
the deterministic reader (GF.1);
the has-stage / no-stage route (GF.3);
the worktree-isolated stage integration (GF.4);
the per-item consistency gate keyed to the configured target (GF.2);
the whoever's-ahead base reconcile (GF.5/GF.6);
the idempotent auto-PR (GF.7);
the environments-derived reversibility boundary (GF.8);
and the deferred, dormant parallelism (GF.9).

## 1. The config vocabulary and its setup elicitation

The config lives under the hyphenated on-disk key `version-control` in `active.json`; a `versionControl` camelCase alias is also accepted.
The block's shape is defined by `VersionControlConfig` and `EnvironmentsConfig` in `src/packs/discovery.ts`.
`EnvironmentsConfig` has exactly three fields: `production` (required — the PR base and the reconcile base), `staging?` (optional), and `local?` (optional).
The values are branch-name strings only; no core module carries a literal `main` or `stage`.
Presence of `staging` is the ONLY has-stage signal — there is deliberately no `enabled` boolean.

The block is written by the setup elicitation command `opensquid setup wizard environments`, wired in `src/setup/cli/hooks.ts`.
`writeEnvironmentsElicitation` reads the existing `active.json`, folds the new values in via `mergeEnvironmentsBlock` (which preserves `packs`/`verifySuite`/other keys), and writes it back.
The write is automation-safe: under `OPENSQUID_AUTOMATION` the on-disk block is NEVER clobbered — the command reports `environments: skipped (OPENSQUID_AUTOMATION — on-disk block kept)` and leaves the file untouched.

## 2. The deterministic reader

`resolveEnvironments(scopeRoot)` in `src/packs/discovery.ts` is the single reader every routing element consumes; its output contract is `ResolvedEnvironments`.
It reads `version-control.environments` and validates `production`: an absent, empty, or unreadable/malformed `production` yields `null`, which means the project is not on the automated flow and ships as today.
When the block is valid it always resolves `local`: if `local` is unset the reader falls back to the current branch via `git rev-parse --abbrev-ref HEAD` (defaulting to `HEAD` if even that fails).
`staging` is passed through only when configured, so `env.staging !== undefined` is the has-stage predicate for every downstream element.
The reader performs pure reads with no mutation.

## 3. The has-stage / no-stage route

`routeOnShipped(env, deps)` in `src/runtime/ralph/route_on_shipped.ts` is the total, fail-visible route the loop's `onShipped` runs after a SHIPPED item.
Its injected effects are typed by `RouteDeps` and its discriminated result by `RouteResult`; the caller is guaranteed to pass a non-null `env` (the wiring no-ops when `resolveEnvironments` returns null).

The route branches purely on `env.staging`:

- has-stage (`env.staging` set) → integrate the item's work into `staging` via `RouteDeps.integrateToStaging`, then ensure the staging→production PR; the result is `routed: 'staged'`.
- no-stage (`env.staging` undefined) → ensure the loop-branch (`local`) → production PR directly via `RouteDeps.ensureProductionPr`; the result is `routed: 'direct'`.

A genuine integration failure is surfaced, never swallowed: the has-stage branch returns `{ routed: 'staged', integrated: false, reason: 'stage-integration-failed' }` when `integrateToStaging` reports `integrated: false`.
Because the failure leaves no durable commit on the target, the consistency gate (section 4) then blocks the SHIPPED close — the fail-open swallow that once caused a phantom-ship bug is not reintroduced.

The production wiring lives in `src/setup/cli/ralph.ts`: `onShipped` resolves the environments, and when non-null calls `routeOnShipped`, binding `integrateToStaging` to the `integrateBranchToStage` SSOT and `ensureProductionPr` to the GF.7 function.
The route call itself is wrapped fail-open so an infra fault (for example missing `gh` auth) is logged live but never breaks the drain — the consistency gate still blocks the close.

## 4. The worktree-isolated stage integration (GF.4)

`mergeToStage(branch, stageBranch, rcTag, mainRoot, io)` in `src/runtime/release/stage_integration.ts` is the destructive-context fix at the heart of has-stage integration.
Its git effects are behind the injected `StageIo` seam.
The staging branch is created from the base on first use if absent, so integration always runs.

The critical fix: the checkout, merge, and any rollback reset run in the staging branch's OWN worktree, computed by `stageWorktreePath(mainRoot, stageBranch)`, NEVER in the main checkout.
The original bug ran `checkout stage` + `merge` + `reset --hard HEAD~1` in `mainRoot`, which checked the main tree away from the loop branch and reset it — work loss.
The dedicated worktree physically isolates the destructive ops to a separate directory, so loop work in the main checkout is never lost.
On a clean merge that passes the suite, `mergeToStage` `rc`-tags the green integration and returns `{ integrated: true }`; a conflict (aborted) or a red suite (rolled back in the worktree so `stage` stays green for the next item) returns `{ integrated: false }` with no tag, and the item re-drives from fresh base.

## 5. The per-item consistency gate keyed to the configured target (GF.2)

`durableItemCommitExists(git, baseSha, targetRef?)` in `src/runtime/ralph/consistency_gate.ts` is the predicate that makes SHIPPED honest.
Its git effects are behind the injected `RalphGitSeam`, with the real binding produced by `makeRalphGitSeam(cwd)`.
The predicate resolves the tip and the committed set on the configured integration target when `targetRef` is given (falling back to `HEAD` when it is not).

The orchestrator wires it in `src/runtime/ralph/orchestrator.ts`.
Before driving a claimed item it computes the target as `deps.environments ? (deps.environments.staging ?? deps.environments.local) : undefined` and records `baseSha` on that target's tip.
After a SHIPPED lap it loops on `durableItemCommitExists(deps.git, baseSha, target)`: a ship with no durable item commit reachable on the configured target is re-driven up to `MAX_COMMIT_REDRIVES` (2), then parked with reason `NO_DURABLE_COMMIT_LABEL` (`no-durable-commit`) — never silently closed.
Thus SHIPPED holds if and only if a durable item commit is reachable on the configured integration target (`staging ?? local`), or on `HEAD` for an unconfigured project (byte-identical to the prior base gate).
There is deliberately no separate `integration-failed` park reason: a failed integration manifests as a missing durable target commit, which the same gate already catches.

## 6. The whoever's-ahead base reconcile (GF.5/GF.6)

`reconcileBase(cwd, production, remote, io)` in `src/runtime/ralph/auto_pull.ts` reconciles the local base branch with origin, preserving whoever is ahead.
Its git effects are behind the injected `ReconcileIo` seam, which deliberately has NO reset or rebase method — discarding or rewriting pushed history is unrepresentable by construction.
The base branch NAME is always `environments.production` (config-driven), never a hardcoded `main`.
The outcome is the `ReconcileOutcome` union, a total four-state FSM over `(behind, ahead)`:

- `(0, 0)` → `up-to-date` (no-op).
- `(behind>0, 0)` → origin ahead → `fast-forwarded`.
- `(0, ahead>0)` → local ahead → `kept-local` (the local hot patch stays).
- `(behind>0, ahead>0)` → diverged → `merged` (MERGE origin into the base, preserving BOTH sides).

A merge conflict is aborted and returned as `{ kind: 'conflict' }` — the loop surfaces it to a human and never auto-picks a side.
Because there is no reset or rebase, a hot patch pushed straight to production is pulled into the base and can never be reverted by a later PR (durability first).

This reconcile runs LIVE once per pass via `RalphDeps.baseRefresh?` in `src/runtime/ralph/orchestrator.ts`: before driving, the orchestrator calls `deps.baseRefresh()`, and a `conflict` outcome surfaces to a human (escalated, base left unchanged, drive continues on the un-refreshed base) while transient fetch faults fail open.
The CLI binds it in `src/setup/cli/ralph.ts` as `baseRefresh: () => reconcileBase(root, environments.production)`, present only when the environments block is configured.

## 7. The idempotent auto-PR (GF.7)

`ensureProductionPr(env, cwd, io)` in `src/runtime/release/stage_pr.ts` ensures exactly ONE integration → production PR is open, idempotently.
Its `gh` effects are behind the injected `GhIo` seam; the idempotency probe is `GhIo.prView(head, base, cwd)`, which runs `gh pr view <head> --json url` and returns the url or `null`.
The head is `env.staging ?? env.local` (config-driven) and the base is `env.production` — no hardcoded `main`/`stage`.
`prView` runs first: an existing PR is a no-op (its url is returned and GitHub auto-tracks later pushes); otherwise `prCreate` opens one.
Missing `gh` auth throws `GhAuthError` — surfaced, never swallowed.

This path NEVER merges: the human MERGE in the GitHub UI is the SOLE gate, and that click triggers the existing CI (`release-tag.yml` then `publish.yml`) which tags and publishes on merge, UNCHANGED by this work.

## 8. The environments-derived reversibility boundary (GF.8)

`reversibilityBoundaryFor(env)` in `src/packs/discovery.ts` derives the reversibility boundary from the environments block rather than an ad-hoc flag: a project on the automated git-flow (`env !== null`) has a reversible DEPLOY stage.
The commit and push to a working branch, the merge to staging, and opening the PR are all revertable; the SOLE irreversible act is the human PR-merge to production (which triggers the CI publish).
`readActiveDeployReversible` treats the environments-derived boundary as the source of truth and consults the legacy explicit `reversible` flag only for a project NOT on the `version-control.environments` block.
Consequently the executor never classifies a git-flow branch-push as an irreversible boundary — has-stage/no-stage is one config-derived boundary, not a separate flag checked ad hoc.

## 9. Deferred parallelism (GF.9)

Per-item parallelism is DEFERRED and kept dormant.
The `worktree_pool` module in `src/runtime/ralph/worktree_pool.ts` (its `WorktreeIo` seam and the `drainPool` bounded-concurrency drainer) is KEPT but not wired live — `drainPool` has no live caller outside its own module and tests.
This is the config-gated, additive follow-on: `staging` is the serial-landing point that catches conflicts today, and `featBranchFor(title)` in `src/runtime/ralph/auto_pull.ts` (which produces `feat/<slug>` via `slugify`) is the per-item semantic branch name the parallel path will use when it is wired.

## Environment states

The config block resolves to one of four states, and every routing element behaves accordingly:

- No config (block absent, or `production` missing/malformed) — `resolveEnvironments` → `null`.
  The project is not on the automated git-flow; every hop is skipped and it ships as today.
  The reversibility boundary falls back to the legacy `reversible` flag.
- Production only (`production` set, no `staging`, no `local`) — no-stage route.
  `local` resolves to the current branch; `onShipped` opens the loop-branch → production PR directly; the consistency gate targets `local`; the base reconcile runs on `production`.
- Production + staging (`staging` set) — has-stage route.
  `onShipped` integrates the item's work into `staging` via the worktree-isolated `mergeToStage`, then ensures the staging → production PR; the consistency gate targets `staging`.
- Production + local (`local` set explicitly) — same route as its `staging` presence dictates, but `local` is taken from config instead of the current branch.
  When `staging` is absent this is the no-stage route with a pinned loop branch; when `staging` is present it is the has-stage route.

## Open-question resolutions

- Q1 — the `<type>` prefix for per-item branches: DEFERRED with GF.9.
  The per-item semantic name is `feat/<slug>` (`featBranchFor`) today; a richer `<type>` prefix is folded into the deferred parallelism follow-on.
- Q2 — the consistency predicate: LOCKED.
  The gate is config-target-aware (`durableItemCommitExists` with `targetRef = staging ?? local`) and there is NO separate `integration-failed` reason — a failed integration surfaces as a missing durable target commit that the same gate catches.
- Q3 — the config vocabulary: LOCKED.
  `production` is required; presence of `staging` is the has-stage toggle (no `enabled` flag); `local` defaults to the current branch when unset.
- Q4 — the diverged reconcile: LOCKED.
  A diverged base is reconciled by MERGE (preserving both sides), never by rebase or reset; a conflict is surfaced to a human and never auto-resolved.
