# Track T-CHAT-INBOUND-SURFACE-MIDRUN — surface inbound chat during a drift-blocked stop

**Pre-research:** `docs/research/T-chat-inbound-surface-midrun-pre-research-2026-06-05.md`.

**Principle:** Simplicity / no-implicit-state — a read-only PEEK twin of the existing drain
(no new state, no ack side-effect), appended to the drift stderr. Preserves the no-pause
discipline (run continues) and the drain's exactly-once ACK contract. Order: SF.1 → SF.2 → SF.3.

**User decision (locked):** inbound SURFACES mid-run, the run CONTINUES (not driven). The
pause-guard governs the agent's stops; a user message must be SEEN but must not break the run.

---

### Task SF.1: read-only `peekUmbrellaInbox` + lease-gated `maybePeekInbound`

**Required skills:** opensquid chat-inbox expert; behavior-preserving extraction expert; Vitest expert; Audit expert.
**Deliverable:** a read-only inbox peek (the unacked envelope, NOT acked) and its lease-gated
wrapper — the twins of `drainUmbrellaInbox` / `maybeDriveInbound`, minus the ack + the
chat-driven marker.
**Depends on:** None.

**Files affected:**

- `src/runtime/chat/inbox_drain.ts` (modify) — add `peekUmbrellaInbox`.
- `src/runtime/hooks/stop_drive.ts` (modify) — add `maybePeekInbound`.
- `src/runtime/chat/inbox_drain.test.ts` (modify) — peek returns envelope + does NOT ack.
- `src/runtime/hooks/stop_drive.test.ts` (modify) — `maybePeekInbound` lease gate + no-ack.

**Key code shapes** (real):

```ts
// inbox_drain.ts — read-only twin of drainUmbrellaInbox. Same resolve+read+compute path,
// but NO appendAckRows and NO purge: surfacing must not consume the message (it still
// DRIVES + acks at the next clean stop via maybeDriveInbound). Fail-open ''.
export async function peekUmbrellaInbox(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    const cfg = await loadChannelsConfig().catch(() => null);
    const umbrellaId = cfg === null ? null : resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return '';
    const platformReads = await Promise.all(INBOX_PLATFORMS.map((p) => readInbox(umbrellaId, p)));
    const acked = await readAcked(umbrellaId);
    const unacked = computeUnackedRows(platformReads.flat(), acked, sessionId);
    if (unacked.length === 0) return '';
    const built = buildInjectionEnvelope(unacked);
    return built.injectedRows.length > 0 ? built.envelope : '';
  } catch {
    return '';
  }
}
```

```ts
// stop_drive.ts — lease-gated twin of maybeDriveInbound. Only the umbrella's live session
// surfaces (no cross-session double-surface); NO markChatDriven (we are not driving).
export async function maybePeekInbound(sessionId: string, cwd: string): Promise<string | null> {
  try {
    const cfg = await loadChannelsConfig().catch(() => null);
    const umbrellaId = cfg === null ? null : resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return null;
    const live = await resolveLiveSessionId(umbrellaId);
    if (live !== sessionId) return null;
    const envelope = await peekUmbrellaInbox(sessionId, cwd);
    return envelope.length === 0 ? null : envelope;
  } catch {
    return null;
  }
}
```

**Test fixtures** (mirror `inbox_drain.test.ts` setup — `OPENSQUID_HOME` temp, channels.json
with umbrella `loop` members `[CWD]`, `umbrellaInboxFile('loop','telegram')`, `inboxRow`):

```ts
// inbox_drain.test.ts
it('peekUmbrellaInbox returns the unacked envelope WITHOUT acking (idempotent)', async () => {
  await writeFile(umbrellaInboxFile('loop', 'telegram'), inboxRow('1', 'hello'), 'utf8');
  const first = await peekUmbrellaInbox(SESSION, CWD);
  expect(first).toContain('hello');
  const second = await peekUmbrellaInbox(SESSION, CWD); // NOT acked → still returned
  expect(second).toContain('hello');
});
it('peekUmbrellaInbox returns empty when cwd resolves to no umbrella', async () => {
  await writeFile(umbrellaInboxFile('loop', 'telegram'), inboxRow('1', 'x'), 'utf8');
  expect(await peekUmbrellaInbox(SESSION, '/somewhere/else')).toBe('');
});

// stop_drive.test.ts — mirror the maybeDriveInbound lease-gate tests
it('maybePeekInbound returns null for a non-lease session', async () => {
  /* lease held by OTHER session → null even with pending inbound */
});
it('maybePeekInbound returns the envelope for the lease holder without acking', async () => {
  /* lease == SESSION + pending inbound → envelope; acked.jsonl unchanged */
});
```

**Acceptance criteria:**

- [ ] `peekUmbrellaInbox` returns the unacked envelope and does NOT write `acked.jsonl` (second call identical)
- [ ] `peekUmbrellaInbox` fails open (`''`) on no-umbrella / absent channels.json
- [ ] `maybePeekInbound` is lease-gated (non-lease → null) and never marks chat-driven
- [ ] full gate chain green

