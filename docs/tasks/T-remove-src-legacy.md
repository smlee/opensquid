# Track T-REMOVE-SRC-LEGACY — delete the frozen 0.7.x reference tree

**Pre-research:** `docs/research/T-remove-src-legacy-pre-research-2026-06-06.md`.

**Principle:** Simplicity — `src.legacy/` is verified-dead (no imports/bin/build/script; superseded
by live `src/` equivalents). Tier-one means no confusing dead code or stale pointers. Order:
LR.1 → LR.2 → LR.3.

---

### Task LR.1: remove `src.legacy/` + its scaffolding

**Required skills:** opensquid build/tsconfig expert; dead-code-removal expert; CLI/MCP smoke-test expert; Audit expert.
**Deliverable:** `src.legacy/` deleted; `tsconfig.legacy.json` deleted; the `src.legacy/**` entry
dropped from `tsconfig.build.json`'s `exclude`; full gate chain + a CLI/MCP smoke stay green.
**Depends on:** None.

**Files affected:**

- `src.legacy/**` (delete) — `git rm -r src.legacy` (reversible via history).
- `tsconfig.legacy.json` (delete) — vestigial; nothing invokes it.
- `tsconfig.build.json` (modify) — drop `"src.legacy/**"` from `exclude` (it would exclude a non-existent dir).

**Key code shapes:**

```bash
git rm -r src.legacy && git rm tsconfig.legacy.json
# tsconfig.build.json: "exclude": ["src/**/*.test.ts", "test/**"]   (drop "src.legacy/**")
node dist/cli.js --help >/dev/null   # CLI smoke
```

**Test fixtures:** the full suite is the proof (no test imports `src.legacy`); a `dist/cli.js --help`

- MCP-server start smoke confirms no runtime dependency.
  **Acceptance criteria:**

* [ ] `src.legacy/` gone; `grep -rn "from .*src\.legacy" src/ test/` → empty (already true)
* [ ] `tsconfig.legacy.json` gone; `tsconfig.build.json` exclude no longer lists `src.legacy/**`
* [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check` green
* [ ] `node dist/cli.js --help` runs; MCP server starts

**Risk callouts:** THE irreversible-looking slice — but `git rm` keeps history (recoverable). Confirm
no NON-legacy code imports it (verified empty) before deleting. Don't touch `tsconfig.json` (root) —
only the build + legacy configs.
**References:** `tsconfig.legacy.json` (self-documents "delete as src/ catches up"); `tsconfig.build.json:13`; the pre-research liveness audit.
**Verification commands:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check && node dist/cli.js --help`.
**7-phase steps:** 1 pre-research DONE. 2 learn: confirm no remaining consumer (done). 3 code: git rm + tsconfig edits. 4 test: full suite + CLI smoke. 5 audit: grep clean, build green. 6 n/a. 7 fix.

---

### Task LR.2: scrub stale `src.legacy/...` comment-pointers in `src/`

**Required skills:** opensquid docs/comment expert; Audit expert.
**Deliverable:** the `src/` comments that point at the already-deleted `src.legacy/chat/daemon/*`
(and other `src.legacy` paths) are rewritten to describe the live shape or dropped — no dead pointers.
**Depends on:** LR.1.

**Files affected (comment-only):**

- `src/runtime/agent_bridge/transport_bridge.ts` (:58-59), `types.ts` (:31,63), `session_persistence.ts` (:24), `event_bus.ts` (:7)
- `src/setup/cli/chat_state.ts` (:23,223,365), `chat_actions_test_step.ts` (:187-205)
- `src/mcp/chat-bridge-server.ts` (:551), `src/runtime/chat/watch.ts` (:13), `src/cli.ts` (:260)

**Key code shapes:** rewrite e.g. `// Mirrors src.legacy/chat/daemon/inbox.ts InboxMessage` →
`// Legacy JSONL row shape (the historical chat-daemon format; src.legacy removed in <ver>)`.
**Test fixtures:** n/a (comments only); `pnpm build` + `pnpm test` unaffected.
**Acceptance criteria:**

- [ ] no `src/` comment references a path under the deleted `src.legacy/` as if it exists
- [ ] `pnpm test && pnpm build` green (comment-only diff)

**Risk callouts:** comments ONLY — do not change any code/behavior in these files.
**References:** the §2 list in the pre-research.
**Verification commands:** `pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 DONE. 2 learn: locate each stale pointer. 3 code: rewrite/drop. 4 test: green. 5 audit: no dead pointers. 6 n/a. 7 fix.

---

### Task LR.3: CHANGELOG + version bump

**Required skills:** opensquid release expert; Audit expert.
**Deliverable:** CHANGELOG entry (Phase-0 `src→src.legacy` reset fully retired) + patch bump.
**Depends on:** LR.1, LR.2.

**Files affected:** `CHANGELOG.md`, `package.json`.
**Acceptance criteria:**

- [ ] CHANGELOG entry; version bumped + re-verified; `pnpm format:check` green
      **Risk callouts:** bump is a MUTATION — re-read package.json after; format:check LAST.
      **Verification commands:** `pnpm format:check`.
      **7-phase steps:** 1 DONE. 2 learn: current version. 3 code: bump + entry. 4 test: format. 5 audit: version re-read. 6 n/a. 7 fix.
