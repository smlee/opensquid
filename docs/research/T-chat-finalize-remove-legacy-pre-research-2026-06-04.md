# Pre-research — T-CHAT-FINALIZE-REMOVE-LEGACY (2026-06-04)

Source: the `/research-audit` of the chat system (run `wf_ea47ae27-4ee`, 8/55 findings
survived refutation). Goal (user): finalize the new stack to the simple observe→route→push
design, port whatever legacy still owns, then DELETE `src.legacy/chat`. Governing
principle: **Simplicity** (`docs/lexicon.md`) — simple as possible, complex only where
genuinely needed; the cure for the duplication is STRUCTURE (one owner), not a new
abstraction layer.

## §1 — What the audit established (verified)

- **The ONLY hard legacy coupling** is `src/setup/cli/topic_create_step.ts:200-214`
  (`loadLegacyResolver()`): a runtime dynamic-import of the legacy-compiled
  `dist/chat/daemon/workspace-topic.js` to call `resolveOrCreateTopic()` (Telegram topic
  resolve-or-create), a deliberate escape hatch around the `tsconfig.build.json`
  `src.legacy` exclude. Until that function lives in `src/`, `src.legacy/chat` +
  `dist/chat/daemon/*` cannot be deleted. **Port list = this one function.**
- **The duplication (the slop)** — the legacy single daemon client was fragmented into
  4–5 copy-pasted re-implementations (~225 LOC): one-shot JSON-RPC send ×4
  (`agent_bridge/tools/chat_send.ts:97-165`, `mcp/chat-bridge-server.ts:250-290`,
  `setup/cli/chat_actions_test_step.ts:240-310`, `functions/ensure_umbrella_topic.ts:93-140`);
  socket-path derivation ×5 (canonical `runtime/paths.ts:297` + 4 local copies); Win32
  pipe fingerprint ×2; `DaemonSendResult` decode ×3. Root cause: `src.legacy` is
  tsconfig-excluded so `src/` cannot import a shared client, and none was created (the
  `chat_send.ts:15-22` comment already names the intended fix: `src/chat_daemon/client.ts`).
- **NOT a perf-regression in the chat code** (the perf theories were refuted): the
  transport is event-driven push (`runtime/chat/watch.ts:5,161` — `usePolling` defaults
  false). The "slow vs instant" is the **live-session injection** (`runtime/chat/
inbox_inject.ts` — delivery rides the next `UserPromptSubmit` additionalContext, a turn
  boundary), a HARNESS constraint, not a chat bug. OUT OF SCOPE for this track (it would be
  a separate latency investigation; the dedicated-agent path is already instant).
- **The new architecture is NOT inferior** — it is better (structural border/one-topic
  invariant in `channels/routing.ts:69-83`; the project-UUID mirror hack is gone). The
  inferiority was operational: not self-contained + the duplication. Both fixed here.

## §2 — The design (the one move, simplest correct)

The audit's sharpest point: **ONE module** `src/chat_daemon/client.ts` owns the daemon
client, and porting `resolveOrCreateTopic` ONTO it simultaneously (a) kills ~225 LOC of
duplication and (b) removes the last legacy dependency → unblocks deleting `src.legacy`.

`src/chat_daemon/client.ts` owns ONLY what is genuinely shared (no speculative surface):

- socket-path resolution (Unix sock + Win32 named-pipe fingerprint — the one platform
  branch, currently duplicated; the canonical Unix half already lives at
  `runtime/paths.ts:297` and is reused, not re-derived);
- one-shot JSON-RPC: connect → write request → buffer+parse response → timeout → close;
- typed methods for the calls that exist TODAY: `send()` (→ `DaemonSendResult`),
  `createTopic()` / `resolveOrCreateTopic()`. Nothing more — methods are added when a
  caller needs them, not pre-built.

Explicitly OUT (complexity that is NOT warranted): no connection pooling, no retry
framework, no event-stream abstraction — the daemon calls are one-shot; a one-shot client
is the simple correct shape.

## §3 — Decomposition (CL.\*)

- **CL.1 — `src/chat_daemon/client.ts`** + tests. The shared one-shot client: socket path
  (reuse `runtime/paths.ts` Unix half; fold the Win32 branch in once), JSON-RPC
  request/response, typed `send()` decode. Pure, unit-tested against a stub socket.
- **CL.2 — port `resolveOrCreateTopic` into `src/`** as a client method (or alongside in
  `ensure_umbrella_topic.ts`), and DELETE the `loadLegacyResolver()` dynamic-import in
  `topic_create_step.ts` — the last legacy coupling gone.
- **CL.3 — repoint the call sites** at the shared client: `chat_send.ts`,
  `chat-bridge-server.ts`, `chat_actions_test_step.ts`, `ensure_umbrella_topic.ts` (and the
  4 local socket-path copies → import the canonical). Each site loses its copy-paste; tests
  stay green.
- **CL.4 — delete `src.legacy/chat`** + the now-dead `dist/chat/daemon/*` build path + drop
  the `tsconfig.build.json` `src.legacy` exclude if nothing else needs it; verify the
  daemon still routes inbound + sends outbound (the chat-as-terminal smoke path).

Order: CL.1 → CL.2 → CL.3 → CL.4 (build the owner, port onto it, migrate callers, then
delete — each slice independently green + reversible).

## §4 — Risks / invariants

- **Do NOT touch the genuinely-hard parts:** the `UserPromptSubmit` live-session injection
  and the umbrella-routing FSM stay as-is — they earn their complexity.
- The shared client must be a STRICT extraction (byte-for-byte behavior of the existing
  send/socket logic) — no behavior change, just one owner. Verified by the existing
  call-site tests staying green.
- CL.4 deletion is the irreversible step — gated behind CL.1–3 green + a daemon
  route/send smoke check; `git rm` is reversible via history if a hidden consumer surfaces.
- `chat_actions_test_step.ts` is a setup/test path — confirm it needs the shared client vs
  can be retired (audit "not covered" flagged this).
- Simplicity gate: the client adds NO method without a present caller (no speculative API).
