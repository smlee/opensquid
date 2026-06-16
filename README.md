![OpenSquid banner](https://raw.githubusercontent.com/smlee/opensquid/main/banner.png)

# OpenSquid

[![CI](https://github.com/smlee/opensquid/actions/workflows/ci.yml/badge.svg)](https://github.com/smlee/opensquid/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opensquid)](https://www.npmjs.com/package/opensquid)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

OpenSquid gives your coding agent continuity: memory, ready work, gates, and a path across devices.

It is an MCP operating layer that adds durable memory, dependency-aware task state, workflow gates, inspectable packs, and chat bridges to the agent you already use. The agent still writes code. OpenSquid keeps the state it should not be inventing in prose: what it remembers, what is ready, what is blocked, which process gates passed, and which lessons are still only proposals. The long-term direction is to carry that same continuity across devices, models, and local capabilities.

`opensquid` is the package, CLI, MCP server name, and `~/.opensquid/` data root. OpenSquid is the human-facing wordmark.

> **Status, June 12, 2026.** Pre-1.0 and moving fast (`0.5.x`). The tool surface is usable but not frozen. This README is a front-door draft for the current architecture, not a stability promise.

## Quickstart

```bash
npm install -g opensquid
```

Register the MCP server with Claude Code:

```bash
opensquid setup wizard mcp
```

Optional hooks:

```bash
opensquid setup wizard hooks
opensquid doctor hooks
```

Using codex? The same gates install inside codex CLI (its hook protocol is Claude Code-compatible):

```bash
opensquid setup wizard codex-hooks   # then trust the entries via /hooks inside codex
opensquid doctor codex-hooks
```

Restart your MCP host. Your agent now has tools for memory, task graph state, pack inspection, workflow phase logs, and lesson capture.

Try it from an agent session:

```text
"Remember that this repo uses pnpm and that README claims need source-grounded checks."
    -> memorize

"What is ready to work on next?"
    -> workgraph_ready

"Create a task for tightening the README quickstart, blocked by verifying the install command."
    -> workgraph_create_issue + workgraph_add_edge

"I finished pre-research and test for this task."
    -> log_phase

"That correction should become a lesson."
    -> store_lesson
```

The important split: the agent can propose and record. The gates decide what is actually ready, complete, or promoted.

## Why It Exists

Coding agents usually fail in predictable ways:

- They forget project preferences and prior decisions between sessions.
- They lose track of task dependencies and start whatever looks nearby.
- They skip process when the conversation gets long.
- Their internal state is invisible, so you cannot tell whether the safety net is on.
- They decide what they "learned" from their own output, even when the lesson is wrong.

OpenSquid treats those as continuity problems. Memory, task state, workflow phase logs, pack rules, and chat routing should live outside the agent turn. The agent can use them through MCP tools, but it does not own the source of truth. Device capability state belongs on the same path as OpenSquid grows beyond one machine.

| Without OpenSquid                                | With OpenSquid                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| The agent says it remembers.                     | Memory is stored under `~/.opensquid/` and recalled through MCP.        |
| The agent picks the next task from chat context. | `workgraph_ready` returns unblocked work.                               |
| The agent claims tests or research happened.     | `log_phase` writes a phase ledger that gates can read.                  |
| The agent promotes its own lesson.               | `store_lesson` captures a candidate; promotion stays gated.             |
| Rules live in one long prompt.                   | Packs make rules, skills, state machines, and drift policy inspectable. |
| Work is trapped on one machine.                  | Synced state can let another device resume the same agent workspace.    |

## The Operating Model

OpenSquid is built from six pieces that work together.

| Layer          | What it gives the agent                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Memory         | `recall`, `memorize`, and `forget` over a durable local store, with user-authored memories protected from quiet eviction.      |
| Workgraph      | Issues, blockers, dependency edges, ready queues, and append-only event history for task state.                                |
| Workflow gates | Phase logging and hook-enforced process checks, including the seven-phase coding flow when that pack is active.                |
| Packs          | Portable rules, skills, state machines, models, drift policies, and chat-agent bindings.                                       |
| MCP + hooks    | Agent-facing tools through MCP, plus optional hooks (Claude Code and codex) that catch drift even when no tool is called.      |
| Handoffs       | Deterministic session handoffs: `opensquid handoff`, a session-end backup, and lazy generation that survives a killed session. |
| Sync + devices | A path for multi-device memory/workgraph continuity and future routing to device-specific capabilities.                        |

The shape is deliberately agent-native. Instead of asking a model to remember a process in its prompt forever, OpenSquid exposes the process as tools and state:

```text
recall context -> inspect packs -> claim ready work -> log phases -> publish result
        ^              |                 |              |             |
        |              v                 v              v             v
     memory         packs          workgraph       gates       chat/reporting
        \______________ synced agent workspace / device fabric _____________/
```

## First Loop

A typical OpenSquid-backed agent turn looks like this:

1. Recall relevant memory with `recall`.
2. Inspect loaded packs and skills with `list_packs`, `list_skills`, and `inspect_skill`.
3. Pull ready task state from the workgraph with `workgraph_ready`.
4. Create or update issues with `workgraph_create_issue`, `workgraph_update_issue`, and `workgraph_add_edge`.
5. Log the actual workflow phases with `log_phase`.
6. Publish progress through normal chat or the chat bridge.
7. Store candidate lessons with `store_lesson`; promotion stays behind the gate.

For other MCP hosts, point the host at the server entrypoint:

```json
{
  "mcpServers": {
    "opensquid": {
      "command": "node",
      "args": ["/abs/path/to/opensquid/dist/mcp/server.js"]
    }
  }
}
```

Useful entrypoints:

| Entrypoint                       | Purpose                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `dist/cli.js`                    | Main CLI.                                                                        |
| `dist/mcp/server.js`             | Primary OpenSquid MCP server.                                                    |
| `dist/mcp/chat-bridge-server.js` | Chat bridge MCP server.                                                          |
| `opensquid handoff`              | Generate a session handoff (doc, memory block, workgraph, chat) from disk state. |
| `opensquid chat watch`           | Stream new inbound chat messages into a live agent session.                      |
| `opensquid agent-bridge start`   | Start the always-on chat agent bridge.                                           |

## MCP Tool Surface

The primary MCP server exposes tools in four groups.

### Memory

| Tool       | Purpose                                                               |
| ---------- | --------------------------------------------------------------------- |
| `recall`   | Search relevant memories for a query.                                 |
| `memorize` | Save a memory; user-authored memories are eviction-immune by default. |
| `forget`   | Delete a memory by id; protected memories require `force: true`.      |

### Lessons

| Tool           | Purpose                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `store_lesson` | Capture a candidate workflow, preference, or skill-upgrade lesson for validation. |

There is intentionally no agent-callable `promote` MCP tool. The agent may propose a lesson; it does not get to promote its own lesson into durable rule state.

### Workgraph

| Tool                     | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `workgraph_create_issue` | Create an issue in the local work graph.             |
| `workgraph_update_issue` | Update title, body, or status.                       |
| `workgraph_add_edge`     | Add a dependency edge such as `blocks` or `related`. |
| `workgraph_ready`        | List open issues with no unclosed blockers.          |
| `workgraph_get`          | Read one issue.                                      |
| `workgraph_list`         | List issues by status.                               |
| `workgraph_events`       | Read append-only history for an issue.               |

### Inspection And Workflow

| Tool                | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `log_phase`         | Record completed workflow phases for the active task.      |
| `list_packs`        | List loaded packs.                                         |
| `list_skills`       | List skills, optionally scoped to a pack.                  |
| `inspect_skill`     | Show one skill's rules, load conditions, and drift policy. |
| `read_state`        | Read session state.                                        |
| `read_violations`   | Read the session violation log.                            |
| `list_drift_events` | List drift events across packs and session state.          |

The chat bridge MCP server adds:

| Tool              | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `chat_send`       | Send a message through the configured chat platform. |
| `chat_poll_inbox` | Read inbound chat messages from the project inbox.   |

## Workgraph

The workgraph is the task state agents usually fake in prose.

It stores issues, statuses, dependency edges, and event history. `workgraph_ready` is the key operation: it answers "what can be worked on next?" from the graph instead of from recency or guesswork. A blocked task stays blocked until its blockers close.

The architecture is local-first. The durable truth is an append-only operation log; libSQL is the queryable projection. That gives OpenSquid reviewable, git-friendly history without making the agent hand-edit a graph file.

## Packs

Packs are the unit of behavior. A pack can contain:

- `manifest.yaml` for identity and metadata.
- `models.yaml` for abstract model aliases.
- `notifications.yaml` for routing.
- `drift_response.yaml` for drift policy.
- `fsm.yaml` for workflow state machines.
- `skills/` for rule and tool definitions.
- `lessons/` for validated knowledge.
- `chat_agent.yaml` for always-on chat behavior.

This matters because OpenSquid is not a bundle of one user's personal workflow. The product is the runtime and format. Your rules, gates, and agent personality live in packs you can inspect, edit, version, and move.

### Turning packs on and off

Every pack has one of three states, set with a single command:

```text
opensquid pack set <name> off      # not active anywhere
opensquid pack set <name> local    # active only in this project (the directory you started in)
opensquid pack set <name> global   # active in every repo, across every harness
opensquid pack list                # every known pack and its current state
```

`local` writes the project's `.opensquid/active.json`; `global` writes your user-level
`~/.opensquid/active.json`. A change takes effect on the **next tool call** — no need to restart
Claude (or any harness). Because activation lives in OpenSquid's own `active.json`, a `global` pack is
active in **every** harness OpenSquid runs under (Claude Code, Codex, …), not just one.

In Claude Code, `opensquid setup wizard hooks` also installs a **`/packs`** slash command — an
interactive front-end over the same verbs (list the packs, pick new states, applied via the CLI). It
appears immediately if you already have a `~/.claude/skills/` directory; if the wizard had to create
that directory, restart Claude once so it starts watching. (If you'd rather not run the wizard, copy
`claude-skills/packs/SKILL.md` from the package into `~/.claude/skills/packs/SKILL.md`.) The `opensquid
pack` CLI remains the path for every other harness.

## Workflow Gates

OpenSquid's gates exist because agents are good at saying a process happened and bad at proving it happened.

The current coding flow can require distinct phases such as:

```text
pre_research -> learn -> code -> test -> audit -> post_research -> fix
```

When active, the commit gate reads the phase ledger written by `log_phase`. Hooks can also catch drift patterns before tool execution, at stop time, or on session start. The important property is that process state is outside the model's narration. The agent logs what it did; the gate decides whether that is enough.

The gates bind to the agent, never to you. Agent-spawned git commands are recognized by the environment markers agent hosts set; your own terminal passes through and git behaves normally, with commits still recorded in the provenance trail.

## Memory And Lessons

OpenSquid separates memory from lessons.

Memory is durable context: preferences, facts, decisions, project notes. The agent can recall it and, with verification, write it.

Lessons are proposed behavioral changes. A lesson can be captured during work, but promotion is gated. User-authored content is protected; agent-authored content has to earn trust through the validation path. This is the anti-self-grading promise: the model does not get to be the sole judge of what the model learned.

## Chat

OpenSquid can connect an agent to Telegram, Discord, or Slack.

There are two delivery paths:

- `chat watch` streams new inbound messages into a live session.
- `agent-bridge` handles messages when no live session is open.

Both use the same project routing and lease model so the live session and always-on daemon do not intentionally answer the same message. The chat tools stay MCP-shaped: the agent reads with `chat_poll_inbox` and replies with `chat_send`.

## Session Handoffs

Sessions end; work does not. `opensquid handoff` generates a handoff from disk state — never from the model's narration — across four surfaces: a handover document with mechanical resume steps, a managed block in the agent's memory file, a workgraph issue, and a chat digest.

Three triggers cover the failure modes:

- The explicit command, for when you or the agent knows it is handoff time.
- A session-end backup, gated so trivial sessions do not generate noise.
- Lazy generation at the next session start, which recovers even a killed session from its on-disk state.

Artifact paths carry content hashes so the next session verifies disk truth instead of trusting prose. An optional `--narrate` flag adds an LLM-written summary layer on top; the deterministic dump stays the record either way. This is the session-level half of the continuity promise below.

## Continuity Across Devices

OpenSquid is not meant to be local-only. Local state is the trust base: fast, inspectable, recoverable, and usable offline. The larger product direction is cross-device continuity for AI power users.

The same user may move between a home machine, work laptop, remote server, local-LLM box, cloud IDE, and chat interface. OpenSquid should make those feel like one agent workspace. Memory, workgraph state, active-task state, packs, gates, and lessons can sync through the cloud when enabled. Over time, device and capability metadata can let one harness discover that another device has the model, tool, repository, or channel needed for a task.

The promise is simple: start anywhere, continue anywhere, and eventually use the capabilities of every device you own.

## Storage

OpenSquid stores local state under `~/.opensquid/`.

The implementation uses plain files where they are the right source of truth and libSQL where indexed queries are the right interface. Memory and lessons use the in-process libSQL + fastembed stack by default, with lexical and Ollama-backed options available through RAG configuration. The design goal is durable state: inspectable local data, rebuildable projections, and a cloud-sync path that adds continuity without making local development depend on a remote service.

## Other Hosts

OpenSquid is just MCP at the boundary. Claude Code is the dogfood target, but any host that can launch a local MCP server can point at `dist/mcp/server.js`.

codex CLI gets more than tools: its hook protocol is Claude Code-compatible, so `setup wizard codex-hooks` installs the same gating and drift checks inside codex sessions, including its `apply_patch` file edits.

Hermes Agent can use OpenSquid the same way: add the MCP server alongside the user's existing Hermes memory backend. OpenSquid should be framed as additive rule and state discipline, not as a replacement runtime.

## Current Status

Works today:

- Primary MCP server with memory, lesson capture, workgraph, pack inspection, drift inspection, and workflow phase tools.
- Chat bridge MCP server with send and inbox polling.
- Local workgraph with ready queries and event history.
- Pack runtime with YAML schemas, skills, drift policies, state-machine support, and chat-agent bindings.
- Optional hooks for workflow and drift enforcement in Claude Code and codex CLI.
- Deterministic session handoffs with automatic backup and recovery triggers.
- Git gates that bind to the agent and pass humans through, with commit provenance.
- Multi-host MCP setup paths for local development.

Still evolving:

- npm distribution polish and release ergonomics.
- Public tool-surface stability before 1.0.
- More polished first-run setup for every host and chat path.
- The final default pack set.
- Public docs beyond this front-door README.

## Docs

Start here when you need the deeper contracts:

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — **the single source of truth**: how every subsystem connects + what gets brittle when you change something. Read this first.
- [`docs/pack-runtime.md`](./docs/pack-runtime.md)
- [`docs/pack-fsm-architecture.md`](./docs/pack-fsm-architecture.md)
- [`docs/skill-grammar-guide.md`](./docs/skill-grammar-guide.md)
- [`docs/flows.md`](./docs/flows.md)
- [`CHANGELOG.md`](./CHANGELOG.md)

## License

MIT. See [LICENSE](./LICENSE).
