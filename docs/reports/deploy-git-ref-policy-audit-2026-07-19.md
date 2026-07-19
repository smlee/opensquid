# DEPLOY Git-ref policy correction — verification record (2026-07-19)

## Scope and before-coding verification

User correction: WorkGraph IDs are internal fullstack-flow context, not Git branch or tag names. Current execution is serial and must commit/push the configured semantic local branch. Git tags are reserved for meaningful RC/release versions.

Before editing, the current tree was re-read rather than trusting the historical AGF task:

- `src/runtime/ralph/auto_pull.ts:3-7` already declared mechanical WorkGraph-id branches retired and serial work assigned to `environments.local`.
- `src/packs/discovery.ts:325-351` already resolved an omitted `environments.local` to the checked-out branch.
- `src/setup/cli/ralph.ts:515-560` and `src/runtime/ralph/route_on_shipped.ts:34-49` already routed the serial local branch through configured staging/production.
- The original ignored historical AGF record still showed the stale worktree branch at `docs/tasks/T-opensquid-automated-gitflow.md:324-335`; the later policy explicitly superseded it at `docs/tasks/T-gitflow-integration-fix.md:459-469`. Before this correction the tracked DEPLOY procedure and fixtures still followed the former. The corrected procedure is now at `packs/builtin/fullstack-flow/procedure/deploy.md:47-80`.
- Project-local `.opensquid/active.json` still pinned obsolete `feat/v2-enforcement`; removing `local` restored the existing-current-branch default defined at `src/packs/discovery.ts:339-346`.

This confirmed a stale-policy cleanup, not a new Git-flow design.

## Primary documentation consultation

The installed primary manuals for the Git version actually executing here were read locally:

```text
git version 2.50.1 (Apple Git-155)
MANPAGER=cat man git-push
MANPAGER=cat man git-tag
```

Verified semantics:

- `git-push(1)`: an explicit `<src>:<dst>` refspec names the exact remote ref to update.
- `git-push(1)`: `--follow-tags` additionally pushes missing annotated tags reachable from pushed refs; `--no-follow-tags` overrides `push.followTags=true`.
- `git-tag(1)`: annotated tags are intended for releases; lightweight tags are private or temporary labels.

Therefore DEPLOY uses an explicit semantic branch refspec plus `--no-follow-tags`, creates no WorkGraph marker tag, and leaves RC/release tags to their existing single-writer boundaries.

External primary-document consultation was completed against Git's official HTTPS documentation on 2026-07-19. The harness's SSRF-safe `web_fetch` first failed before retrieval with `Invalid IP address: undefined`, so a bounded `curl --proto '=https' --tlsv1.2 --location --max-time 30` fallback retrieved `https://git-scm.com/docs/git-push` (158,400 bytes, SHA-256 `e25f177274ec13785da6ccdcf157970a6d12d8ff265bc1a3ec5f92a5ca567a15`) and `https://git-scm.com/docs/git-tag` (91,724 bytes, SHA-256 `a11ca3fffcad58e2cdff9f4d29d777dc1af9cfae94db2ad8e19c69a3fe52b161`). The fetched push page documents `--no-follow-tags`; the fetched tag page states that annotated tags are for releases while lightweight tags are private or temporary. Those external primary sources corroborate the exact local-manual claims above; behavioral tests remain the executable proof.

## Existing-solution and AUTHOR re-check

The final implementation reuses, rather than duplicates:

- `resolveEnvironments` (`src/packs/discovery.ts:333-351`) for the current serial `local` branch; `configuredLocalBranch` calls that reader and verifies checkout equality (`src/setup/cli/gate.ts:488-501`).
- `routeOnShipped` (`src/runtime/ralph/route_on_shipped.ts:34-49`) for staging-present versus direct-production routing.
- `featBranchFor` only as a proof-backed dormant helper for future parallel design (`src/runtime/ralph/auto_pull.ts:26-29`); the dormant pool requires a caller-supplied branch (`src/runtime/ralph/worktree_pool.ts:65-83`).

The prior AUTHOR source explicitly ended `VERDICT: GUESS_FREE` at `../docs/research/opensquid-gitflow-integration-fix-pre-research-2026-07-08.md:80-87`; that newer decision already superseded the mechanical branch scheme. The older AGF item/tag policy was the stale source. Current parallel worktree routing is not complete end to end, so it was not partially activated: the live orchestrator remains serial. Authoritative WorkGraph lookup on 2026-07-19 verified open issue `wg-7e48d5fa5d70`, titled “Implement semantic parallel worktree routing end to end,” records the named GF.9 deferral requiring unique semantic branch and cwd propagation through all future parallel boundaries; it is related to in-progress correction item `wg-95f8fd49c17d`.

## After-coding audit and verification

Adversarial CODE audit findings were applied rather than waived:

- explicit `--no-follow-tags` now prevents local Git config from restoring tag fan-out;
- `opensquid gate branch` executes the existing environment resolver and requires configured `environments.local` to equal the checked-out branch before push (`src/setup/cli/gate.ts:488-501`, `packs/builtin/fullstack-flow/procedure/deploy.md:53-57`);
- broken partial parallel attachment was removed from the live serial orchestrator;
- dormant worktree requirements are proof-only and carry a named end-to-end deferral;
- behavioral route coverage verifies the configured semantic local branch reaches both environment routes;
- first-use staging creation now derives its base from configured `environments.production`, rather than hard-coded `main` (`src/runtime/release/stage_integration.ts:98-110`).

Verification:

- focused policy, route, worktree, orchestrator, release, auto-pull, and coverage tests passed;
- authoritative dirty-tree suite: lint, typecheck, build, **5,809 passed / 23 skipped**, format check;
- isolated task-only suite: lint, typecheck, build, **5,833 passed / 23 skipped**, format check;
- tracked live sources contain no WorkGraph-derived Git branch producer; only explicit historical-retirement text and negative regression assertions retain the old spelling;
- no local or remote `auto/wg-*` or WorkGraph-marker ref remains.
