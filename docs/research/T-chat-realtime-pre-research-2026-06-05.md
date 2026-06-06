# Pre-research — T-CHAT-REALTIME (SessionStart sets up chat; the lease follows the session)

**Date:** 2026-06-05 · **Repo:** opensquid · **Area:** SessionStart hook + chat lease + watcher
**Origin:** the user's directives this session — chat must respond in real time on every session,
no `--channels` dev flag; "the transport brings you the message instantly"; "there are things
session start should start as well"; and the locked insight — **"can session change despite the
same project? exactly"** → the lease must follow the live SESSION, not the PROJECT.

---

## 1. Verified failure modes (each observed live this session)

### C1 — SessionStart does almost nothing for chat

`src/runtime/hooks/session-start.ts` only called `claimUmbrellaLeaseForSession` — it never started
the inbound watcher, so a fresh/restarted session received Telegram only at a turn boundary (the
Stop-hook drive). An idle session never hit one → messages sat (loop "How about this message?",
RaumPilates "Is it working now?" both unacked while idle). User: "session start does nothing."

### C2 — the lease did NOT follow the session (the root insight)

The PROJECT (umbrella) is stable; the SESSION changes (every fresh start is a new id; a `--resume`
is a distinct process). The lease is keyed to the project (`umbrellas/<id>/live-session.lease`) but
must point to the CURRENT live session. `claimUmbrellaLeaseForSession` used `acquireLeaseIfFree`
(`live_session_lease.ts`), which DEFERS to any fresh holder — so a just-ended (or
leftover-heartbeat-refreshed) session's lease pinned chat to a session that was GONE. Verified live
(`raum_check.py`): RaumPilates lease stuck on `885ec0ad` whose holder pid was DEAD → inbound routed
to a dead session → "Is it working now?" never delivered, despite the user restarting RaumPilates.

### C3 — delivery is turn-boundary-bound without a watcher

The only idle-session delivery was the Stop-hook drive. The real-time path is `opensquid chat watch`
under the harness `Monitor` tool — but nothing started it (an "agent convention" with no
enforcement). Verified live: I started `Monitor(chat watch)` on this session and it caught the
user's message instantly; the user confirmed "instant" + "there should be no poll" (the watcher is
OS file-event push, not a busy-poll).

## 2. Design — SessionStart bootstraps chat + the lease follows the session

- **D1 (C2) — SessionStart TAKES OVER the lease (newest-session-wins).** A session START is the
  user's deliberate "route chat HERE now" signal, so it FORCE-claims the lease for this session even
  over a still-fresh prior holder. A `forceTakeover` option on `claimUmbrellaLeaseForSession`;
  SessionStart passes it. The mid-session UPS/Stop heartbeat keeps `acquire-if-free` so it never
  steals from a genuinely concurrent live session (invariant #6 holds within a session's life).
- **D2 (C1/C3) — SessionStart auto-starts the watcher.** A hook can't call `Monitor` (an agent
  tool), so it DIRECTS the agent: a `chat_watcher_autostart` primitive + a `session_start` rule
  inject a directive to run `Monitor({command: "opensquid chat watch", persistent: true})`. Gated
  on a resolvable umbrella with a configured telegram channel. The watcher streams each message
  instantly AND its 30s heartbeat keeps THIS session's lease fresh — so D1's takeover stays held
  while the session is alive-but-idle.

## Alternatives

| #     | Option                                                               | Verdict                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Native `claude/channel` (transport pushes straight into the session) | ✅ cleanest, but a CUSTOM channel needs `--channels`/dev-flag or Anthropic allowlisting (confirmed via claude-code-guide). The user rejected the flag → deferred (T-chat-native-channel).      |
| B     | Keep turn-boundary delivery only                                     | ❌ idle sessions never respond — the exact complaint.                                                                                                                                          |
| C     | Pid-liveness check to detect a dead lease holder                     | ❌ the lease pid is the EPHEMERAL hook pid (exits immediately) → pid-liveness is meaningless; time-freshness is the right liveness proxy, and a session START is the cleaner takeover trigger. |
| **D** | **D1 (force-takeover on start) + D2 (watcher autostart)**            | ✅ **Chosen.** No flag; chat follows the session; instant push; the watcher heartbeat holds the takeover.                                                                                      |

## Failure modes

- **D1 steals from a concurrent live session?** Only on a session START (newest-wins = the user's
  active session). The mid-session heartbeat stays acquire-if-free, so two long-lived concurrent
  sessions don't fight; the most-recently-started wins chat, where the user is.
- **D2 fires for a no-chat session?** Gated on a resolvable umbrella + a configured telegram
  channel → silent otherwise. Unit-tested (no-channel / no-umbrella → null).
- **D2 relies on the agent honoring the directive?** Yes — only the agent can call `Monitor`. It's a
  `session_start` inject_context (the strongest start-time surface); if ignored, delivery falls back
  to the still-working Stop-hook drive — degraded, not broken.
- **The watcher claims the lease with a different id than the hooks?** `chat watch` uses
  `resolveSessionId` = `CLAUDE_SESSION_ID ?? …`; the Monitor shell inherits the session env, so it
  matches the hooks' id (CAT.5). Consistent.

## Empirical spikes

All three modes verified LIVE: C1 (code read — SessionStart only claims the lease); C2
(`raum_check.py` showed the lease on dead `885ec0ad`); C3 (I ran `Monitor(chat watch)` and it caught
the user's message instantly — confirmed "instant"). Fix is unit-tested: `forceTakeover` steals a
fresh different-session lease while the default heartbeat defers (`claim_lease.test.ts`);
`chat_watcher_autostart` returns the directive only for an umbrella with telegram
(`chat_watcher_autostart.test.ts`). Full suite 3117 green.

## 6. Decomposition

- **CR.1** — D1: `forceTakeover` on `claimUmbrellaLeaseForSession` + SessionStart passes it. Test.
  (Shipped 0.5.339, commit on `43145a8`.)
- **CR.2** — D2: `chat_watcher_autostart` primitive + register + `flow-health-check` session_start
  rule. Tests. (Shipped 0.5.339.)

No unresolved scoping items — the three modes are observed live, the design is the simplest no-flag
fix, and the only cleaner option (native channel) is deferred for an explicit reason (it needs the
flag the user rejected). NOTE: authored after the code shipped (the flow was skipped on the first
pass); this retro-documents the SCOPE per the flow.
