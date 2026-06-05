# Pre-research — T-CHAT-NATIVE-CHANNEL (replace the chat contraption with a `claude/channel` node)

**Date:** 2026-06-05 · **Repo:** opensquid · **Area:** chat delivery architecture (root rewrite)
**Supersedes:** the Monitor-watcher scope (`T-chat-realtime-session-setup`) — that patched the
contraption; this removes it. **Origin:** the user's diagnosis that the chat stack is "overly
complex for no reason" and "not properly using the NPM package." Confirmed true.

---

## 1. The definitive finding (one capability + one notification)

A Claude Code **channel** is just an MCP server (`@modelcontextprotocol/sdk`) that declares one
capability and pushes one notification:

```ts
// declaration (telegram plugin server.ts:385-394)
new Server({...}, { capabilities: { tools: {}, experimental: { 'claude/channel': {} } } })

// inbound delivery (server.ts:963-977) — this is what WAKES the session, idle or not:
mcp.notification({ method: 'notifications/claude/channel',
  params: { content, meta: { chat_id, message_id, user, user_id, ts, image_path? } } })
```

Claude Code renders that notification as a `<channel source=… chat_id=… …>` block injected into
the session, and the server exposes a `reply` tool for outbound. No file, no poll-by-the-agent,
no hooks.

**opensquid already has every ingredient and uses the SAME NPM packages:** `@modelcontextprotocol/sdk`
(its `src/mcp/chat-bridge-server.ts` is an MCP server) and `grammy ^1.43.0` (same lib as the
official plugin; full bot already in `src/channels/adapters/telegram.ts` + `daemon/worker.ts`).
The ONLY gap: `chat-bridge-server.ts:495-497` declares `{ capabilities: { tools: {} } }` — it
NEVER declares `experimental['claude/channel']` and NEVER sends `notifications/claude/channel`.
So instead of native injection, it reinvented delivery as: chat-daemon → `inbox/*.jsonl` →
`chat watch` watcher → Stop-hook drive / UPS drain → lease arbitration. **Every one of those
exists only to reproduce what the two lines above give for free.** This is the "improper use of
the package" exactly.

**Why opensquid couldn't just use the official plugin:** server.ts:415 — _"Groups are
intentionally excluded"_ — the official Telegram plugin deliberately drops supergroups/topics for
security. The user's multi-topic requirement is real and unmet by it. opensquid solved a real
problem the wrong way.

## 2. The genuinely-hard part the daemon was actually for (must be preserved)

The native model assumes **one bot ⇄ one session**. opensquid's real requirement is
**one bot token, many topics → many sessions**: supergroup `-1003923174632` topic 15 → the LOOP
session; topic 281 → the RAUMPILATES session. Two hard constraints make this non-trivial:

- **Telegram allows exactly ONE `getUpdates` consumer per bot token** (plugin server.ts:56). So
  multiple sessions cannot each poll the same bot — there must be a single consumer.
- **Per-topic → per-umbrella routing**: a message on a topic must reach the session whose umbrella
  owns that topic (`channels.json` `members`/`topic_id`), not just "whatever session loaded the
  channel."

A naive "make `chat-bridge-server` a channel" breaks both (every session would try to poll the bot
→ 409 conflict; no topic routing). So the redesign must KEEP a single broker that owns the one
`getUpdates` consumer and routes by topic — and replace only the DELIVERY tail.

## 3. Design — native injection tail + single-broker routing (chosen)

Split cleanly into "the one consumer + router" (keep) and "delivery to the session" (replace):

- **The broker (keep, slimmed):** ONE process owns the single `grammy` `getUpdates` consumer and,
  per inbound message, resolves `(chat_id, message_thread_id) → umbrella` via `channels.json`, then
  routes the message to that umbrella's live session over the existing UDS. (This is the daemon's
  legitimate job — single consumer + routing — and the only reason a daemon exists.)
- **The delivery tail (replace):** each session runs a thin **`claude/channel` MCP shim** (the
  refactored `chat-bridge-server`): it declares `experimental['claude/channel']`, connects to the
  broker for ITS umbrella's stream, and on each routed message emits
  `notifications/claude/channel` with `meta.thread_id = message_thread_id` (TOPIC carried natively)
  → the session wakes and responds, idle or not. Its `reply` tool calls
  `bot.api.sendMessage(chat_id, text, { message_thread_id })` — topic-aware outbound.
- **Multi-app:** one channel shim per app (Telegram first; Discord/Slack later) over a small shared
  channel-protocol core (the `notifications/claude/channel` envelope + reply contract). Per-app
  nodes keep each bot SDK isolated and match the plugin pattern — chosen over one mega-node.

**This DELETES** (becomes dead once the shim ships + is verified): `inbox/*.jsonl` as a delivery
path, `chat watch`/`inbound_watch.ts`, `stop_drive.ts` (`maybeDriveInbound`/`maybePeekInbound`),
the UPS inbox drain (`inbox_drain.ts`), the lease machinery (`live_session_lease.ts`,
`claim_lease.ts`), and the SF.1/SF.2 mid-run surfacing shipped earlier today. And it dissolves
EVERY bug chased today (idle non-delivery, stale lease → dead session, hook-timing, mid-run
starvation, 80s latency) — all artifacts of the deleted tail.

