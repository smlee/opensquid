# Project-local state bootstrap — one-time entry for the FIRST local store

OpenSquid's workgraph, ralph loop, and checkpoints have moved from a global `~/.opensquid/` store to a **project-local** `<repo>/.opensquid/` store, discovered by walking up from cwd exactly how `git` finds `.git`.
This runbook is the one-time manual entry that lands opensquid's own repo onto its fresh local board.

Design of record: `loop/docs/design/opensquid-project-local-state.md` (§6.1 start-fresh, §6.4 bootstrap ordering).
Task spec: `docs/tasks/T-project-local-state.md` (PLS.6).

## Why a one-time manual entry is needed

opensquid is the FIRST project to get a project-local store, and **this very change fixes the connection the loop uses to run**.
A normal work item enters the loop through the workgraph, but the workgraph resolution is precisely what PLS.1..PLS.5 rewrite — so the item that builds the local store cannot ride the path it is still building.
The resolution is a one-time MANUAL bootstrap: land the code, then hand-enter this work onto the newly-resolvable local board.

This is expected by the design (§6.4), not a hack.
Do NOT try to auto-enter the bootstrap through the very path it is fixing — enter it by hand this once, and every item after it rides the fixed loop normally.

## Ordering — run ONLY after PLS.1..PLS.5 land

PLS.6 `depends on` PLS.5, which `depends on` PLS.2/PLS.3, which `depend on` PLS.1.
Run this runbook only once all of PLS.1..PLS.5 have landed and store resolution is fully cut over.
Bootstrapping against a half-cutover store resolves against two coexisting models at once — the exact confusion this scope removes (design §7).
The single acceptance check before you start: `resolveProjectRoot` / `resolveLocalStoreDir` (`src/runtime/paths.ts`) resolve `<repo>/.opensquid/`, and no IN opener still opens `${OPENSQUID_HOME()}/workgraph.db`.

## The sequence

```bash
pnpm build                 # lands PLS.1..PLS.5 — the local-store resolution
```

Building compiles the cutover: the loop, the MCP server, and the interactive session now resolve `<repo>/.opensquid/` locally (git-`.git` style) via the new `resolveProjectRoot` / `resolveLocalStoreDir` in `src/runtime/paths.ts`, instead of the global `~/.opensquid/`.

```bash
opensquid status           # from INSIDE the opensquid repo
```

Run from inside the opensquid repo, `opensquid status` now reads the LOCAL board at `<repo>/.opensquid/`.
On first run this board is **empty** — that is correct.
Start-fresh means the fresh local store begins with zero rows; there is no migration, import, or replay (design §6.1).

Recreate the loop-status item on the fresh local board:

```
workgraph_create_issue(... "T-loop-status-feed" ...)   # the wg-02381103013f work, RECREATED
```

The loop-status item (`wg-02381103013f`, "T-loop-status-feed") is **recreated**, not migrated.
Its scope and its `docs/loop-status-feed.md` persist in the tree, so the recreated issue reuses the existing grounding — you author a fresh issue against the persisted scope, you do not port rows from the global store.
Start-fresh deliberately abandons the global board (design §6.1), so there is nothing to migrate FROM — the item is entered anew.

Once the recreated item is on the LOCAL board, the loop drains it normally; the manual bootstrap is complete and no future item needs it.

## The global board is deliberately abandoned

The global `~/.opensquid/workgraph.db` board is intentionally left behind — it is not migrated, exported, or replayed (design §6.1).
The only real deliverable that ever lived on it, the reporting work, is **already committed at `7b66683`** ("feat(fullstack-flow): mandatory reporting enforcement"), so nothing of value is stranded.
The remaining global-board rows are phantom scope-seed garbage plus the mis-projected loop-status item, all disposable.
Abandoning the global board is the point: a project-local store makes the namespace mismatch structurally impossible, and keeping a live global board alongside it would reintroduce the two-model coexistence this scope removes.

Note: RAG/recall (memories) and the always-on cross-project daemon's `audit_log` stay GLOBAL by design (§4 OUT) — only the workgraph, ralph loop, and checkpoint/loop tables go project-local.
This runbook concerns only the project-local board; the global OUT stores are untouched.
