# Research — the REAL scope of chat legacy removal (CAT.8) (2026-06-04)

From the `/research-audit` of the chat system + the follow-up dependency tracing. Corrects
the audit's code-lens "one function to port" with the verified data-lens picture, so the
removal track is scoped to expert depth BEFORE touching live chat (the remote terminal).

## §1 — The architecture is a DELIBERATE, staged migration (not accidental half-state)

- **Setup side** writes the legacy **`chat-routing.json`** per-project model
  (`report_channel`, `inbound_topic_ids`, `auto_bound`). Live writers: the setup wizard —
  `src/setup/cli/topic_create_step.ts` (reads `report_channel`, writes `auto_bound` via the
  legacy `resolveOrCreateTopic`) and `src/setup/cli/chat_actions_test_step.ts`.
- **Runtime side** reads the umbrella-keyed **`channels.json`** (`src/channels/routing.ts`).
  The live daemon (`src/channels/`) does NOT read `chat-routing.json` at all.
- **The bridge** is `src/channels/migrate.ts` (CAT.1d, `opensquid chat migrate`): a one-shot,
  NON-destructive synthesis of `channels.json` FROM the legacy per-project files (groups
  uuids by `(report_channel, report_topic_id)` → umbrellas, collapses the da96≡0742 mirror).
- **`src.legacy` deletion is the planned `CAT.8`** (named in `migrate.ts:18` — "src.legacy
  deletion is CAT.8"). So removing legacy is a KNOWN, scheduled step, not a surprise.

The other 5 "consumers" the first grep flagged were COMMENTS/history (`paths.ts`,
`channels/routing.ts`, `check_chat_connection.ts`, `chat-bridge-server.ts`, `watch_cli.ts`).
The only live `chat-routing.json` code is the 2 setup files.

## §2 — Audit answers (recap, verified)

- **Slow vs instant:** NOT a chat-code perf regression (refuted). It is the live-session
  `UserPromptSubmit` turn-boundary injection (`runtime/chat/inbox_inject.ts`) — a harness
  constraint. The dedicated-agent path is already instant.
- **Inferior vs past:** NO — the new umbrella model is BETTER (structural one-topic invariant
  `channels/routing.ts:69-83`; the project-UUID mirror hack is gone).
- **Duplication (the slop):** ~225 LOC daemon-client copy-paste → **FIXED by CL.1**
  (`src/chat_daemon/client.ts`, shipped 0.5.330).

## §3 — Why "port the resolver" is the WRONG move

Porting `resolveOrCreateTopic` into `src/` drags the legacy `chat-routing.json` routing
helpers (`routing.js`) with it — relocating the deprecated data model into the new tree just
to delete a folder. That is moving slop, and violates Simplicity. The CLEAN removal is to
finish the setup-side migration to `channels.json`, after which the resolver is moot.

## §4 — The real removal track (CAT.8 finalize) — to scope+author when run

1. **Extract the shared umbrella-topic helper** — pull the resolve-umbrella → create-one-
   topic → write-back-`topic_id` core out of `functions/ensure_umbrella_topic.ts` into a
   reusable `src/channels/umbrella_topic.ts` (behavior-preserving; the SessionStart assurance
   keeps its daemon-live gate + fail-quiet wrapper). SAFE (pure refactor, no live-routing
   change). The wizard's `create_topic` uses CL.1's client (add a `createTopic` method).
2. **Migrate `topic_create_step` (wizard) to `channels.json`** — resolve cwd→umbrella, read
   `chat_id` from the umbrella row (not `report_channel`), create via the shared helper, write
   `topic_id` back to `channels.json`. Delete `loadLegacyResolver()` + the `dist/chat/daemon`
   dynamic import. ⚠ TOUCHES LIVE SETUP — verify against the running daemon's `channels.json`.
3. **Migrate `chat_actions_test_step`** read off `channels.json` (or retire it).
4. **Decide `migrate.ts`'s fate** — keep `opensquid chat migrate` for EXISTING users' one-time
   upgrade (their `chat-routing.json` → `channels.json`), but new setups write `channels.json`
   directly so the bridge isn't on the new-setup path.
5. **CAT.8 delete** — `git rm src.legacy/chat`, drop the dead `dist/chat/daemon` build + the
   tsconfig exclude; daemon route+send smoke + CI green.

## §5 — Risk / discipline note

This touches the live chat config (the user's remote terminal). Per the user's own bar
(research-to-expert-depth before changing; don't break things), execution should be a
focused run with the daemon smoke-check between slices — NOT rushed. §1–4 above are the
expert-depth research that run needs; the safe first slice (§4.1, the pure refactor) can lead.

## §6 — Status

- CL.1 (shared client) — SHIPPED 0.5.330, CI green (`f5c5170`).
- CL.2–4 (this track) — superseded by §4; re-scope as the CAT.8 finalize track above.