**Risk callouts:** do NOT refactor `drainUmbrellaInbox` to share via an `{ack}` flag — keep
its exactly-once ACK contract pristine; the peek is a separate read-only function (Simplicity
≠ premature DRY). Mirror the drain's `INBOX_PLATFORMS` + fail-open exactly.
**References:** `src/runtime/chat/inbox_drain.ts` (`drainUmbrellaInbox`); `src/runtime/hooks/stop_drive.ts` (`maybeDriveInbound`); `src/runtime/chat/inbox_inject.ts` (`computeUnackedRows`, `buildInjectionEnvelope`); `src/runtime/chat/inbox_drain.test.ts:38-93`.
**Verification commands:** `pnpm vitest run src/runtime/chat/inbox_drain.test.ts src/runtime/hooks/stop_drive.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: confirm the read-path helpers are side-effect-free. 3 code: the two functions. 4 test: no-ack idempotence + lease gate. 5 audit: drain contract untouched; fail-open mirrored. 6 post-research: n/a. 7 fix.

---

### Task SF.2: wire the peek into the drift branch of `stop.ts`

**Required skills:** opensquid hook expert; Vitest hook-integration expert; Audit expert.
**Deliverable:** when the Stop hook resolves a drift block (`exitCode !== 0`), the pending
inbound envelope is appended to the drift stderr (surfaced) before exit — the run still
continues (not driven), and the message stays unacked so it drives later.
**Depends on:** SF.1.

**Files affected:**

- `src/runtime/hooks/stop.ts` (modify) — move `extractCwd` above the drift check; peek-and-append.
- `src/runtime/hooks/stop.test.ts` (modify/new) — drift-block + pending-inbound integration.

**Key code shapes** (real — the edited `stop.ts` region):

```ts
const cwd = extractCwd(raw); // moved UP (was below the drift check)

// A drift BLOCK still takes precedence — the run is NOT driven mid-run (no-pause
// discipline). But SURFACE any pending inbound in the drift stderr so a mid-run user
// message is never invisible; the peek is READ-ONLY (unacked), so it still DRIVES a
// proper response turn at the next clean stop (maybeDriveInbound below).
if (exitCode !== 0) {
  const peek = await maybePeekInbound(sessionId, cwd);
  emitDriftStderrAndExit(exitCode, peek === null ? stderr : `${stderr}\n\n${peek}`);
}
// … (the later claimLease / maybeStreamOutput / maybeDriveInbound path is unchanged;
//     remove the now-duplicate `const cwd = extractCwd(raw)` that was here) …
```

**Test fixtures** (mirror `stop.test.ts` / `stop_drive.test.ts` harness — a drift-emitting
pack + a pending umbrella inbox + lease held by the session):

```ts
it('a drift-blocked stop SURFACES pending inbound in stderr (run not driven, not acked)', async () => {
  /* pack stop-rule → exit 2 'DRIFT...'; umbrella inbox has 1 unacked row; lease == SESSION.
     Run the stop bin → stderr contains BOTH /DRIFT/ AND the inbox envelope text;
     stdout has NO {decision:'block', reason:<inbox>} drive; acked.jsonl unchanged. */
});
it('a drift-blocked stop with NO pending inbound is unchanged (stderr = drift only)', async () => {
  /* empty inbox → stderr is exactly the drift text, no envelope appended. */
});
```

**Acceptance criteria:**

- [ ] drift block + pending inbound → stderr contains the drift text AND the inbox envelope
- [ ] the message is NOT acked by surfacing (it still drives at the next clean stop)
- [ ] drift block + empty inbox → stderr unchanged (drift only)
- [ ] a CLEAN stop still drives inbound exactly as before (no regression — existing `stop` tests green)
- [ ] full gate chain green

**Risk callouts:** `cwd` is now read before the drift branch — ensure the later code does not
re-declare it (remove the old `const cwd = extractCwd(raw)`). The clean-stop drive path
(`maybeDriveInbound`) must be byte-for-byte unchanged — surfacing is additive only.
**References:** `src/runtime/hooks/stop.ts:106-135`; `src/runtime/hooks/hook_output.ts` (`emitDriftStderrAndExit`, `squidPrefix`); SF.1's `maybePeekInbound`.
**Verification commands:** `pnpm vitest run src/runtime/hooks/ && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: confirm `emitDriftStderrAndExit` signature + that it exits. 3 code: move cwd + peek-and-append. 4 test: surface-on-drift + no-regression on clean drive. 5 audit: clean-drive path unchanged; not acked. 6 post-research: n/a. 7 fix.

---

### Task SF.3: CHANGELOG + version bump

**Required skills:** opensquid release expert; Audit expert.
**Deliverable:** CHANGELOG entry + patch version bump.
**Depends on:** SF.1, SF.2 (green).

**Files affected:**

- `CHANGELOG.md` (modify) — the SF entry under a new version heading.
- `package.json` (modify) — patch bump.

**Key code shapes:** standard Keep-a-Changelog `### Fixed` block describing the stop-hook
inbound surfacing.
**Test fixtures:** n/a; `pnpm format:check` validates the `.md`.
**Acceptance criteria:**

- [ ] CHANGELOG entry present under the new version
- [ ] `package.json` version bumped + verified (name+version re-read)
- [ ] `pnpm format:check` green

**Risk callouts:** the bump is a MUTATION — re-read `package.json` after editing; run
`format:check` LAST (after the CHANGELOG is authored).
**References:** `CHANGELOG.md` head; `package.json`.
**Verification commands:** `pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: read current version. 3 code: bump + entry. 4 test: format:check. 5 audit: version re-read. 6 n/a. 7 fix.
