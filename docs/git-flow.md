# Git-flow integration (config-driven, fail-visible)

OpenSquid’s automated git-flow architecture is simple:

**isolate work → accumulate on an integration branch → one human-gated PR to the trunk.**

This document is the design-of-record for the **integration wiring** (not the architecture itself).

## Config: `version-control.environments`

In project `.opensquid/active.json`:

```json
{
  "version-control": {
    "environments": {
      "production": "main",
      "staging": "stage",
      "local": "local"
    },
    "versioning": {
      "strategy": "locked-prefix",
      "prefix": "0.5",
      "bump": "patch-per-release"
    }
  }
}
```

| Key          | Required | Meaning                                                                |
| ------------ | -------- | ---------------------------------------------------------------------- |
| `production` | **yes**  | Trunk. Human MERGE is the only way here. CI tags + publishes on merge. |
| `staging`    | no       | Protection layer. **Presence is the has-stage toggle.**                |
| `local`      | no       | Serial work / accumulation base. Defaults to `production` when unset.  |

Elicit at setup:

```bash
opensquid setup wizard version-control
```

## Deterministic route (one path)

```
if staging set:
  land item on staging  →  ensure PR(staging → production)
else:
  land item on local    →  ensure PR(local → production)
```

No separate `enabled` flag. No dual code designs.

## Consistency gate

An item is closed **SHIPPED** if and only if:

1. The lap/FSM reported SHIPPED (work plane — pack DEPLOY owns commit+push), **and**
2. The item’s durable commit is **reachable on the configured target** (`staging` if set, else `local`), **and**
3. The auto-PR `prHead → production` is ensured open (fail-visible on `gh` errors).

SHIPPED does **not** mean “merged to production.” That is the human gate.

Failed integration is never swallowed:

- bounded re-drive, then park with reason `INTEGRATION_FAILED`.

## Stage worktree context

When `staging` is set, merge/suite/reset run in a dedicated worktree
(`<repo>/.opensquid/git/stage-wt`), **never** by checking out `stage` on the main working tree.

## Base refresh (hot-patch safe)

Against `environments.production` (or the configured base):

| Situation        | Action                    |
| ---------------- | ------------------------- |
| origin ahead     | fast-forward              |
| local ahead      | keep local                |
| diverged         | **merge** (preserve both) |
| content conflict | surface to human          |

Never `--ff-only` reject-as-fault. Never reset/rebase away commits.

## Auto-PR

`ensurePr` = `gh pr view || gh pr create` for `head → base`. Idempotent. Never auto-merges.

`opensquid release` is a **manual** trigger of the same ensure-PR (no direct merge, no local publish).

## Semantic branches

- Environment branches are user-named (`production` / `staging` / `local`).
- Serial: items commit on `local` (no per-item branch).
- Parallelism (deferred): per-item `feat/<slug-of-title>`; `worktree_pool` stays **dormant**.

## Modules (SRP + composition)

| Module                 | Role                                |
| ---------------------- | ----------------------------------- |
| `version_control.ts`   | Read/resolve environments           |
| `base_refresh.ts`      | Whoever’s-ahead reconcile           |
| `stage_integration.ts` | Land onto staging in stage worktree |
| `ensure_pr.ts`         | Idempotent open PR                  |
| `integration_gate.ts`  | SHIPPED consistency gate            |
| `orchestrator.ts`      | Close only after gate               |

## Parallelism (deferred)

`worktree_pool` / `drainPool` stay kept but unwired. Turning concurrency on later is additive:

- worktree per item + `feat/<slug>`
- serial land into `local` / `staging`
- store env-override so worktrees share one workgraph
- cwd threaded through the drive path
