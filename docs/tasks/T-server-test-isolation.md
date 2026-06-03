# Track T-SERVER-TEST-ISOLATION — isolate the MCP server test from the repo's active.json

**Pre-research:** the 2 `server.test.ts` "no packs loaded" stub tests fail LOCALLY (pass
in CI) because the spawned server inherits the test process's cwd = the repo root, which
carries `.opensquid/active.json: [coding-flow]`. The test isolates user scope
(`OPENSQUID_HOME`) but NOT project scope (cwd). CI's checkout has no local `active.json`
(gitignored), so it passes there.

### Task FC.4: Spawn the MCP server with an isolated cwd

**Required skills:** System integration test / CI fixtures expert; Subprocess lifecycle expert; Audit / code review expert
**Deliverable:** `server.test.ts`'s spawned server runs with `cwd` set to the per-test temp `OPENSQUID_HOME` (no `.opensquid/active.json`), so its project scope is empty and the "no packs loaded" stub tests pass locally as they do in CI.
**Depends on:** None.

**Files affected:**

- `src/mcp/server.test.ts` (modify) — add `cwd` to the `spawn(...)` options.

**Key code shapes:**

```ts
// src/mcp/server.test.ts — constructor(env): give the child an isolated cwd so its
// project-scope resolution (resolveProjectScopeRoot walks up from process.cwd())
// finds no .opensquid/active.json — matching CI's clean checkout.
this.proc = spawn(TSX_BIN, [SERVER_FILE], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
  cwd: env.OPENSQUID_HOME, // the per-test temp dir (no active.json above it)
});
```

**Test fixtures:** with `cwd` = the temp home, `list_packs` → "no packs loaded" (the repo's `coding-flow` active.json is no longer on the resolution path); the other server tests unchanged (they match CI behavior).

**Acceptance criteria:**

- [ ] the 2 "no packs loaded" / "no skills loaded" tests pass locally
- [ ] no other `server.test.ts` test regresses
- [ ] full suite green locally (down to zero failures)

**Risk callouts:** `env.OPENSQUID_HOME` is set per test (the suite's `beforeEach`); if ever absent the cwd would fall back to the repo root again — every test in this file sets it, so it is always defined here. Do not set a global cwd that other suites share.

**References:** `src/mcp/server.test.ts:78-82` (the spawn); `src/runtime/paths.ts` `resolveProjectScopeRoot` (walks up from cwd).

**Verification commands:** `pnpm vitest run src/mcp/server.test.ts && pnpm vitest run`.

**7-phase steps:** 1 pre-research: confirm the cwd-vs-OPENSQUID_HOME split (DONE — the test isolates user scope only); 2 learn: lock `cwd: env.OPENSQUID_HOME`; 3 code: add cwd to the spawn; 4 test: the 2 stub tests + full suite; 5 audit: no other server test regresses; 6 post-research: n/a; 7 fix.
