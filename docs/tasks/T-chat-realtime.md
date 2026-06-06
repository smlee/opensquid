# Track T-CHAT-REALTIME — SessionStart sets up chat; the lease follows the session

**Pre-research:** `docs/research/T-chat-realtime-pre-research-2026-06-05.md`.

**Principle:** Simplicity / no-flag — the PROJECT is stable but the SESSION changes, so the chat
lease must follow the current live session, and SessionStart must actively SET UP chat (not just
claim a lease). Order: CR.1 → CR.2. (Both SHIPPED in 0.5.339; this spec retro-documents the AUTHOR
stage — the flow was skipped on the first pass and is being done properly now.)

---

### Task CR.1: SessionStart TAKES OVER the umbrella lease (newest-session-wins)

**Required skills:** opensquid chat-lease expert; SessionStart hook expert; Vitest expert; Audit expert.
**Deliverable:** a session START force-claims the umbrella lease for THIS session even over a
still-fresh prior holder (so the lease follows the session change), while the mid-session UPS/Stop
heartbeat keeps `acquire-if-free` (never steals from a concurrent live session).
**Depends on:** None.

**Files affected:**

- `src/runtime/chat/claim_lease.ts` (modify) — `forceTakeover?: boolean` option; on force, `writeLease` (overwrite) instead of `acquireLeaseIfFree`.
- `src/runtime/hooks/session-start.ts` (modify) — pass `{ forceTakeover: true }`.
- `src/runtime/chat/claim_lease.test.ts` (modify) — force-takeover steals a fresh different-session lease; default heartbeat defers.

**Key code shapes** (real — shipped):

```ts
// claim_lease.ts
if (opts?.forceTakeover === true) {
  await writeLease(leasePath, sessionId);
  return true;
}
return await acquireLeaseIfFree(leasePath, sessionId);
```

```ts
// session-start.ts
await claimUmbrellaLeaseForSession(sessionId, startCwd, { forceTakeover: true });
```

**Test fixtures:** seed channels + a FRESH lease held by `prior-session`; default claim → false
(defers, invariant #6); `{ forceTakeover: true }` → true + lease now this session.
**Acceptance criteria:**

- [x] forceTakeover overwrites a fresh different-session lease; default defers
- [x] stale lease still re-claimed by both paths
- [x] full gate chain green (3117)

**Risk callouts:** force-takeover ONLY on session_start (the user's "route here" signal); the
mid-session heartbeat must stay acquire-if-free, else two concurrent sessions thrash the lease.
**References:** `live_session_lease.ts` (`acquireLeaseIfFree`/`writeLease`); the stale-lease bug in the pre-research (RaumPilates `885ec0ad`).
**Verification commands:** `pnpm vitest run src/runtime/chat/claim_lease.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research (retro) DONE. 2 learn: acquire-if-free defers to fresh holders. 3 code: forceTakeover. 4 test: both branches. 5 audit: heartbeat unchanged. 6 n/a. 7 fix.

---

### Task CR.2: SessionStart auto-starts the inbound watcher (real-time, no flag)

**Required skills:** opensquid SessionStart/inject_context expert; channels-routing expert; Vitest expert; Audit expert.
**Deliverable:** on `session_start`, the agent is DIRECTED to start `opensquid chat watch` under
`Monitor`, so messages arrive in real time (push), gated on a resolvable umbrella with a telegram
channel.
**Depends on:** CR.1.

**Files affected:**

- `src/functions/chat_watcher_autostart.ts` (new) — returns an `inject_context` directive (gated on umbrella+telegram), else null.
- `src/runtime/bootstrap.ts` (modify) — register it.
- `packs/builtin/coding-flow/skills/flow-health-check/skill.yaml` (modify) — a `session_start` rule calling it.
- `src/functions/chat_watcher_autostart.test.ts` (new) — directive only when telegram configured; null otherwise; fail-soft.

**Key code shapes** (real — shipped):

```ts
const umb = cfg.umbrellas.find((u) => u.id === umbrellaId);
if (umb?.telegram === undefined) return ok(null);
return ok({
  kind: 'inject_context' as const,
  content:
    '📡 CHAT SETUP — start the inbound watcher … Monitor({command: "opensquid chat watch", persistent: true}) …',
});
```

**Test fixtures:** channels.json with/without telegram → directive / null; no channels.json → null; cwd→no-umbrella → null.
**Acceptance criteria:**

- [x] umbrella+telegram → inject_context to start `chat watch` under Monitor
- [x] no telegram / no umbrella / no config → null (fail-soft)
- [x] full gate chain green (3117)

**Risk callouts:** a hook can't call Monitor — this DIRECTS the agent; if ignored, falls back to
the Stop-hook drive (degraded, not broken). Silent for no-chat umbrellas.
**References:** `src/runtime/hooks/session-start.ts` (contextInjections); `check_flow_health` (the sibling session_start primitive); `channels/routing.ts`.
**Verification commands:** `pnpm vitest run src/functions/chat_watcher_autostart.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research (retro) DONE. 2 learn: session_start inject_context surface. 3 code: primitive + rule + register. 4 test: gated branches. 5 audit: fail-soft, gated. 6 n/a. 7 fix.