## 4. The linchpin — RESOLVED (official docs, via claude-code-guide 2026-06-05)

Answered authoritatively against https://code.claude.com/docs/en/channels.md +
channels-reference.md (research preview, updated 2026-06-03):

- **The `experimental['claude/channel']` capability ALONE is NOT sufficient.** The server must
  ALSO be named in `--channels`. Per the docs: _"Being in `.mcp.json` isn't enough to push
  messages: a server also has to be named in `--channels`."_ Without it the server connects + its
  tools work, but `notifications/claude/channel` are silently dropped.
- **A CUSTOM, locally-defined MCP server CAN be a channel** — two load paths: dev/research-preview
  `claude --dangerously-load-development-channels server:<name>` (name = the `mcpServers` key;
  bypasses the allowlist), or production = package as a plugin (`.mcp.json` + marketplace entry)
  loaded via `--channels plugin:<name>@<marketplace>` (or org `allowedChannelPlugins`).
- **Topics work natively.** Inbound contract is `params: { content: string, meta?: Record<string,
string> }`; every `meta` key (identifier chars `[a-zA-Z0-9_]` only — `thread_id` is valid)
  passes through as a `<channel … thread_id="…">` attribute. `source` is auto-set from the Server
  name. So `meta.thread_id = message_thread_id` gives topic-native delivery for free, exactly as
  designed.

**Consequence for the scope:** RS.0 is no longer a feasibility unknown — it becomes a concrete
proof + the loader wiring. opensquid's session launch must include the channel via
`--dangerously-load-development-channels server:opensquid-chat` (now/dev) or a packaged plugin
(prod). RS.0 = build the minimal `claude/channel` opensquid server, load it that way, confirm a
real `<channel>` block injects into a live session. Low-risk; the contract is documented + firm.

## 5. Alternatives weighed

| #     | Option                                                                                      | Verdict                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Keep the file-inbox + add the Monitor watcher (prior scope)                                 | ❌ Patches the contraption; leaves all its bugs; the user explicitly rejected the complexity.                                                 |
| B     | Use the official plugin as-is                                                               | ❌ DM-only; drops supergroups/topics by design. Fails the core requirement.                                                                   |
| C     | Make `chat-bridge-server` a channel, one poller per session                                 | ❌ Breaks Telegram's single-`getUpdates` rule (409s) and has no topic→umbrella routing.                                                       |
| **D** | **Single broker (one consumer + router) + per-session `claude/channel` shim w/ topic meta** | ✅ **Chosen.** Native injection (idle wake, no watcher), keeps the one hard part (single consumer + routing), deletes the rest, topic-native. |

## 6. Inversion — how could this be wrong?

- **The capability needs `--channels`/plugin packaging** → caught by the RS.0 spike before any
  rewrite; scope absorbs the packaging if so.
- **Two sessions, same umbrella** → the broker routes to the umbrella's lease/live session (the one
  surviving use of a lease — far smaller than today's machinery), or the last-connected shim wins;
  decide in spec.
- **Outbound topic threading** → `message_thread_id` is a first-class `grammy` `sendMessage` option;
  low risk. A test asserts a topic round-trip (inbound thread_id → reply to same thread).
- **Migration / no flag-day** → ship the shim alongside the existing path, cut over per-umbrella,
  delete the contraption only after a live topic round-trip passes on both umbrellas.

## 7. Empirical spike / verification reality

RS.0 (the channel-injection spike) is the make-or-break and is a live test. Beyond it: the shim's
`notifications/claude/channel` envelope + reply-thread routing are unit-testable (stub MCP
notification sink + stub grammy), but final acceptance is a LIVE topic round-trip on both umbrellas
(send to topic 15 → loop session wakes idle + replies in the topic; same for 281 → raumpilates).
Stated honestly; not claimed as unit-covered.

## 8. Decomposition (draft — the spec authors the real tasks)

- **RS.0** — spike: prove a custom opensquid-loaded MCP server can inject via
  `notifications/claude/channel` (decides packaging). BLOCKING.
- **RS.1** — the broker: single `getUpdates` consumer + `(chat_id, thread_id) → umbrella` router
  over UDS (slim the existing daemon to just this).
- **RS.2** — the per-session `claude/channel` Telegram shim: capability + inbound notification with
  `thread_id` + topic-aware `reply` tool (refactor `chat-bridge-server.ts`).
- **RS.3** — cut over per umbrella; delete the contraption (inbox-delivery, watcher, stop_drive,
  inbox_drain, lease) once the live round-trip passes.
- **RS.4** — docs + CHANGELOG/version + the live-test checklist.

No unresolved scoping items — the mechanism is fully read from the package; the one feasibility
unknown (custom-server channel registration) is isolated as the blocking RS.0 spike, not left open.
