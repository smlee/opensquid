# Track T-CHAT-FINALIZE-REMOVE-LEGACY — one daemon-client owner, then delete legacy

**Pre-research:** `docs/research/T-chat-finalize-remove-legacy-pre-research-2026-06-04.md`
(from the `/research-audit` chat run `wf_ea47ae27-4ee`; 8/55 findings survived).

**Principle:** Simplicity — one owner for the daemon client (not 5 copies, not an
over-abstracted framework); the genuinely-hard parts (live-session `UserPromptSubmit`
injection, the routing FSM) are NOT touched. Order: CL.1 → CL.2 → CL.3 → CL.4.

> **Gate-hole findings (recorded, separate fix-candidate, NOT this track):** (G-a) the
> GF.7 re-arm only fires on a scope-keyword prompt, so a new track described in plain
> language leaves the FSM parked at `phases_complete` → all GF.6 pause-gates stay OFF;
> (G-b) the `no-pause-language` pattern set misses "your call / unless you redirect /
> unless you'd rather". Both let the author pause ungated mid-run on 2026-06-04.

---

### Task CL.1: `src/chat_daemon/client.ts` — the single daemon-client owner

**Required skills:** opensquid runtime expert; node net/socket + JSON-RPC expert; cross-platform path expert; Vitest socket-stub expert; Audit expert
**Deliverable:** one module owning the one-shot daemon client: socket-path resolution (Unix sock reusing `runtime/paths.ts:chatDaemonSockPath`; the Win32 named-pipe branch folded in ONCE), connect → write JSON-RPC request → buffer+parse response → timeout → close, and a typed `send()` returning the decoded `DaemonSendResult`. NO method without a present caller (no pooling/retry/stream).
**Depends on:** None.

**Files affected:**

- `src/chat_daemon/client.ts` (new) — the shared client.
- `src/chat_daemon/client.test.ts` (new) — unit tests against a stub socket server.
- `src/runtime/paths.ts` (modify, minimal) — if the Win32 pipe branch is centralized here beside the Unix `chatDaemonSockPath`, expose it; else keep in the client.

**Key code shapes:**

```ts
// client.ts — extraction, byte-for-byte behavior of the existing send/socket logic.
export interface DaemonSendResult {
  ok: boolean;
  platform?: string;
  message_id?: string;
  error?: string;
}
export function daemonSocketPath(home = OPENSQUID_HOME()): string {
  /* Unix sock | Win32 pipe (one branch) */
}
export async function daemonRpc<T>(
  method: string,
  params: unknown,
  opts?: { timeoutMs?: number },
): Promise<T> {
  // connect(daemonSocketPath()) → write({jsonrpc,id,method,params}) → read+parse → timeout → close
}
export const sendChat = (params): Promise<DaemonSendResult> => daemonRpc('send', params);
```

**Test fixtures:** a stub unix-socket server that echoes a canned JSON-RPC result; assert `daemonRpc` connects, sends the envelope, decodes the result, and times out cleanly when the server hangs. Win32 path branch covered by a path-only unit test (no socket).

**Acceptance criteria:**

- [ ] `daemonSocketPath` returns the same path the 5 existing sites derive (Unix + Win32)
- [ ] `daemonRpc`/`sendChat` round-trips against a stub socket; timeout returns/throws cleanly
- [ ] no speculative methods (only `daemonRpc` + `sendChat` + path) — Simplicity
- [ ] full gate chain green

