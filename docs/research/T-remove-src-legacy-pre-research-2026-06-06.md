# Pre-research — T-REMOVE-SRC-LEGACY (delete the frozen 0.7.x reference tree)

**Date:** 2026-06-06 · **Repo:** opensquid · **Area:** repo cleanup (tier-one)
**Origin:** the user's directive — make opensquid tier-one; remove `src.legacy` as the first
cleanup. `src.legacy/chat/` was already removed (CAT.8); this removes the REST.

---

## 1. What `src.legacy/` is, and that it is fully superseded (verified this turn)

`tsconfig.legacy.json:3-6` states it verbatim: _"src.legacy/ is frozen 0.7.x code preserved as
reference during the Phase 0 reset … and will be deleted as src/ catches up."_ src/ HAS caught up.
The 380K / 31-file tree is two clusters, each superseded by a live `src/` equivalent:

| `src.legacy/`                                                                                                                  | Superseded by                                | Evidence                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts` (old MCP server, "thin RPC client over loop-engine")                                                                | `src/mcp/server.ts`                          | `package.json` bin `opensquid-mcp → ./dist/mcp/server.js`; `index.ts` header says the TS reimpl is "gone"                                                          |
| `codex/*` (old codex impl)                                                                                                     | `src/packs/*`                                | recall: "codex format/lifecycle moved … packs are codexes"; `src/packs/discovery.test.ts:146` asserts the new system does NOT fall back to a legacy `codexes/` dir |
| `cli.ts`, `project*.ts`, `config.ts`, `recall.ts`, `scope.ts`, `claude-md.ts`, `hooks-cli.ts`, `origin.ts`, `system-export.ts` | `src/cli.ts` + `src/runtime/*` + `src/mcp/*` | `package.json` bin → `./dist/cli.js`; `src/cli.ts:209,260` comments "Replaces the legacy `node …/dist/index.js`" / "the legacy `src.legacy` chat-daemon verbs"     |

**Liveness — verified DEAD (this turn):**

- **No real imports** from `src/` or `test/`: `grep -rE "from ['\"].*src\.legacy|require\(.*src\.legacy|import\(.*src\.legacy" src/ test/` → EMPTY. Every `src.legacy` mention in `src/` is a COMMENT (several say _"we do NOT import that — src.legacy is excluded"_).
- **Not a `bin`:** all 9 `package.json` bins point at `dist/cli.js`, `dist/runtime/hooks/*`, `dist/mcp/*` — none at the old `dist/index.js`.
- **Not built:** `tsconfig.build.json:13` excludes `src.legacy/**`; no `package.json` script references it.
- **`tsconfig.legacy.json` is vestigial:** the ONLY reference to it is its own header comment (`grep -rn tsconfig.legacy . --include=*.json/sh/yml` found only the file itself). No script/CI invokes it.

## 2. Stale pointers it leaves behind (a tier-one smell)

Several `src/` comments point at `src.legacy/chat/daemon/*` paths that were ALREADY deleted in
CAT.8 — e.g. `src/runtime/agent_bridge/transport_bridge.ts:58-59`, `types.ts:31,63`,
`session_persistence.ts:24`, `chat_state.ts:23,223,365`, `chat_actions_test_step.ts:187-205`,
`mcp/chat-bridge-server.ts:551`. They reference files that no longer exist — dead pointers that
mislead a reader. Removal should scrub these to point at the live shape (or drop the reference).

## 2b. Design — remove the tree + its scaffolding + the stale pointers

- **LR.1** — `git rm -r src.legacy` (reversible via history) + delete `tsconfig.legacy.json` +
  drop the now-dead `src.legacy/**` entry from `tsconfig.build.json`'s `exclude` (it would exclude a
  non-existent dir). Verify the full gate chain (typecheck/lint/test/build/format) stays green and a
  `node dist/cli.js --help` + MCP-server smoke still work — the proof nothing hidden depended on it.
- **LR.2** — scrub the stale `src.legacy/...` comments in `src/` (§2): rewrite each to describe the
  live shape, or delete the now-meaningless pointer. Pure comments — no behavior change.
- **LR.3** — CHANGELOG + version bump; the lesson that the Phase-0 `src→src.legacy` reset is fully
  retired.

## Alternatives

| #     | Option                                                                                            | Verdict                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Leave `src.legacy/` in place                                                                      | ❌ 380K of dead, un-built, un-imported code + stale comment-pointers to deleted files — the exact "confusing dead code" that blocks tier-one. |
| B     | Keep `tsconfig.legacy.json` "for reference"                                                       | ❌ Nothing invokes it; it only type-checks a tree that's being deleted. Vestigial.                                                            |
| C     | Delete only `codex/`, keep the legacy CLI/runtime                                                 | ❌ Partial; the legacy CLI/MCP (`index.ts`, `cli.ts`) are equally superseded + dead. Half-removal leaves the smell.                           |
| **D** | **`git rm -r src.legacy` + drop tsconfig.legacy + tsconfig.build exclude + scrub stale comments** | ✅ **Chosen.** Full removal; history preserves it (recoverable); the gate chain + a CLI/MCP smoke prove no hidden dependency.                 |

## Failure modes

- **A hidden runtime consumer surfaces post-delete?** Verified none (no imports/bin/script);
  `git rm` keeps full history, so a surprise is recoverable by revert. The full suite + a
  `dist/cli.js`/MCP smoke after deletion is the fail-closed check.
- **`tsconfig.build.json` exclude removal breaks the build?** The exclude points at a dir that will
  no longer exist — removing the entry is inert; the build compiles `src/**` regardless. Verified by
  the post-removal `pnpm build`.
- **A stale-comment scrub accidentally changes behavior?** Comments only — `pnpm test`/`build`
  unaffected; the diff is comment-only and reviewable.
- **The daemon (running from the old `dist/`)?** The chat-daemon now runs from `src/channels` (the
  CAT cutover); `src.legacy/chat` is already gone, so no live daemon reads `src.legacy`.

## Empirical spikes

The liveness audit IS the spike, done this turn: the import/bin/script/tsconfig greps + reading
`index.ts` (old MCP server) + `tsconfig.legacy.json` (self-documented "delete as src/ catches up") +
the `discovery.test.ts` no-legacy-codex-fallback assertion. The final proof is mechanical: after
`git rm`, the full gate chain (3120+ tests, build) stays green and a CLI/MCP smoke runs — if
anything hidden depended on it, that goes red.

## 6. Decomposition

- **LR.1** — `git rm -r src.legacy` + delete `tsconfig.legacy.json` + drop the `src.legacy/**`
  exclude from `tsconfig.build.json`; verify gate chain + CLI/MCP smoke.
- **LR.2** — scrub the stale `src.legacy/...` comments in `src/` (§2).
- **LR.3** — CHANGELOG + version bump.

No unresolved scoping items — the tree is verified dead (no imports/bin/build/script; superseded by
live `src/` equivalents), and the removal is reversible via history with a green-gate-chain proof.
