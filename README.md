# 🦑 Open Squid

[![CI](https://github.com/smlee/opensquid/actions/workflows/ci.yml/badge.svg)](https://github.com/smlee/opensquid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

<!-- [![npm](https://img.shields.io/npm/v/opensquid)](https://www.npmjs.com/package/opensquid) — uncomment once published -->

Open Squid gives a coding agent two things it doesn't get out of the box: a memory that survives across sessions and across tools, and a gate that stops it from deciding for itself what it "learned."

It's an MCP server (plus a few optional Claude Code hooks) sitting on top of [`loop-engine`](https://github.com/MindcraftorAI/loop-engine), a small Rust memory substrate. The agent can read and write memories, and it can _propose_ lessons. A proposed lesson doesn't become a rule until it passes an evidence check, and anything you wrote yourself can't be quietly overwritten. That's the whole idea: the agent suggests, you decide.

```
   [proposed]  →  [active]  →  [promoted]
         ↘              ↘
      [discarded]   [superseded]
```

> **Naming.** "Open Squid" is the brand. `opensquid` (one word, lowercase) is the thing you actually type: the npm package, the CLI, the MCP server name, the `~/.opensquid/` config dir.

> **Status.** Pre-1.0 and moving fast (0.5.x right now). The tool surface isn't frozen yet. The MCP server reports its real version from `package.json`, so `claude mcp list` always shows what's actually running.

## Contents

1. [Why it exists](#why-it-exists)
2. [Setup](#setup)
3. [The tools your agent gets](#the-tools-your-agent-gets)
4. [The wedge](#the-wedge) — why the agent can't promote its own lessons
5. [Drift protection](#drift-protection-optional) — optional `git` safety hooks
6. [Chat](#chat) — Telegram/Discord/Slack, live and always-on
7. [Reference](#reference) — backends, the engine, other hosts, migration, layout
8. [Status, design, license](#status)

## Why it exists

Two things go wrong with an AI coding agent over time.

First, it forgets. The built-in memory is shallow and per-session, so you end up re-explaining your preferences and re-pasting the same context every morning. Open Squid gives it durable memory that's shared across sessions and across every MCP host on the machine, with semantic and keyword recall, so you say things once.

Second, it grades its own work. Leave an agent alone and it'll announce "I learned X" and treat that as settled, even when X is wrong. Open Squid splits learning into two steps. The agent proposes a lesson; the lesson only becomes a rule by passing an evidence gate (the "wedge"). Knowledge you authored yourself is protected from being overwritten by background curation.

The rest of this README is how those two ideas are wired up.

## Setup

```bash
# 1. Clone and build
git clone git@github.com:smlee/opensquid.git && cd opensquid
npm install && npm run build

# 2. Register the MCP servers with Claude Code (user scope = every project sees them)
node dist/cli.js setup wizard mcp
#   or by hand, pointing at the server entrypoint (not dist/index.js):
#   claude mcp add --scope user opensquid -- node "$(pwd)/dist/mcp/server.js"

# 3. Optional: install the drift-protection hooks
node dist/cli.js setup wizard hooks

# 4. Restart Claude Code and check
claude mcp list                 # opensquid should be listed
node dist/cli.js doctor hooks   # green means the hooks are wired
```

Storage lives in `~/.opensquid/`. Your agent now has `recall`, `memorize`, `store_lesson`, `log_phase` and the rest as MCP tools, plus a safety net on a few `git` mistakes if you installed the hooks.

A note on entrypoints, since it trips people up: the CLI is `dist/cli.js`, the MCP server is `dist/mcp/server.js`, the chat bridge is `dist/mcp/chat-bridge-server.js`. `dist/index.js` is just a library barrel with no CLI and no server, so don't point a host at it.

If you install globally and have `opensquid` on your `$PATH`, drop the `node dist/cli.js` prefix. For Claude Desktop, Cursor, or any other host, see [Other MCP hosts](#other-mcp-hosts).

## The tools your agent gets

Eleven of them. The more interesting design decision is what's _not_ here, which the [wedge](#the-wedge) section covers.

**Memory**

| Tool       | What it does                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall`   | Find memories for a query, up to `k` ranked hits. Recall is hybrid (semantic + text + RRF fusion), so a proper-noun query like _"Gianna"_ still lands even when pure vector search would miss it. Scope-aware. |
| `memorize` | Save a memory. The default `authored_by="user"` makes it eviction-immune. Scope defaults to user; project scope is picked up from your git repo. Embedded for semantic recall.                                 |
| `forget`   | Delete a memory by id. User-authored ones need `force: true`, which is the immunity doing its job.                                                                                                             |

**Lessons** (propose only)

| Tool           | What it does                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `store_lesson` | Capture a candidate lesson for review. Good for in-session corrections. There's no `promote` tool on purpose, so the agent can't graduate its own lesson. Promotion runs separately, against the gate. |

**Workflow**

| Tool        | What it does                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log_phase` | Record a finished workflow phase (`pre_research`, `learn`, `code`, `test`, `audit`, `post_research`, `fix`) for the active task. The commit gate stays shut until all seven are logged. |

**Inspection** (read-only)

| Tool                | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `list_packs`        | Currently loaded packs.                                  |
| `list_skills`       | Skills, optionally scoped to a pack.                     |
| `inspect_skill`     | A skill's rules, load conditions, drift policy.          |
| `read_state`        | A session-state key.                                     |
| `read_violations`   | The session's `violations.jsonl`.                        |
| `list_drift_events` | The drift catalog across packs plus the current session. |

Underneath sits the rest of `loop-engine`: causal-narrative generation, an HNSW vector store that survives restarts, compression that preserves citation chains, skill/persona/team scoping, and the 4-layer wedge ratchet.

## The wedge

This is the part that makes it more than a notes file. The agent can't promote a lesson to `promoted` on its own say-so. To get through the gate, a lesson has to carry:

- a structured causal narrative (`trigger` / `failure_mode` / `correction`)
- a confidence level (observed, inferred, or speculative)
- citations to memories the agent actually read (typed `EvidenceRef::Memory`)
- a clean pass through the time-floor, tampered-age, and thumbs-down checks
- optionally, multi-session reproducibility via the engine's `origin_diverse` signal

Your authorship is what carries weight. If you endorse a lesson, the memories it cites become eviction-immune. If the agent endorses its own, nothing is protected. The agent doesn't get to decide what it learned. You do, through the gate.

**Why there's no `promote` tool.** The whole lesson lifecycle (`promote`, `eliminate`, `supersede`, and the aggregate calls) runs as runtime and engine functions, not as agent-callable MCP tools. `promote` in particular is kept off the MCP surface so no client can reach around the gate. The agent proposes with `store_lesson`; promotion happens later, by automation, where the agent's own approval counts for nothing.

<details>
<summary>Skill authors: <code>promote_lesson</code> has two success shapes</summary>

A skill calling the `promote_lesson` runtime function gets back one of:

- `{status: 'promoted', detail: …}` if the gate passed
- `{status: 'blocked', reasons: […]}` if it didn't. `reasons` is kebab-case strings like `missing-external-signal-sources`, `missing-causal-narrative`, `insufficient-applied-count`, `time-floor`. A block is the gate working, not an error.

```yaml
process:
  - function: promote_lesson
    args: { id: '{lesson_id}' }
    bind: result
verdict: |
  if (result.status === 'blocked') return { kind: 'block', reasons: result.reasons };
  return { kind: 'promote' };
```

An actual failure (engine down, bad args) comes back as `kind: 'runtime'` instead, which is distinct from a block.

</details>

## Drift protection (optional)

Memory and lessons work with no hooks at all. If you also want a safety net on `git` work, Open Squid ships some Claude Code hooks that catch common mistakes even when the agent forgets to call a tool. They're opt-in, and every blocking gate fails open on opensquid's own bugs, so a bug here won't ever block your real work.

| Hook                         | What it catches                                                                                                                             | Skip with                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| PreToolUse — drift patterns  | `git commit --amend`, force-push to `main`, substrate-purity violations, implicit `git push`, and similar (`src/hooks/drift-patterns.ts`).  | `OPENSQUID_SKIP_DRIFT=1`                                   |
| PreToolUse — workflow gate   | A `git commit` while the active task is missing required phases. Per-task, survives `/resume`.                                              | `OPENSQUID_SKIP_WORKFLOW_GATE=1`                           |
| PreToolUse — versioning gate | A `git commit` that touches `src/` without a matching version bump. PATCH-only by default.                                                  | `OPENSQUID_SKIP_VERSION_GATE=1`                            |
| Stop — honesty ledger        | Claim-vs-action gaps. If the agent said "running tests" but never ran one, that's logged as a broken promise. (Recap text doesn't trip it.) | passive, no skip                                           |
| UserPromptSubmit             | Surfaces last turn's broken promises, a heartbeat re-anchor, and resume detection at the next prompt.                                       | `OPENSQUID_HEARTBEAT_TOKENS=999999999` mutes the heartbeat |
| SessionEnd                   | Clears the session ledger so disk usage stays bounded.                                                                                      | cleanup, no skip                                           |

```bash
node dist/cli.js setup wizard hooks   # writes the hook entries into ~/.claude/settings.json
node dist/cli.js doctor hooks         # checks the wiring (exit 0 = all green)
```

The installer brackets its entries with an `@opensquid: true` marker, so re-running the same version is a no-op, an upgrade rewrites only the opensquid block, and your other hooks are left alone. It also writes a project-scope `settings.json` when it finds an `.opensquid/` ancestor (`--user-only` skips that).

To skip a gate just once, prefix the command. It flips the gate off for that one invocation and there's no global state to remember to turn back on:

```bash
OPENSQUID_SKIP_WORKFLOW_GATE=1 git commit -m "wip"
OPENSQUID_SKIP_DRIFT=1 git push origin main
OPENSQUID_SKIP_VERSION_GATE=1 git commit -m "docs only"
```

Each bypass prints a loud `🦑 [opensquid <gate>] BYPASSED` line to stderr so it stays visible in your scrollback and in CI. Use it for emergencies. The gates are there because skipping them usually drops you straight into the mess they were stopping.

### The coding flow

The hooks above catch mistakes one at a time. The `coding-flow` pack is the bigger idea: it makes the agent _earn_ its way to a commit through three gated stages — SCOPE, then AUTHOR, then CODE — and won't let it skip ahead to the part it likes (writing code).

SCOPE means it writes a pre-research doc _before_ it touches code, and an adversarial reviewer — a separate model — reads that doc and returns `GUESS_FREE` only when every load-bearing claim is cited to a file, a memory, or your own words, and the simplest correct approach is justified against the alternatives it actually weighed. AUTHOR means a task spec complete enough to build from — real code in the spec, not hand-waving — checked the same way for `SPEC_COMPLETE`. Only then does CODE open, and the commit gate stays shut until all seven workflow phases are logged for the task.

It's the same bet as the wedge, one layer up: the agent doesn't get to decide its research was deep enough or its plan was sound. It proposes; the gate decides whether the work is real. In practice the reviewer is blunt — it'll reject a pre-research doc for an un-weighed alternative or a single uncited number, and it's usually right.

When a session starts (or resumes), a one-line-per-section manifest reports what the agent is actually connected to — chat, the flow gates, which packs are loaded, the daemon, the engine — so you're never guessing whether the safety net is on.

## Chat

Open Squid can wire a chat platform (Telegram, Discord, Slack) to your agent. There are three layers, and you only opt into as much as you want.

### The chat-daemon

One background process per machine owns each platform's connection. The reason is mundane: Telegram and most long-poll bot APIs only allow one consumer per token, so without a single owner the last project to start would steal the bot from the others. The daemon holds the one long-poll and fans out sends and per-project inbound routing.

```
┌──────────────────────────────────────────────────────┐
│ opensquid chat-daemon (per machine, auto-spawned)      │
│  · owns the single long-poll per platform              │
│  · reads ~/.opensquid/projects/<uuid>/chat-routing.json│
│  · inbound: routes by chat_id to a per-project inbox   │
│  · outbound: receives over a Unix socket / named pipe  │
└──────────────────────────────────────────────────────┘
        ▲                          ▲
┌────────────────────┐   ┌────────────────────┐
│ MCP server (proj A)│   │ MCP server (proj B)│
└────────────────────┘   └────────────────────┘
```

It auto-spawns on MCP-server boot when a `chat_connections` block exists (and does nothing otherwise), keeps a pidfile and log under `~/.opensquid/`, survives MCP-server restarts, and works on Windows (named pipes) as well as macOS/Linux (Unix sockets). Routing per project lives in `chat-routing.json` and re-reads within about 30 seconds, so routine edits don't need a restart.

The agent gets two tools here:

| Tool              | What it does                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_send`       | Send a message. `channel: "project:<platform>"` resolves to the project's report channel; an explicit `<platform>:<native_id>` works too. The reply's `via` field tells you whether the daemon or an in-process path handled it. |
| `chat_poll_inbox` | Read recent inbound (a pull). Filters: `platform`, `limit`, `since`. Merges the durable JSONL inbox with the daemon's in-memory buffer, deduped by `message_id`.                                                                 |

The inbox is plain NDJSON at `~/.opensquid/projects/<uuid>/inbox/<platform>.jsonl`, one message per line, schema `v: 1`, atomic appends. Anything allowed but unrouted lands in `~/.opensquid/inbox/orphan/<platform>.jsonl`, which is handy when a message goes missing.

### Live delivery: `chat watch`

`chat_poll_inbox` makes the agent ask. If you want it to react the moment a message arrives, `chat watch` is the push side. It tails the inbox and prints each new message to stdout, one per line, and you wrap it in your harness's stream monitor (in Claude Code, the `Monitor` tool with `persistent: true`):

```bash
opensquid chat watch          # resolves the project UUID from cwd or OPENSQUID_PROJECT_UUID
# → [tg 15] alice: ship the release when CI is green
```

```
Monitor({ command: "opensquid chat watch", persistent: true })
```

Every appended message becomes one event the moment it lands. No cron, no polling loop, and nothing burning tokens while it's idle, since the watcher just blocks on the file until the OS says it changed. Flags: `--platform` (default `telegram`), `--raw`, `--mentions-only`, `--project-uuid`.

Two things worth knowing. It only streams new messages (the cursor starts at end-of-file, so you don't get flooded with backlog; that's still there via `chat_poll_inbox`), and it handles partial lines, bad rows, and file rotation without falling over. And it's tied to one session, so it dies when the session ends and the agent should start it again next time. A CLI can't start an agent's monitor for it, so this is a convention the agent follows, not something the daemon forces. While it runs it also writes a heartbeated lease file (`live-session.lease`) so the always-on daemon below knows to stay out of the way.

### Always-on delivery: the agent-bridge daemon

`chat watch` answers inside your live session. The agent-bridge daemon (`opensquid agent-bridge start|status|stop|restart`) is for when no session is open. It's a background agent that watches each project's inbox and answers on its own, running a full agent turn per batch of messages.

It runs in one of two modes. In `subscription` mode it spawns Claude through your Claude plan, so there's no metered API cost, and that's the one to use for an always-on responder. In `api` mode it uses `ANTHROPIC_API_KEY` and bills per message.

The two delivery paths don't step on each other. Before the daemon answers, it checks the project's lease. If a `chat watch` session is live (fresh lease), the daemon stays quiet and lets your session answer. If the lease is stale or missing (no session, or one that crashed), the daemon takes over. A dead session's lease goes stale in about 90 seconds, so the daemon picks back up on its own.

It's opt-in for a reason: it replies to real people, so you start it deliberately rather than have it come up silently. One live session per project is the clean case; if you run several on the same project they'll all see the stream and may all reply.

## Reference

Look-it-up-later material.

### Memory backends

The backend is pluggable, set per project in `~/.opensquid/rag-config.json` (or `OPENSQUID_RAG_BACKEND`). The default picks itself, so you only need this to override it.

| `kind`               | Storage                                      | Use when                                                                                                          |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `loop-engine`        | Rust daemon over a Unix socket, HNSW vectors | The engine binary is available. This is the full thing: shared cross-session memory, the wedge, the lesson layer. |
| `libsql-qwen3`       | Local libsql + Qwen3-Embedding-4B (Ollama)   | No engine, but Ollama's around with `qwen3-embedding:4b`. Pure JS, still semantic.                                |
| `libsql-lexical`     | Local libsql, full-text only                 | Nothing else available. No embeddings, no Ollama; fine for keyword and proper-noun recall.                        |
| `claude-auto-memory` | Anthropic's Auto Memory                      | You're already on Claude Auto Memory and want the wedge and workflow layer on top. Read-through.                  |

It picks `loop-engine` if the binary's discoverable, otherwise `libsql-qwen3` if Ollama and the model are there, otherwise `libsql-lexical`. Nothing fails silently; `engine doctor` shows which one it landed on. Only `loop-engine` has the full lesson layer and shared vectors. The libsql backends give you `recall`/`memorize`/`forget` with a thin file-backed lesson layer. Hybrid recall with RRF fusion (`k=60`) runs in the engine, or in-process for libsql.

### The engine binary

Once it's published, `npm install opensquid` will pull the `loop-engine` binary as a per-platform optional dependency, the same way esbuild and biome do it. Until then, and for git-clone dev, it's found through a 5-step search:

1. `OPENSQUID_ENGINE_BIN`
2. the path saved in `~/.opensquid/engine-config.json`
3. a bundled npm optional dep (a no-op before publish)
4. a dev-checkout search under `~/projects/*` and `~/work/*` for `target/release/loop-engine`
5. `loop-engine` on `$PATH`

The first hit gets saved, so later launches are instant. Move the checkout and it re-finds it next time (a stale saved path is validated and cleared).

```bash
node dist/cli.js engine doctor          # resolved binary + the search chain
node dist/cli.js engine set-path <path> # pin a binary
node dist/cli.js engine forget          # clear the saved path and re-discover
node dist/cli.js engine kill            # stop the shared engine daemon
```

The engine runs as one shared daemon per machine, on a Unix socket at `~/.opensquid/loop-engine.sock`, speaking line-framed JSON-RPC. Every MCP server, hook, and CLI call on the host talks to the same one, which is why memory and lessons carry across sessions and projects.

### Other MCP hosts

Each host reads its own MCP config, so registering Claude Code doesn't touch Claude Desktop and vice versa. The wizard can do them all at once:

```bash
node dist/cli.js setup wizard mcp --hosts all   # claude-code, claude-desktop, cursor
```

Or add it to a host's config by hand, pointing at `dist/mcp/server.js`:

```json
{
  "mcpServers": {
    "opensquid": { "command": "node", "args": ["/abs/path/to/opensquid/dist/mcp/server.js"] }
  }
}
```

They all share `~/.opensquid/`, so a memory you make in Claude Code shows up in Claude Desktop next session (the engine rebuilds its vector index on each spawn).

### Pairing with Hermes Agent

[Hermes](https://github.com/NousResearch/hermes-agent) is already an MCP client, so Open Squid just sits next to whatever memory backend you're using (mem0, hindsight, openviking, whatever) and adds the gated rule layer:

```bash
hermes mcp add opensquid -- node /abs/path/to/opensquid/dist/mcp/server.js
```

Your existing setup doesn't change. You get `recall`, `memorize`, and `store_lesson`, with the same rules: only the gate promotes a lesson, user-authored content is immune, and memories cited by promoted lessons inherit that immunity.

### Coming from Claude Code auto-memory

If you've been using `~/.claude/projects/<encoded-path>/memory/*.md`:

```bash
node dist/cli.js memory import-auto --dry-run   # preview
node dist/cli.js memory import-auto             # bulk import; idempotent, all tagged authored_by:user
node dist/cli.js memory snapshot-auto           # incremental catch-up by mtime; cron, git hook, or manual
```

After the import, use `memorize` for new writes. Entries made through the MCP tool stay portable across harnesses and devices; direct auto-memory writes still work as a host-local fallback but don't sync.

### Try it

In any MCP-enabled chat:

- _"Remember I prefer pnpm over npm in this project."_ → `memorize`, project scope from the git repo.
- _"What did I tell you about my kids?"_ → `recall`, hybrid, finds the family memory on a partial query.
- _"Forget that one."_ → `forget`, immunity respected.
- _"That correction I just made, keep it."_ → `store_lesson`; the gate decides the rest.

Raw storage is under `~/.opensquid/memories/` (YAML frontmatter plus embedding sidecars). `LOOP_HOME=/some/path` relocates it, which is useful for testing.

### Why `~/.opensquid/` and not `~/.loop/`

`loop-engine` defaults to `~/.loop/` when you run it standalone. Open Squid overrides that and spawns the engine with `LOOP_HOME=~/.opensquid/` (set in `src/engine/singleton.ts`). So `~/.loop/` is the engine's data root when you run `loop-engine serve` yourself, and `~/.opensquid/` is its data root when Open Squid spawns it. They don't share state, which lets one binary serve several consumers without colliding. The practical catch: if you smoke-test the binary directly, your data goes to `~/.loop/` and Open Squid never sees it, so inspect under `~/.opensquid/` or run `LOOP_HOME=~/.opensquid loop-engine serve`.

## Status

Pre-1.0, shipping on `main` (0.5.x). Patches land often, and the agent-facing tool surface stays unfrozen until 1.0.

What works today: the loop-engine bridge over a shared per-machine daemon, hybrid recall, the eleven MCP tools, the drift-protection hooks, the three-stage `coding-flow` (SCOPE → AUTHOR → CODE) with adversarial content audits and the 7-phase workflow ledger behind the commit gate, the session-start connection manifest, the YAML pack/skill grammar with an RE2-backed `if:` language, the multi-project chat-daemon with both live `chat watch` and an always-on daemon arbitrated by a lease, multi-host MCP registration, identity that survives folder moves, and auto-memory import.

Still ahead of 1.0: npm distribution with pre-built engine binaries, a SemVer freeze on the tool surface, more automated Stage-2 promotion with a layer that learns when to ask versus proceed, and a public Claude Skill presence.

There's more in [`docs/`](./docs/) (for example [`docs/skill-grammar-guide.md`](./docs/skill-grammar-guide.md)) and the full history is in [`CHANGELOG.md`](./CHANGELOG.md).

## Design

The squid is a nod to how octopuses think. Most of their neurons are in the arms, not a central brain, so cognition is spread out around a coordinating core. Open Squid has the same shape: the wedge gate in the middle, the memory substrate running through it, and over time the arms reach out to coordinate other MCP tools across the agent's runtime.

## License

MIT. See [LICENSE](./LICENSE).

## Project family

- [`loop-engine`](https://github.com/MindcraftorAI/loop-engine) — the Rust substrate, the memory and the gate.
- Open Squid (`opensquid`) — this repo, the MCP server and the surface you interact with.
- MindCraftor — the product brand, https://mindcraftor.ai (coming).
  </content>
