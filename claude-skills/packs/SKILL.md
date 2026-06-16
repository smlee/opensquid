---
name: packs
description: >
  Show every opensquid pack with its state (off / local / global) and change them. Use when the user
  says /packs, "manage packs", "turn a pack on/off", "make a pack local or global", or "which packs
  are active". Local = the project Claude was started in. This is the Claude Code front-end over the
  `opensquid pack` CLI (which is the cross-harness path).
---

# /packs — pack scope manager

Each opensquid pack has one of three states: **Off** (not active anywhere), **Local** (active only in
the project this session was started in), or **Global** (active in every repo, across every harness).
A change takes effect on the **next tool call** — no restart.

Do this:

1. Run `opensquid pack list --json` and parse the rows (`[{ name, state, origin }]`).
2. Render a compact table: each pack, its current state (Off / Local / Global), and origin
   (builtin / user / project).
3. Ask the user which packs to change and to what, using AskUserQuestion (one question per pack being
   changed; options: Off, Local, Global — mark the current state).
4. Apply each change with `opensquid pack set <name> <state>`.
5. Confirm what changed, and that it takes effect on the next tool call (no Claude restart needed).

Notes:

- "Local" writes the project's `.opensquid/active.json`; "Global" writes the user-level
  `~/.opensquid/active.json`.
- Everything here is also available directly as `opensquid pack set` / `opensquid pack list` — that CLI
  is the path for any harness, not just Claude Code.
