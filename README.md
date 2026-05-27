# 🦑 Open Squid

> **Your agent learns. You decide what gets locked in.**
> The MCP server that stops your AI agent from grading its own homework.

Open Squid is the user-facing MCP layer over [`loop-engine`](https://github.com/MindcraftorAI/loop-engine) — a Rust cognitive-memory substrate with an **anti-self-grading promotion gate** at its core. Your agent proposes lessons; you decide which ones graduate.

> **Naming note:** "Open Squid" is the display brand. `opensquid` (one word, lowercase) is the technical artifact — the npm package, the CLI binary, the MCP server name, the config directory `~/.opensquid/`. When you read prose, you'll see "Open Squid"; when you read code, file paths, or commands, you'll see `opensquid`.

No self-promotion. No vibes. External evidence only.

```
   [proposed]  →  [active]  →  [promoted]
         ↘              ↘
      [discarded]   [superseded]
```

> **Status:** pre-1.0, actively developed (currently 0.5.x). The tool surface is not yet frozen — see [Status & roadmap](#status--roadmap). The MCP server reports its real version at runtime from `package.json`, so `claude mcp list` always shows the truth.

---

## 5-minute setup

```bash
# 1. Clone + build
git clone git@github.com:smlee/opensquid.git && cd opensquid
npm install && npm run build

# 2. Register the MCP servers with Claude Code (user scope — available everywhere)
node dist/cli.js setup wizard mcp
#   …or do it manually, pointing at the MCP server entrypoint (NOT dist/index.js):
#   claude mcp add --scope user opensquid -- node "$(pwd)/dist/mcp/server.js"

# 3. (Optional) Install drift-protection hooks
node dist/cli.js setup wizard hooks

# 4. Restart Claude Code, then verify
claude mcp list                 # opensquid should appear
node dist/cli.js doctor hooks   # green = hooks wired correctly
```

Storage lives at `~/.opensquid/`. The agent now has `recall` / `memorize` / `store_lesson` / `log_phase` etc. as MCP tools, and (if you installed hooks) drift protection on common `git` mishaps.

> **Entrypoints, for reference** (from `package.json` `bin`): the CLI is `dist/cli.js` (`opensquid`), the MCP server is `dist/mcp/server.js` (`opensquid-mcp`), the chat bridge is `dist/mcp/chat-bridge-server.js` (`opensquid-chat-bridge-mcp`). `dist/index.js` is a library re-export barrel — it has no CLI and no server; do **not** point a host at it.

If you install the package globally (so the `opensquid` bin is on `$PATH`), drop the `node dist/cli.js` prefix and just run `opensquid setup wizard mcp`, `opensquid doctor hooks`, etc. Other MCP hosts (Claude Desktop, Cursor, Windsurf) use [the JSON config form](#quick-start-claude-desktop--cursor--any-mcp-host).

See **[Drift protection (optional)](#drift-protection-optional)** below for what each hook does and how to skip a single gate.

---

## What the agent can call (MCP tools)

These are the tools the `opensquid` MCP server actually surfaces to your agent. There are eleven, grouped by job:

### Memory

| Tool           | What it does                                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`recall`**   | Find memories relevant to a query; returns up to `k` ranked hits. Runs **hybrid recall** (semantic + text + RRF fusion) so proper-noun queries like _"Gianna"_ surface even when cosine similarity would miss. Scope-aware by default. |
| **`memorize`** | Persist a memory. `authored_by="user"` (the default) makes it eviction-immune. Scope defaults to user; project scope is auto-detected from your git repo. Embedded for semantic recall.                                                |
| **`forget`**   | Delete a memory by id. User-authored memories require `force: true` (eviction immunity).                                                                                                                                               |

### Lessons (the agent can only propose)

| Tool               | What it does                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`store_lesson`** | Capture a candidate lesson for Stage 1 (you validate the classification). Use this for in-session corrections. There is **no `promote` tool** — the agent cannot graduate its own lesson; automation runs Stage 2 against the wedge gate. |

### Workflow

| Tool            | What it does                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`log_phase`** | Log a completed workflow phase (`pre_research` \| `learn` \| `code` \| `test` \| `audit` \| `post_research` \| `fix`) for the active task. Writes both the engine ledger and the gate state; the commit gate unblocks once all seven are logged. |

### Inspection (read-only)

| Tool                    | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| **`list_packs`**        | List the currently loaded packs.                                |
| **`list_skills`**       | List skills, optionally scoped to a pack.                       |
| **`inspect_skill`**     | Show a skill's rules, load conditions, and drift policy.        |
| **`read_state`**        | Read a session-state key.                                       |
| **`read_violations`**   | Return the session's `violations.jsonl`.                        |
| **`list_drift_events`** | Aggregate the drift catalog across packs + the current session. |

### Why `promote` isn't here

The lesson lifecycle — `promote`, `eliminate`, `supersede`, `capture_feedback`, plus aggregate calls like `manifest`, `list_lessons`, and `classify_utterance` — runs as **runtime / automation functions and engine RPCs, not agent-callable MCP tools.** `promote` in particular is deliberately withheld from the MCP surface so the wedge-gate outcome check cannot be bypassed by any MCP client. The agent proposes via `store_lesson`; Stage 2 promotion is run by automation against the engine gate, where the agent's own thumbs-up carries no weight.

#### `promote_lesson` (runtime function) returns two `status` cases

For skills calling the `promote_lesson` runtime function (e.g. from a YAML `process:` step), the success result has **two** `status` shapes:

- `{status: 'promoted', detail: ...}` — engine accepted the promotion; the wedge gate ran and passed.
- `{status: 'blocked', reasons: [...]}` — engine ran the gate and refused. `reasons` is an array of kebab-case `BlockReason::Display` strings (e.g. `missing-external-signal-sources`, `missing-causal-narrative`, `insufficient-applied-count`, `time-floor`). **This is the moat firing — NOT an error.**

Skills branch on `result.status` to decide whether to surface the block or capture more evidence and retry:

```yaml
process:
  - function: promote_lesson
    args: { id: '{lesson_id}' }
    bind: result
verdict: |
  if (result.status === 'blocked') return { kind: 'block', reasons: result.reasons };
  return { kind: 'promote' };
```

A genuine runtime/infra failure (engine unreachable, malformed args, etc.) still surfaces as `kind: 'runtime'` on the `Result` envelope — distinct from the gate firing.

Behind these tools sits the full `loop-engine` machinery: causal-narrative generation, vector-embedded memory store with HNSW + rehydration across restarts, citation-chain-preserving compression, skill + persona + team scoping, lifecycle transitions, and the 4-layer wedge ratchet (gate → compression → skill immunity → lesson decrement).

---

## The wedge

Every promotion runs an external-evidence check. A lesson cannot graduate to `promoted` based on the originating agent's own thumbs-up — it must carry:

- Structured causal narrative (`trigger / failure_mode / correction`)
- Confidence level (observed / inferred / speculative)
- Citations to memories the agent actually consumed (typed `EvidenceRef::Memory`)
- A pass through the time-floor + tampered-age + thumbs-down checks
- (Opt-in) Multi-session reproducibility — `origin_diverse` signal from the engine's gate when configured

User authorship is load-bearing. If you (the human) explicitly endorse a lesson, the memories it cites become eviction-immune. If the agent self-endorses, no immunity is conferred. **The agent doesn't decide what it learned — you do, indirectly, via the gate.**

---

## Drift protection (optional)

Open Squid ships a set of Claude Code hooks that catch common agent-drift patterns even when the agent forgets to call its tools. All hooks are **opt-in** via the setup wizard, and every blocking gate fails open on opensquid's own internal errors — they never break real work because of an opensquid bug.

| Hook                             | What it catches                                                                                                                                                                                            | Skip env var                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **PreToolUse — drift patterns**  | Blocks known anti-patterns before they execute: `git commit --amend`, force-push to `main`, substrate-purity violations, implicit `git push`, etc. Catalogued in `src/hooks/drift-patterns.ts`. 🦑 prefix. | `OPENSQUID_SKIP_DRIFT=1`                                   |
| **PreToolUse — workflow gate**   | Blocks `git commit` when the active task's phase ledger is missing required phases (`pre_research`, `learn`, `code`, `test`, `audit`, `post_research`, `fix`). Per-task scoping; survives `/resume`.       | `OPENSQUID_SKIP_WORKFLOW_GATE=1`                           |
| **PreToolUse — versioning gate** | Blocks `git commit` when staged code touches `src/` without a matching `package.json` / `Cargo.toml` version bump. PATCH-only by default.                                                                  | `OPENSQUID_SKIP_VERSION_GATE=1`                            |
| **Stop — honesty ledger**        | Reconciles claim-vs-action across a session: if the agent said "running tests" but never invoked a test tool, the gap is recorded as a broken promise. End-of-turn recap text doesn't false-positive.      | (passive recording — no skip)                              |
| **UserPromptSubmit**             | Surfaces last turn's broken promises + heartbeat re-anchor + resume-detection (>5 min gap) at the start of the next prompt.                                                                                | `OPENSQUID_HEARTBEAT_TOKENS=999999999` mutes the heartbeat |
| **SessionEnd**                   | Clears the session-scoped ledger so disk usage stays bounded.                                                                                                                                              | (cleanup only — no skip)                                   |

### Install / verify

```bash
node dist/cli.js setup wizard hooks   # writes opensquid's 4 hook entries into ~/.claude/settings.json
node dist/cli.js doctor hooks         # health-check the wiring (exit 0 = all green)
```

The installer is marker-bracketed (`@opensquid: true`): re-installing the same version is a no-op, upgrading rewrites only the opensquid block, and third-party hooks are preserved untouched. By default it also writes a project-scope `settings.json` when an `.opensquid/` ancestor is found; pass `--user-only` to skip that.

### Skipping a single gate

Inline command prefix is the standard pattern — flips off the gate for ONE command, no global state to forget:

```bash
OPENSQUID_SKIP_WORKFLOW_GATE=1 git commit -m "wip"        # commit without phase-ledger coverage
OPENSQUID_SKIP_DRIFT=1 git push origin main               # bypass the no-implicit-push drift
OPENSQUID_SKIP_VERSION_GATE=1 git commit -m "docs only"   # commit without a version bump
```

Each bypass logs a loud `🦑 [opensquid <gate>] BYPASSED via …=1` line to stderr so the override stays visible in scrollback / CI logs. Genuinely-emergency only — the gates exist because skipping them tends to land you in the broken state they're guarding against.

### What's NOT a hook

`opensquid` is primarily an MCP server. The MCP tools (`recall`, `memorize`, `store_lesson`, `log_phase`, etc.) work without any hooks installed. Drift protection is the bolt-on safety net for `git`-driven workflows; if you're using opensquid purely for memory + lessons, you can skip the hooks entirely.

---

## Chat-daemon — multi-project Telegram / Discord / Slack

Open Squid runs a single per-machine background process (the **chat-daemon**) that owns each chat platform's connection. Why: Telegram (and any long-poll bot API) only allows one consumer per bot token at a time — without the daemon, the "last-connected" Claude Code project would steal the bot from every other project. The daemon fixes this by holding the only long-poll and multiplexing outbound `chat_send` calls + per-project inbound routing.

**Architecture:**

```
┌─────────────────────────────────────────────────────┐
│ opensquid chat-daemon (per-machine, auto-spawned)   │
│                                                       │
│ - Owns single long-poll per platform                 │
│ - Reads ~/.opensquid/projects/<uuid>/chat-routing.json │
│ - Inbound: routes by chat_id → per-project inbox     │
│ - Outbound: receives via Unix socket / named pipe    │
└──────────────────────────────────────────────────────┘
        ▲                          ▲
        │ outbound                 │ outbound
┌────────────────────┐   ┌────────────────────┐
│ MCP server (proj A)│   │ MCP server (proj B)│
│ chat_send → daemon │   │ chat_send → daemon │
│ chat_poll_inbox    │   │ chat_poll_inbox    │
└────────────────────┘   └────────────────────┘
```

**Lifecycle:**

- Auto-spawned on MCP server boot when any `chat_connections` block is configured (no-op when nothing is configured)
- Atomic spawn via `~/.opensquid/chat-daemon.spawn.lock` so racing project starts don't double-launch
- Pidfile at `~/.opensquid/chat-daemon.pid`, log at `~/.opensquid/chat-daemon.log`
- Survives MCP server restarts
- Cross-platform: Unix sockets on macOS/Linux, named pipes (`\\.\pipe\opensquid-chat-daemon-...`) on Windows

**Per-project routing:** each project declares its outbound channel + inbound chat allowlist in `~/.opensquid/projects/<uuid>/chat-routing.json`. The daemon picks up changes within ~30s via polling — no restart required for routine edits.

**Chat-bridge MCP tools:** the `opensquid-chat-bridge` server exposes exactly two tools to the agent:

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`chat_send`**       | Send a text message. `channel: "project:<platform>"` auto-resolves to the active project's `report_channel`; explicit `<platform>:<native_id>` still works. Response includes `via: "daemon" \| "in_process"` so you can see which path served it. When `channel` is omitted it builds a `project:<platform>` shorthand from the session. |
| **`chat_poll_inbox`** | Read recent inbound messages from the active project's inbox. Supports `platform`, `limit`, and `since` (ISO timestamp) filters. Merges the durable per-project JSONL with the in-memory daemon-pushed buffer (dedup by `message_id`).                                                                                                    |

**Inbox format** (`~/.opensquid/projects/<uuid>/inbox/<platform>.jsonl`): one JSON message per line (NDJSON), stable schema `v: 1`, atomic POSIX appends — consumers split on `\n` safely. Allowed-but-unrouted messages land in a catch-all orphan inbox at `~/.opensquid/inbox/orphan/<platform>.jsonl` — useful for diagnosing "where did my message go?"

### Live inbound delivery (no cron)

`chat_poll_inbox` is a **pull** — the agent reads the backlog on demand. For a live session that should react the _instant_ a message lands, `opensquid chat watch` is the **push** path: it tails the active project's inbox JSONL and streams each new message to stdout, one line per message. The agent wraps it in its harness's stream monitor (in Claude Code, the `Monitor` tool with `persistent: true`):

```bash
opensquid chat watch          # resolves the project UUID from cwd / OPENSQUID_PROJECT_UUID
# → [tg 15] alice: ship the release when CI is green
```

```
Monitor({ command: "opensquid chat watch", persistent: true })
```

Each appended message becomes one in-chat event the moment it arrives — **event-driven, no cron, no polling loop, zero idle cost** (the watcher blocks on the file until the OS signals a write; it never wakes up to poll). Flags: `--platform <name>` (default `telegram`), `--raw` (emit the JSON rows verbatim), `--mentions-only`, `--project-uuid <uuid>`.

Two deliberate properties:

- **New messages only.** The cursor starts at end-of-file, so the backlog isn't replayed into the session on start; it stays reachable via `chat_poll_inbox`. Partial-line, malformed-row, and file-rotation cases are all handled — a bad line is skipped, never tears the watcher down.
- **Session-scoped.** The watcher lives for the agent session and is re-started at the next session start. A CLI process can't start an agent-side monitor on the agent's behalf, so "auto-start" is an agent convention (e.g. on session start or when automation arms), not a daemon side-effect.

**Per-session auto-start (the convention).** Because the watcher is session-scoped, the agent should start it once per session — at session start, or when automation arms. There is no `SessionStart` enforcement hook; this is a documented agent behavior, kept deliberately simple. While `chat watch` runs it also writes a **live-session lease** (`~/.opensquid/projects/<uuid>/live-session.lease`), heartbeated every 30s, so the always-on daemon (below) knows a live session is handling the project.

### Always-on autonomous delivery (agent-bridge daemon)

`chat watch` answers in _your live session_. The **agent-bridge daemon** (`opensquid agent-bridge {start|status|stop|restart}`) is the complement: a persistent background agent that watches each project's inbox and answers inbound **autonomously, even when no interactive session is open**. It runs a full agent turn (tool-use included) per coalesced batch.

**Two modes** — pick via the project's pack binding:

- **`subscription`** — spawns Claude with a materialized MCP config; auth flows through your Claude plan. **No metered API cost.** Recommended for an always-on responder.
- **`api`** — uses `ANTHROPIC_API_KEY` and bills per message. Only if you want metered API usage.

**Arbitration (no double-replies).** Before the daemon answers a project's message, it checks that project's live-session lease: if a **fresh** lease exists (a `chat watch` session is actively handling the project), the daemon **stays silent** — your live session answers. If the lease is stale or absent (no session open, or a crashed one), the daemon takes over. Crash-safe: a dead session's lease goes stale within ~90s and the daemon resumes automatically.

> The daemon is **opt-in** — it autonomously replies to real people, so you start it deliberately (`opensquid agent-bridge start`), not as a silent side-effect. Multiple live sessions on the _same_ project all receive the stream and may both reply; one session per project is the clean case.

---

## Engine binary distribution

Once published, `npm install opensquid` will bring the `loop-engine` Rust binary along automatically via npm `optionalDependencies` — same pattern esbuild / biomejs / swc use. Six per-platform packages (`opensquid-engine-{darwin,linux,win32}-{x64,arm64}`) each ship a single native binary; npm's `os` / `cpu` fields ensure only the right one installs on a given host.

Until then (and for git-clone / monorepo dev), Open Squid falls through a 5-step discovery chain that locates the engine binary at:

1. `OPENSQUID_ENGINE_BIN` env var
2. The path persisted in `~/.opensquid/engine-config.json` `engine_bin`
3. A bundled npm optional dep (no-op pre-publish)
4. `~/projects/*` & `~/work/*` dev-checkout auto-search for `target/release/loop-engine`
5. `loop-engine` on `$PATH`

The first auto-discovery hit persists itself back to `engine-config.json` so subsequent sessions start instantly. Move your loop-engine checkout and the next launch silently re-discovers — a stale persisted path is stat-validated on the next start and cleared so re-discovery picks up the new location.

### Engine CLI

```bash
node dist/cli.js engine doctor          # show resolved binary + discovery chain
node dist/cli.js engine set-path <path> # pin an explicit binary path
node dist/cli.js engine forget          # clear the persisted path; force re-discovery
node dist/cli.js engine kill            # stop the shared engine daemon (SIGTERM + cleanup)
```

`engine kill` reads `~/.opensquid/loop-engine.pid` (written by the daemon-spawn singleton), sends `SIGTERM`, waits 2s for graceful shutdown, then best-effort unlinks the socket + pidfile. Idempotent — running it with nothing started prints `no engine daemon running.` and exits 0.

> The engine runs as **one shared daemon per machine**, reachable over a Unix domain socket at `~/.opensquid/loop-engine.sock`, speaking line-framed JSON-RPC 2.0. Every MCP server, hook, and CLI invocation on the host shares that single daemon — which is exactly why memory and lessons persist across sessions and projects.

---

## Memory backends

Open Squid talks to a pluggable backend for memory storage + recall. The backend kind is configured per-project via `~/.opensquid/rag-config.json` (or the `OPENSQUID_RAG_BACKEND` env var). The defaults pick the right one automatically — you only need this section if you want to override.

| Backend `kind`           | Storage                                                  | Best for                                                                                                                                            |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`loop-engine`**        | Rust daemon over UDS, vectors via HNSW                   | Default when the engine binary is discoverable. Cross-session shared memory, fastest recall, exposes the full wedge gate + lesson layer.            |
| **`libsql-qwen3`**       | Local libsql (sqlite fork) + Qwen3-Embedding-4B (Ollama) | Default when no engine is present. Pure-JS fallback that still does semantic recall; needs Ollama running locally with `qwen3-embedding:4b` pulled. |
| **`libsql-lexical`**     | Local libsql, full-text search only                      | Zero-dependency fallback. No embeddings, no Ollama. Good enough for proper-noun + keyword recall when semantic isn't available.                     |
| **`claude-auto-memory`** | Anthropic's Auto Memory (host-managed)                   | Adapter for users already on Claude Auto Memory who want the opensquid wedge gate + workflow layer over their existing store. Read-through.         |

**Default selection** — if the `loop-engine` binary is discoverable via the chain above, `loop-engine` is the default. Otherwise the resolver falls back to `libsql-qwen3` when Ollama + the embedding model are reachable, else `libsql-lexical`. No silent failure — `engine doctor` shows which path applied.

Only the `loop-engine` backend carries the central RAG-style `manifest` assembly (active lessons + recall + wedge-gate stats in one engine RPC), shared cross-session vector memory, and the four-layer wedge ratchet. The libsql backends ship the memory tools (`recall` / `memorize` / `forget`) but the lesson + wedge layer reduces to a thin file-backed equivalent. Hybrid recall + RRF fusion (Reciprocal Rank Fusion, `k=60`) runs server-side in the engine; for the libsql backends the equivalent fusion runs in-process.

---

## Migration from Claude Code auto-memory

For users coming from Claude Code's host-local auto-memory (`~/.claude/projects/<encoded-path>/memory/*.md`):

1. **Bulk import** — `opensquid memory import-auto` walks the auto-memory directory, parses each `*.md` (skipping `MEMORY.md`, the index), and writes every entry into the configured backend via direct `engine.memoryCreate`. Dedup is by the auto-memory `name` frontmatter slug round-tripped through `origin.host` — re-runs are idempotent. All imports are tagged `authored_by: 'user'` (eviction-immune).

   ```bash
   node dist/cli.js memory import-auto --dry-run   # preview without writing
   node dist/cli.js memory import-auto             # full import (default: cwd's auto-memory dir)
   ```

2. **Periodic catch-up** — `opensquid memory snapshot-auto` re-imports any auto-memory files modified since the last snapshot (timestamp at `~/.opensquid/.last-auto-memory-snapshot`). First run imports everything; subsequent runs are an mtime delta. Run it on a cron, a git hook, or manually.

   ```bash
   node dist/cli.js memory snapshot-auto
   ```

After the initial import, **prefer `memorize`** for new writes — entries created through the MCP tool stay portable across harnesses (Claude Code, Cursor, ChatGPT desktop, Gemini CLI) and across devices. Direct auto-memory writes still work as a host-local fallback, but they don't sync.

---

## Quick start (Claude Desktop / Cursor / any MCP host)

Add to your host's MCP config, pointing at the **MCP server entrypoint** (`dist/mcp/server.js`):

```json
{
  "mcpServers": {
    "opensquid": {
      "command": "node",
      "args": ["/absolute/path/to/opensquid/dist/mcp/server.js"]
    }
  }
}
```

All MCP hosts on the same machine share `~/.opensquid/` — a memory created in Claude Code is available in Claude Desktop on the next session (the engine rehydrates the vector index on every spawn).

---

## Pairing with Hermes Agent

If you use [Hermes Agent](https://github.com/NousResearch/hermes-agent), Open Squid is additive — it sits alongside your existing memory backend (mem0 / hindsight / openviking / etc.) and adds a wedge-gated rule layer on top. Hermes is already an MCP client:

```bash
hermes mcp add opensquid -- node /absolute/path/to/opensquid/dist/mcp/server.js
```

Your existing Hermes setup is untouched. Now your agent has `recall` / `memorize` / `store_lesson` as MCP tools, with the wedge invariants Open Squid enforces:

- Only promotion through the gate (run by automation, never the agent) turns a candidate into a rule. The agent proposes; the engine refuses to self-promote.
- User-authored content is eviction-immune. Background curation can't silently rewrite what you wrote.
- Memories cited by promoted lessons inherit immunity.

---

## Try it

In any MCP-enabled chat, ask the model to:

- _"Remember that I prefer pnpm over npm in this project."_ → `memorize` with project scope auto-detected from the git repo.
- _"What did I tell you about my kids?"_ → `recall` runs hybrid (semantic + text), surfacing the family memory even on partial-token queries.
- _"Forget that one."_ → `forget`, user-immunity respected.
- _"That correction I just made — keep it."_ → `store_lesson` captures a Stage-1 candidate; promotion is left to the gate.

Storage lives at `~/.opensquid/` (lessons + memories, both with YAML frontmatter + sidecar files for embeddings). Inspect with `ls ~/.opensquid/memories/`. Set `LOOP_HOME=/some/path` to relocate storage (handy for testing).

### Why `~/.opensquid/` not `~/.loop/` (storage root architecture)

`loop-engine` (the Rust substrate) defaults to `~/.loop/` when invoked standalone. **Open Squid intentionally overrides this** by spawning the engine subprocess with `LOOP_HOME=~/.opensquid/` (the daemon-spawn singleton in `src/engine/singleton.ts` sets it). This is by design, not a bug:

- **`~/.loop/`** = the engine's own data root when you run `loop-engine serve` directly (testing, debugging, manual smoke tests)
- **`~/.opensquid/`** = the engine's data root when Open Squid's MCP server spawns it (production agent path)

The two trees do NOT share state. Lessons / memories / phase-ledger entries written under one are invisible to the other. This split lets a single `loop-engine` binary serve multiple consumers (Open Squid, future TS/Python launchers, manual operator) without their data colliding.

**Practical implications:**

- If you smoke-test the binary directly (`loop-engine serve` from a shell) and write a phase entry, it goes to `~/.loop/...`. Open Squid's MCP layer will never see it.
- To inspect what Open Squid actually wrote, always look under `~/.opensquid/`.
- To force the binary to use Open Squid's root in manual testing: `LOOP_HOME=~/.opensquid loop-engine serve`.
- The split is enforced at spawn time, not compile time. The binary itself is consumer-agnostic.

---

## Status & roadmap

**Pre-1.0, actively shipping on `main`** (0.5.x). Patch cadence is high; the agent-facing tool surface is intentionally not frozen until 1.0.

What's shipped today: the loop-engine RPC bridge over a shared per-machine UDS daemon; hybrid recall (semantic + text + RRF fusion); the eleven-tool MCP surface above; the four-hook drift-protection layer (drift patterns + workflow gate + versioning gate + honesty ledger); the 7-phase workflow ledger and commit gate; the YAML pack/skill grammar with an RE2-backed (ReDoS-immune) `if:` expression language; the multi-project chat-daemon for Telegram / Discord / Slack; project + engine identity that survives folder moves; auto-memory bulk import + incremental catch-up.

On the way to 1.0:

- npm distribution with pre-built per-platform engine binaries (no Rust toolchain required)
- SemVer freeze on the agent-facing tool surface
- Deeper automation of Stage-2 promotion (unprompted, evidence-driven) and the calibration layer that learns _when_ to ask the human vs. proceed
- A public Claude Skill / marketplace presence

See [`docs/`](./docs/) for design notes on shipped features (including [`docs/skill-grammar-guide.md`](./docs/skill-grammar-guide.md) for the `if:` grammar) and [`CHANGELOG.md`](./CHANGELOG.md) for the full release history.

---

## Design

The squid mascot is a cephalopod-cognition reference. Roughly two-thirds of an octopus's neurons live in its arms, not its central brain — distributed cognition with a coordinating core. Open Squid takes the same shape: the wedge gate sits at the center, the memory substrate flows through it, and later versions extend the arms to orchestrate other MCPs as the central brain coordinating tools across an agent's runtime.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Project family

- **`loop-engine`** — Rust substrate. The cognitive memory + wedge gate. https://github.com/MindcraftorAI/loop-engine
- **Open Squid** (`opensquid` package) — this repo. MCP server, user-facing surface.
- **MindCraftor** — the product brand. https://mindcraftor.ai (coming)
