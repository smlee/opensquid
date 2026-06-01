# session-connection-check

The first consumer of the **`session_start`** trigger / SessionStart hook
mechanism shipped in T-HANDOFF-HARDENING HH6.1. On session begin it surfaces
the project's chat-connection state so the agent (and you) know inbound chat is
actually wired before any work starts — the convention "check chat connections
at session start" with real enforcement behind it.

## What it reports

`check_chat_connection` (the primitive) composes a one-shot `inject_context`:

- **telegram configured** (routing + bot token present) → reports the topic and
  whether a `chat watch` **live-session lease** is held (i.e. whether THIS
  session will actually receive inbound), nudging you to start
  `opensquid chat watch` (via the harness `Monitor`) if not;
- **another platform configured** (slack/discord) → reports that telegram isn't
  wired for this project;
- **nothing wired** → nudges `opensquid setup`.

It also runs a **generic umbrella-drift check**: projects sharing one report
destination (channel + topic) form an "umbrella" and should carry consistent
inbound routing; if they've drifted (e.g. one routing file lost its inbound
fields), the report flags it. No hardcoded project UUIDs — the umbrella is
derived from whatever shares a destination.

## How it fires

1. Claude Code fires `SessionStart` → `opensquid-hook-sessionstart` dispatches a
   `session_start` event.
2. This skill's `triggers:` matches; its rule calls `check_chat_connection`.
3. The primitive's `inject_context` return is aggregated by the dispatcher
   (HH6.1 widened inject_context surfacing to `session_start`) and emitted by
   the hook bin as `hookSpecificOutput.additionalContext`.

## Opt-out

Set `chat.session_start_check: "off"` in `~/.opensquid/config.json` and the
primitive returns nothing (no injection) — for users who don't want a chat
system.

## Report-only

Per [[project_opensquid_no_agent_loop]], the check never starts `chat watch`,
spawns the agent-bridge daemon, or repairs routing. It reports; the agent acts.