**Risk callouts:** STRICT extraction — match the existing socket/timeout/decode behavior exactly so CL.3 repoints are no-ops behaviorally. Reuse `runtime/paths.ts` for the Unix half; do not re-derive it.
**References:** `src/runtime/agent_bridge/tools/chat_send.ts:49-58,97-165`; `src/runtime/paths.ts:297`; `src/mcp/chat-bridge-server.ts:77-81,250-290`; the named intent comment `chat_send.ts:15-22`.
**Verification commands:** `pnpm vitest run src/chat_daemon/client.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: lock the one-shot shape, no extra surface. 3 code: client.ts. 4 test: stub-socket round-trip + path. 5 audit: behavior matches existing; no speculative API. 6 post-research: n/a. 7 fix.

---

### Task CL.2: Port `resolveOrCreateTopic` into `src/`; delete the legacy dynamic-import

**Required skills:** opensquid migrate/port expert; Telegram topic API expert; dynamic-import-removal expert; Vitest expert; Audit expert
**Deliverable:** `resolveOrCreateTopic` (Telegram topic resolve-or-create) lives in `src/` (a method on the CL.1 client, or in `src/functions/ensure_umbrella_topic.ts` which already does socket-level `create_topic`); `topic_create_step.ts` calls the `src/` version, and `loadLegacyResolver()` + the `dist/chat/daemon/workspace-topic.js` dynamic import are DELETED. This removes the sole legacy coupling.
**Depends on:** CL.1.

**Files affected:**

- `src/setup/cli/topic_create_step.ts` (modify) — call the ported fn; delete `loadLegacyResolver()` (lines ~195-214).
- `src/functions/ensure_umbrella_topic.ts` (modify) or the CL.1 client — host the ported `resolveOrCreateTopic`.
- the relevant test (modify/new) — the ported resolver + topic_create_step with no legacy import.

**Key code shapes:**

```ts
// topic_create_step.ts — was: const { resolveOrCreateTopic } = await loadLegacyResolver();
// now: import { resolveOrCreateTopic } from '<the src/ home>';  (no dynamic import, no dist/chat/daemon)
```

**Test fixtures:** the ported `resolveOrCreateTopic` against a stub daemon/Telegram client (resolve-existing + create-new); `topic_create_step` no longer references `dist/chat/daemon`.

**Acceptance criteria:**

- [ ] `resolveOrCreateTopic` is in `src/`, behavior-equivalent to the legacy one
- [ ] `topic_create_step.ts` has NO dynamic import of `dist/chat/daemon/*`
- [ ] `grep -rn "dist/chat/daemon\|loadLegacyResolver" src/` → empty
- [ ] full gate chain green

**Risk callouts:** the legacy `workspace-topic.ts` may carry helpers the port needs — bring only what `resolveOrCreateTopic` actually uses (Simplicity; don't port the whole module). Confirm `ensure_umbrella_topic.ts`'s existing `create_topic` socket call covers the create half.
**References:** `src/setup/cli/topic_create_step.ts:147,195-214`; `src.legacy/chat/daemon/workspace-topic.ts`; `src/functions/ensure_umbrella_topic.ts:93-140`.
**Verification commands:** `pnpm vitest run src/setup/cli/ src/functions/ && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: port only what resolveOrCreateTopic uses. 3 code: port + delete loadLegacyResolver. 4 test: resolver + no-legacy-import. 5 audit: grep clean. 6 post-research: n/a. 7 fix.

---

### Task CL.3: Repoint the 4–5 call sites at the shared client

**Required skills:** opensquid refactor expert; behavior-preserving extraction expert; Vitest expert; Audit expert
**Deliverable:** every duplicated daemon-client site imports the CL.1 client instead of its local copy — the ~225 LOC of copy-paste deleted, behavior unchanged (existing tests green).
**Depends on:** CL.1, CL.2.

**Files affected:**

- `src/runtime/agent_bridge/tools/chat_send.ts` (modify) — use the client; drop local `daemonSocketPath` + send + decode.
- `src/mcp/chat-bridge-server.ts` (modify) — same.
- `src/setup/cli/chat_actions_test_step.ts` (modify) — same, OR confirm-and-retire (audit "not covered").
- `src/functions/ensure_umbrella_topic.ts` (modify) — use the client's socket/RPC.
- `src/setup/cli/chat_state.ts` (modify) — import the canonical socket path.

**Key code shapes:** delete each local `daemonSocketPath()` / one-shot-RPC / `DaemonSendResult` decode; replace with `import { daemonRpc, sendChat, daemonSocketPath } from '../../chat_daemon/client.js'`.

**Test fixtures:** the existing call-site tests are the proof — they must stay green with zero assertion changes (behavior-preserving).

**Acceptance criteria:**

- [ ] all 4–5 sites import the shared client; no local socket-path/RPC/decode copies remain
- [ ] `grep -rn "daemonSocketPath\|chat-daemon.sock" src/` → only the client + canonical paths.ts
- [ ] existing call-site tests pass with no assertion changes
- [ ] full gate chain green

**Risk callouts:** behavior-preserving ONLY — if a site had a subtly different timeout/decode, match it in the client (CL.1) first, don't change the site's behavior here. Decide `chat_actions_test_step.ts`: migrate vs retire (state which + why).
**References:** the 5 sites in §1 of the pre-research.
**Verification commands:** `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: behavior-preserving. 3 code: repoint each site. 4 test: existing tests green unchanged. 5 audit: no copies remain. 6 post-research: n/a. 7 fix.

---

### Task CL.4: Delete `src.legacy/chat` + dead `dist/chat/daemon` + drop the tsconfig exclude

**Required skills:** opensquid build/tsconfig expert; dead-code-removal expert; daemon smoke-test expert; Audit expert
**Deliverable:** `src.legacy/chat` is deleted; the dead `dist/chat/daemon/*` build output is no longer produced; the `tsconfig.build.json` `src.legacy` exclude is dropped if nothing else needs it; the daemon still routes inbound + sends outbound.
**Depends on:** CL.1, CL.2, CL.3 (all green).

**Files affected:**

- `src.legacy/chat/**` (delete) — `git rm`.
- `tsconfig.build.json` (modify) — drop the `src.legacy/chat` exclude if it's the only consumer.
- any stragglers found by a final `grep -rn "src.legacy\|src/.legacy" src/`.

**Key code shapes:** `git rm -r src.legacy/chat` (reversible via history); rebuild; smoke `opensquid chat-daemon status` + a route/send check.

**Test fixtures:** the full suite stays green after deletion; a daemon smoke check (route an inbound test message + `chat_send`) confirms no runtime dependency on the deleted tree.

**Acceptance criteria:**

- [ ] `src.legacy/chat` deleted; `grep -rn "src.legacy" src/` → empty (or only unrelated)
- [ ] build produces no `dist/chat/daemon/*`; tsconfig exclude dropped if unused
- [ ] daemon route+send smoke check passes; full gate chain green
- [ ] CI green (the real proof nothing hidden depended on it)

**Risk callouts:** THE irreversible slice — do it ONLY after CL.1–3 are green + the smoke check. `git rm` keeps history, so a hidden consumer surfacing post-merge is recoverable. Check for NON-chat `src.legacy` subtrees before dropping the whole exclude.
**References:** `tsconfig.build.json` (the exclude); `src.legacy/chat/`; the audit's legacy-coupling finding (now resolved by CL.2).
**Verification commands:** `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm format:check` + `node dist/cli.js chat-daemon status`.
**7-phase steps:** 1 pre-research DONE. 2 learn: confirm no remaining consumer. 3 code: git rm + tsconfig. 4 test: full suite + daemon smoke. 5 audit: grep clean, CI green. 6 post-research: n/a. 7 fix.
