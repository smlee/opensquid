# 🦑 opensquid

> **Your agent learns. You decide what gets locked in.**
> The MCP server that stops your AI agent from grading its own homework.

opensquid is the user-facing MCP layer over [`loop-engine`](https://github.com/MindcraftorAI/loop-engine) — a Rust cognitive-memory substrate with an **anti-self-grading promotion gate** at its core. Your agent proposes lessons; you decide which ones graduate.

No self-promotion. No vibes. External evidence only.

```
   [proposed]  →  [active]  →  [promoted]
         ↘              ↘
      [discarded]   [superseded]
```

---

## What it does

opensquid surfaces these tools to your AI agent via MCP.

### Memory layer

| Tool | What it does |
|------|--------------|
| **`memorize`** | Store a raw memory (observation, snippet, fact). Embedded via Qwen3-Embedding-4B for semantic recall. Auto-attaches origin metadata (host, session, model, project) and detects project scope from your git repo. |
| **`recall`** | Surface relevant lessons + memories for the current task. Runs **hybrid recall** (semantic + text + RRF fusion) so proper-noun queries like *"Gianna"* surface their memory even when cosine similarity would miss. Scope-aware by default (filters to current project + user-scope). |
| **`get_memory`** | Fetch a single memory by id with the FULL body — no truncation. Companion to `recall` when a preview hit looks load-bearing. |
| **`update_memory`** | Edit description / content / scope on an existing memory. Identity (id, citation counter, origin) always preserved. Re-embeds on content change. |
| **`forget`** | Delete a memory. User-immunity-respecting by default — memories cited by user-authored lessons are protected unless `force=true`. |

### Lesson layer (wedge-gated)

| Tool | What it does |
|------|--------------|
| **`remember`** | Capture a candidate lesson (`proposed`). Must pass the promotion gate before it graduates. |
| **`promote`** | Run the wedge gate. `active` → `promoted`, or blocked with structured reasons. Auto-publishes promoted lessons into your CLAUDE.md `<!-- opensquid-rules -->` block. |
| **`eliminate`** | Discard a lesson (terminal). User-authored lessons immune to engine-initiated elimination — explicit intent required. |
| **`pending_candidates`** | List unpromoted lesson candidates so the agent (or user) can review what's waiting at the gate. |

### Auto-observation layer (v0.4)

| Tool | What it does |
|------|--------------|
| **`classify_utterance`** | Pattern-classify a user-said line as `fact` / `preference` / `correction` / `workflow_lock`, with a suggested follow-up action (`memorize`, `remember`, `update_memory`). Lets the agent auto-capture context without explicit prompting. |

Behind those tools sits the full `loop-engine` machinery: causal-narrative generation, vector-embedded memory store with HNSW + rehydration across restarts, citation-chain-preserving compression, skill + persona + team scoping, lifecycle transitions, and the 4-layer wedge ratchet (gate → compression → skill immunity → lesson decrement).

---

## The wedge

Every promotion through opensquid runs an external-evidence check. A lesson cannot graduate to `promoted` based on the originating agent's own thumbs-up — it must carry:

- Structured causal narrative (`trigger / failure_mode / correction`)
- Confidence level (observed / inferred / speculative)
- Citations to memories the agent actually consumed (typed `EvidenceRef::Memory`)
- A pass through the time-floor + tampered-age + thumbs-down checks
- (Opt-in v0.4+) Multi-session reproducibility — `origin_diverse` signal from the engine's gate when configured

User authorship is load-bearing. If you (the human) explicitly endorse a lesson, the memories it cites become eviction-immune. If the agent self-endorses, no immunity is conferred. **The agent doesn't decide what it learned — you do, indirectly, via the gate.**

---

## Hooks (v0.4)

opensquid installs four Claude Code hooks that work even when the agent forgets to call its tools.

| Hook | What it catches |
|------|-----------------|
| **PreToolUse — drift** | Blocks known anti-patterns before they execute — `git commit --amend`, force-push to `main`, substrate-purity violations, implicit `git push`, etc. Catalogued in `src/hooks/drift-patterns.ts`. Surfaces with a 🦑 prefix. |
| **Stop — honesty ledger** | Reconciles claim-vs-action: if the agent said "running tests" but never invoked a test tool, the gap is recorded as a broken promise. Session-scoped, so end-of-turn recap text doesn't false-positive. |
| **UserPromptSubmit** | Surfaces last turn's broken promises to the user at the start of the next prompt. |
| **SessionEnd** | Clears the session-scoped ledger so disk usage stays bounded. |

Install all four:

```bash
node dist/index.js hooks install
node dist/index.js hooks uninstall   # idempotent
```

---

## Codex packs (v0.4)

opensquid speaks a YAML pack format called **codex** — portable bundles of foundation (tools/domains/methodologies), lessons, and detection rules.

- **Reads** superpowers / ECC `SKILL.md` as input — the existing skill ecosystem is accessible day-1.
- **Writes** opensquid's richer native codex format with explicit activation rules and wedge-gated lessons.
- **Exports** `.claude-plugin/plugin.json` + per-host shims so a codex runs in vanilla Claude Code with opensquid uninstalled. Your packs aren't locked to your runtime.

```bash
node dist/index.js codex list
node dist/index.js codex install <path-or-id>
node dist/index.js codex export <id>   # → .claude-plugin/plugin.json
```

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

### Idempotent CLAUDE.md installer

Configure your global CLAUDE.md so the agent reaches for `recall` / `memorize` unconsciously:

```bash
node dist/index.js install         # ~/.claude/CLAUDE.md
node dist/index.js install --project    # ./CLAUDE.md
node dist/index.js doctor          # check what's installed
node dist/index.js uninstall       # strip the block, leave the rest intact
```

Detect-don't-replace: existing CLAUDE.md content is preserved; only opensquid's sentinel-bracketed block is touched. Promoted lessons publish themselves into the `<!-- opensquid-rules -->` sub-block on every `promote` call.

### Project ID card + engine binary registry (v0.4)

opensquid writes a `.opensquid/project.json` ID card into each project so identity survives folder moves and renames. A global `~/.opensquid/config.json` records where the engine binary lives, so opensquid keeps working when you relocate the engine checkout.

```bash
node dist/index.js project doctor
node dist/index.js engine doctor
```

---

## Pairing with Hermes Agent

If you use [Hermes Agent](https://github.com/NousResearch/hermes-agent), opensquid is the rule-discipline layer Hermes is missing.

Hermes handles the agent runtime — multi-platform gateways, skill libraries, model routing. Its memory layer (mem0 / hindsight / openviking / etc.) captures observations. What Hermes does NOT have is a strict user-only promotion gate, which produces a class of bugs Hermes users have reported repeatedly:

- [#6051](https://github.com/NousResearch/hermes-agent/issues/6051) — "Skill auto-creation learns from transient failures, causing persistent tool avoidance (learned helplessness)." The agent wrote a `browser-tool-launch-issue` skill from a one-time install failure; then refused browser tools forever. *"After manually deleting the negative skill ... the agent immediately resumed normal browser tool usage."*
- [#17583](https://github.com/NousResearch/hermes-agent/issues/17583) — "Self-improvement overrides manual instructions ... there is no distinction between 'user authored this, do not touch it' and 'agent generated this, fair game to refine.'"
- [#22563](https://github.com/NousResearch/hermes-agent/issues/22563) — Memory pollution: irrelevant memories injected into the system prompt caused model misunderstanding. *"Some memories were incorrectly saved (e.g., `_priority_key()` was wrongly recorded as a 'bug' when it was actually a new feature)."*
- [Kilo aggregator review (1,300 Reddit comments)](https://kilo.ai/openclaw/vs-hermes) — *"The system that auto-generates skills also overwrites manual customizations — a dealbreaker for power users."*

opensquid sits alongside Hermes' chosen memory backend (no replacement) and adds the rule-discipline layer:

- **Only the human can promote a candidate to a rule.** Agent can propose; user endorses; engine enforces.
- **User-authored content is eviction-immune.** Background curation can never touch what you wrote.
- **Memories cited by promoted lessons inherit immunity.** The wedge gate's signal-diversity check prevents the kind of single-incident "lesson" #6051 documents.

### Install opensquid into your existing Hermes setup

Hermes is already an MCP client ([`tools/mcp_tool.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/mcp_tool.py)). One command:

```bash
hermes mcp add opensquid -- node /absolute/path/to/opensquid/dist/index.js
```

That's it. Hermes' existing memory / skill / persona surface is untouched. Now your agent has a wedge-gated `remember` / `promote` flow on top, and `recall` returns both fuzzy-recall memories (via your existing Hermes backend if you wire it) and promoted rules (only what you, the human, endorsed). The agent cannot self-promote.

---

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

---

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

**v0.4.0 — actively shipping.** Codex pack format, four-hook automation layer (drift + honesty ledger), project + engine identity, utterance classifier, auto-publishing promoted lessons.

Recent releases:

- **v0.4** (current) — codex format + local storage; project ID card (survives moves); engine binary registry; drift-detection PreToolUse hook; honesty ledger (Stop / UserPromptSubmit / SessionEnd); CLAUDE.md auto-rule publishing on `promote`; pattern-based utterance classifier + `pending_candidates` MCP tool.
- **v0.5 hybrid recall** (interim) — every memory query runs both semantic and text-match in parallel, RRF-merges, items in both lists get a score boost. Fixes the false-negative on proper-noun queries.
- **v0.4 Phase 1** — origination metadata (host/session/model/cwd attached to every memory), memory lifecycle (`update_memory` / `forget`), recall quality (`min_similarity` threshold).
- **v0.3.1** — daily-work milestone: `include_body` recall (no more truncated previews), `MemoryScope` per-project isolation, sentinel-bracketed CLAUDE.md installer.
- **v0.3.0** — opensquid pivoted to a thin RPC client over `loop-engine serve`; the Rust engine owns all wedge logic, storage, and embedding. Powered by Qwen3-Embedding-4B via Ollama by default.

Next:

- **v0.4 Phase 2** — LLM-driven Stop-hook auto-classifier (true unprompted auto-observation; the pattern classifier is the deterministic stepping stone).
- **v0.6** — telemetry on recall queries + dual-source boost in ranking + token-length config + (conditionally) FTS5 if scale demands.
- **v1.0** — npm distribution with pre-built per-platform binaries (no Rust required); SemVer freeze on the tool surface; public Claude Skill on the marketplace.

See [`ROADMAP.md`](./ROADMAP.md) for the full picture and [`docs/`](./docs/) for design notes on shipped features.

---

## Design

The squid mascot is a cephalopod-cognition reference. Roughly two-thirds of an octopus's neurons live in its arms, not its central brain — distributed cognition with a coordinating core. opensquid takes the same shape: the wedge gate sits at the center, the memory substrate flows through it, and v1.1+ extends the arms to orchestrate other MCPs as the central brain coordinating tools across an agent's runtime.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Project family

- **`loop-engine`** — Rust substrate. The cognitive memory + wedge gate. https://github.com/MindcraftorAI/loop-engine
- **`opensquid`** — this repo. MCP server, user-facing surface.
- **MindCraftor** — the product brand. https://mindcraftor.ai (coming)
