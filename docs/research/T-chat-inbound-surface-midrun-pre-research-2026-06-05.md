# Pre-research — T-CHAT-INBOUND-SURFACE-MIDRUN

**Date:** 2026-06-05 · **Repo:** opensquid · **Area:** Stop hook + chat inbox
**Origin:** diagnosing why the user felt unheard on chat for a week. Verified that the loop
umbrella's chat PLUMBING is healthy ([[project-loop-inbound-chat-verified-working]]); the
real fault is a Stop-hook precedence interaction.

---

## 1. The verified root cause (cited)

The Stop hook resolves a drift block BEFORE the inbound chat drive, and exits there:

> `src/runtime/hooks/stop.ts:108-110`
>
> ```ts
> // A drift BLOCK (exit≠0) takes precedence over an inbound drive — handle the
> // agent's drift first; the chat backlog drives on a later, clean turn.
> if (exitCode !== 0) emitDriftStderrAndExit(exitCode, stderr);
> ```
>
> `maybeDriveInbound(sessionId, cwd)` is only reached at `stop.ts:128` — AFTER that early exit.

During an automated multi-task run, the coding-flow `pause-stop-guard` HARD-BLOCKS every
mid-run stop (`exit 2`, "DRIFT: stopped mid-run" — `packs/builtin/coding-flow/skills/pause-stop-guard/skill.yaml`).
That drift block trips `stop.ts:110` and exits, so `maybeDriveInbound` never runs. Net:
**inbound user chat messages are structurally starved for the entire duration of a run** —
they queue until the backlog depletes and a clean (exit 0) stop finally reaches line 128.
This regressed harder when GF.6 escalated the stop-guard to a hard block (2026-06-04).

This is verified, not inferred: the precedence is explicit in the code and the comment, and
[[project-loop-inbound-chat-verified-working]] confirms the drain itself works (74 acked
deliveries; a read-only run finds the 1 currently-pending message and builds its envelope).

## 2. The decision (locked by the user)

The user chose **"inbound surfaces, run continues"** over "inbound preempts the drift block":
keep the no-pause discipline intact (the run is NOT forcibly driven mid-run), but **surface**
any pending inbound in the drift stderr so a mid-run user message is never invisible — the
agent can choose to answer. Rationale: the pause-guard governs the AGENT's self-initiated
stops; a real user message is the opposite signal and must at least be SEEN, but the user
explicitly does not want it to break the automated run. (This is the user's product call —
recorded, not re-litigated.)

## 3. Design — the simplest correct change

Append a **read-only peek** of the unacked inbound to the drift stderr. "Read-only" is
load-bearing: the message is NOT acked, so it STILL drives a proper response turn at the
next clean stop (`maybeDriveInbound` at line 128). Surfacing is purely additive visibility;
it loses nothing.

Two new pure-ish functions + a 3-line wiring change:

1. `peekUmbrellaInbox(sessionId, cwd)` — the read-only twin of `drainUmbrellaInbox`
   (`src/runtime/chat/inbox_drain.ts`): resolve umbrella → `readInbox` → `readAcked` →
   `computeUnackedRows` → `buildInjectionEnvelope` → return the envelope. **No `appendAckRows`,
   no purge.** Fail-open `''` (mirrors the drain). Reuses the exact read-path the drain
   already uses (and that the 2026-06-05 probe ran by hand).
2. `maybePeekInbound(sessionId, cwd)` — the lease-gated twin of `maybeDriveInbound`
   (`src/runtime/hooks/stop_drive.ts`): same `resolveLiveSessionId === sessionId` lease gate
   (only the live session surfaces, no cross-session double-surface), call `peekUmbrellaInbox`,
   return envelope|null. **No `markChatDriven`** (we are not driving).
3. `src/runtime/hooks/stop.ts` — move `const cwd = extractCwd(raw)` above the drift check;
   in the drift branch, peek and append:
   ```ts
   const cwd = extractCwd(raw);
   if (exitCode !== 0) {
     const peek = await maybePeekInbound(sessionId, cwd);
     emitDriftStderrAndExit(exitCode, peek === null ? stderr : `${stderr}\n\n${peek}`);
   }
   ```

## 4. Alternatives weighed

| #     | Option                                                                         | Verdict                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | Inbound PREEMPTS the drift block (drive even mid-run)                          | ❌ Rejected by the user — breaks the no-pause discipline; a user message would forcibly interrupt the automated run.                                                     |
| B     | Add an `{ack}` option to `drainUmbrellaInbox` and call it with `ack:false`     | ❌ Muddies the drain's "ACK-BEFORE-RETURN exactly-once" contract (its core durability invariant). A separate read-only `peekUmbrellaInbox` keeps that contract pristine. |
| **C** | **Read-only `peekUmbrellaInbox` + `maybePeekInbound`, append to drift stderr** | ✅ **Chosen.** Additive, no-ack (so the message still drives later), lease-gated, preserves the drift precedence and the drain's exactly-once contract.                  |

## 5. Inversion — how could this be wrong?

- **Double-surfacing across turns?** No — peek is read-only, so the SAME pending message is
  re-surfaced on every drift stop until the run depletes and it drives+acks. That is correct
  (a persistent reminder), and it cannot double-DELIVER because driving still acks once.
- **Peek throws and breaks the stop?** Fail-open `''` (mirrors the drain); a peek failure
  degrades to the current behavior (drift stderr only), never crashes the hook.
- **Non-lease session surfaces another umbrella's inbound?** Prevented by the lease gate in
  `maybePeekInbound` (mirrors `maybeDriveInbound`).

## 6. Empirical spike

The 2026-06-05 read-only probe already exercised the peek read-path (umbrella resolve +
`computeUnackedRows` + `buildInjectionEnvelope`) and returned the pending envelope WITHOUT
acking — `peekUmbrellaInbox` is that probe, productized. Tests will assert the no-ack
property (second peek still returns the message) and the stop-hook stderr merge.

## 7. Decomposition

- **SF.1** — `peekUmbrellaInbox` (read-only drain twin) + `maybePeekInbound` (lease-gated) + unit tests.
- **SF.2** — `stop.ts` wiring (peek-and-append in the drift branch) + integration test.
- **SF.3** — CHANGELOG + version bump.

No unresolved scoping questions — the approach is the user's explicit choice; the code path
is fully determined by the existing drain/drive structure.
