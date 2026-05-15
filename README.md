# 🦑 opensquid

> **Pass the gate, or get eliminated.**
> The MCP server that decides which of your agent's memories survive.

```
   ○            △            □
pending  →    active   →   promoted
   ↘             ↘
    discarded     superseded
```

OpenSquid is the user-facing MCP layer over [`loop-engine`](https://github.com/MindcraftorAI/loop-engine) — a Rust cognitive-memory substrate with an **anti-self-grading promotion gate** at its core. Your agent proposes lessons; OpenSquid decides which ones graduate.

No self-promotion. No vibes. External evidence only.

---

## What it does

OpenSquid surfaces these tools to your AI agent via MCP:

| Tool | What it does |
|------|--------------|
| **`memorize`** | Store a raw memory (observation, snippet, fact). Embedded via Qwen3-Embedding-4B for semantic recall. Auto-attaches origin metadata (host, session, model, project) and detects project scope from your git repo. |
| **`recall`** | Surface relevant lessons + memories for the current task. Runs **hybrid recall** (semantic + text + RRF fusion) so proper-noun queries like *"Gianna"* surface their memory even when cosine similarity would miss. Scope-aware by default (filters to current project + user-scope). |
| **`get_memory`** | Fetch a single memory by id with the FULL body — no truncation. Companion to `recall` when a preview hit looks load-bearing. |
| **`update_memory`** | Edit description / content / scope on an existing memory. Identity (id, citation counter, origin) always preserved. Re-embeds on content change. |
| **`forget`** | Delete a memory. User-immunity-respecting by default — memories cited by user-authored lessons are protected unless `force=true`. |
| **`remember`** | Capture a candidate lesson (`○ pending`). Pass through the promotion gate before it graduates. |
| **`promote`** | Run the wedge gate. `△ active` → `□ promoted`, or blocked with structured reasons. |
| **`eliminate`** | Discard a lesson (terminal). User-authored lessons immune to engine-initiated elimination — explicit intent required. |

Behind those tools sits the full `loop-engine` machinery: causal-narrative generation, vector-embedded memory store with HNSW + rehydration across restarts, citation-chain-preserving compression, skill + persona + team scoping, lifecycle transitions, and the 4-layer wedge ratchet (gate → compression → skill immunity → lesson decrement).

---

## The wedge

Every promotion through OpenSquid runs an external-evidence check. A lesson cannot graduate to `□ promoted` based on the originating agent's own thumbs-up — it must carry:

- Structured causal narrative (`trigger / failure_mode / correction`)
- Confidence level (observed / inferred / speculative)
- Citations to memories the agent actually consumed (typed `EvidenceRef::Memory`)
- A pass through the time-floor + tampered-age + thumbs-down checks
- (Opt-in v0.4+) Multi-session reproducibility — `origin_diverse` signal from the engine's gate when configured

User authorship is load-bearing. If you (the human) explicitly endorse a lesson, the memories it cites become eviction-immune. If the agent self-endorses, no immunity is conferred. **The agent doesn't decide what it learned — you do, indirectly, via the gate.**

---

## Quick start (Claude Code)

```bash
git clone git@github.com:smlee/opensquid.git
cd opensquid
npm install
npm run build
```

Register with Claude Code (user scope = available across all sessions):

```bash
claude mcp add --scope user opensquid -- node /absolute/path/to/opensquid/dist/index.js
```

Restart Claude Code. The tools appear under the `opensquid` server in `/mcp`.

### Optional: idempotent CLAUDE.md installer

Have opensquid configure your global CLAUDE.md so the agent reaches for `recall` / `memorize` unconsciously:

```bash
node dist/index.js install        # ~/.claude/CLAUDE.md
node dist/index.js install --project   # ./CLAUDE.md
node dist/index.js doctor         # check what's installed
node dist/index.js uninstall      # strip the block, leave the rest intact
```

Detect-don't-replace: existing CLAUDE.md content is preserved; only opensquid's sentinel-bracketed block is touched. Same-version re-install is a no-op.

## Quick start (Claude Desktop / Cursor / any MCP host)

Add to your host's MCP config:

```json
{
  "mcpServers": {
    "opensquid": {
      "command": "node",
      "args": ["/absolute/path/to/opensquid/dist/index.js"]
    }
  }
}
```

All MCP hosts on the same machine share `~/.opensquid/` — a memory created in Claude Code is available in Claude Desktop on the next session (engine rehydrates the vector index on every spawn).

## Try it

In any MCP-enabled chat, ask the model to:

- *"Remember that I prefer pnpm over npm in this project."* → `memorize` with project scope auto-detected from the git repo.
- *"What did I tell you about my kids?"* → `recall` runs hybrid (semantic + text), surfaces the family memory even on partial-token queries.
- *"Show me the full text of mem-a0cdce30."* → `get_memory` returns the full body, scope, and provenance.
- *"Update that memory — Teddy also loves being chased."* → `update_memory` mutates content + re-embeds.
- *"Forget that one."* → `forget`, user-immunity respected.

Storage lives at `~/.opensquid/` (lessons + memories, both with YAML frontmatter + sidecar files for embeddings). Inspect with `ls ~/.opensquid/memories/`.

Set `LOOP_HOME=/some/path` to relocate storage (handy for testing).

---

## Status & roadmap

**v0.3.1+ — actively shipping.** Engine integration complete, full MCP tool surface, scope-aware recall, hybrid (semantic + text + RRF) memory search, origin-metadata provenance, user-immunity invariant enforced across all eviction paths.

Recent releases:

- **v0.5** — hybrid recall: every memory query runs both semantic and text-match in parallel, RRF-merges, items in both lists get a score boost. Fixed the v0.4 false-negative on proper-noun queries.
- **v0.4** — origination metadata (host/session/model/cwd attached to every memory), memory lifecycle (`update_memory` / `forget`), recall quality (similarity threshold + RRF merge).
- **v0.3.1** — daily-work milestone: `include_body` recall (no more truncated previews), `MemoryScope` per-project isolation, sentinel-bracketed CLAUDE.md installer.
- **v0.3.0** — opensquid pivoted to a thin RPC client over `loop-engine serve`; the Rust engine owns all wedge logic, storage, and embedding. Powered by Qwen3-Embedding-4B via Ollama by default.

Next:

- **v0.4 Phase 2** — Claude Skill packaging + `UserPromptSubmit` / `Stop` hooks so `recall` fires unconsciously on every prompt and `memorize` is offered after every turn (opt-in via env vars).
- **v0.6** — telemetry on recall queries + dual-source boost in ranking + token-length config + (conditionally) FTS5 if scale demands.
- **v1.0** — npm distribution with pre-built per-platform binaries (no Rust required); SemVer freeze on the tool surface; public Claude Skill on the marketplace.

See [`ROADMAP.md`](./ROADMAP.md) for the full picture and [`docs/`](./docs/) for design notes on shipped features.

---

## Design

The visual identity nods to Korean cultural exports of the 2020s — geometric mask symbols ○ △ □, the hidden-judgment / front-man metaphor for the wedge gate, hot pink + teal accent palette. The squid mascot does triple duty: Squid Game (the gate-or-eliminated framing), cephalopod cognition (distributed nervous system → memory as substrate), and the brain-with-arms metaphor for opensquid orchestrating other MCPs (v1.1+).

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Project family

- **`loop-engine`** — Rust substrate. The cognitive memory + wedge gate. https://github.com/MindcraftorAI/loop-engine
- **`opensquid`** — this repo. MCP server, user-facing surface.
- **MindCraftor** — the product brand. https://mindcraftor.ai (coming)
