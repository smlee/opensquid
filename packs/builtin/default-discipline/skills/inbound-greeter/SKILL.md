# inbound-greeter

A reference skill demonstrating the **`inbound_channel`** trigger shipped in
T-L3-LOOP (opensquid 0.5.227 → 0.5.232). On any inbound chat message reaching
this session, emits a `surface` verdict acknowledging receipt.

## How the trigger fires

1. The chat-daemon receives a Telegram / Slack / Discord message + appends an
   `InboxRow` to `~/.opensquid/projects/<projectUuid>/inbox/<platform>.jsonl`.
2. The LL.3 inbound watcher (started by `opensquid chat watch`) chokidar-tails
   the file + reads the appended row.
3. The watcher resolves the live session via `live-session.lease` (LL.2). If
   no fresh lease, the row stays in inbox + an `unrouted.jsonl` entry is
   written (per pack-runtime.md §7.5).
4. The watcher fires an `InboundChannelEvent`
   (`{kind: 'inbound_channel', channelUri, sender, text, threadKey, receivedAt}`)
   against the session's loaded packs.
5. This skill's `triggers:` block matches; its `surface-acknowledgment` rule
   fires + emits a `surface` verdict.

## Reading the additionalContext

Separately, the LL.4 UPS hook drains unacked inbox rows into
`additionalContext` at the start of the agent's next turn (formatted as
`📨 Inbound messages (N)`). The skill's verdict + the UPS envelope coexist —
both reach the agent through the same prompt-submit hook payload.

## Customizing

- `channel: telegram` — fire only on Telegram messages
- `sender_pattern: '^(alice|bob)$'` — fire only when the named senders message
- Replace the rule's `verdict` with a richer process (call `llm_classify`
  for intent triage, then conditionally emit `directive` or `block`)

See [pack-runtime.md §2.4](../../../../docs/pack-runtime.md) for the full
`inbound_channel` trigger filter reference and §7.5 for inbound-specific
anti-patterns (best-effort dispatch; passive evaluators).
