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

| Tool                | What it does                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`memorize`**      | Store a raw memory (observation, snippet, fact). Embedded via Qwen3-Embedding-4B for semantic recall. Auto-attaches origin metadata (host, session, model, project) and detects project scope from your git repo.                                                                     |
| **`recall`**        | Surface relevant lessons + memories for the current task. Runs **hybrid recall** (semantic + text + RRF fusion) so proper-noun queries like _"Gianna"_ surface their memory even when cosine similarity would miss. Scope-aware by default (filters to current project + user-scope). |
| **`get_memory`**    | Fetch a single memory by id with the FULL body — no truncation. Companion to `recall` when a preview hit looks load-bearing.                                                                                                                                                          |
| **`update_memory`** | Edit description / content / scope on an existing memory. Identity (id, citation counter, origin) always preserved. Re-embeds on content change.                                                                                                                                      |
| **`forget`**        | Delete a memory. User-immunity-respecting by default — memories cited by user-authored lessons are protected unless `force=true`.                                                                                                                                                     |

### Lesson layer (wedge-gated)

| Tool                     | What it does                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`remember`**           | Capture a candidate lesson (`proposed`). Must pass the promotion gate before it graduates.                                                                                     |
| **`promote`**            | Run the wedge gate. `active` → `promoted`, or blocked with structured reasons. Auto-publishes promoted lessons into your CLAUDE.md `<!-- opensquid-rules -->` block.           |
| **`eliminate`**          | Discard a lesson (terminal). User-authored lessons immune to engine-initiated elimination — explicit intent required.                                                          |
| **`supersede`**          | Point an old lesson at a new replacement. Old lesson moves to `superseded/`, causal chain preserved via `superseded_by`. User-authored lessons protected unless `force: true`. |
| **`capture_feedback`**   | Record thumbs_up / thumbs_down on a lesson. Feeds the wedge gate's signal-diversity input. Idempotent on `source_signal_id`. Does NOT auto-promote — records evidence only.    |
| **`list_lessons`**       | Paginated list across the four non-discarded status dirs. Deterministic sort by (status, id). Default limit 50, capped at 500. Optional `statuses` filter.                     |
| **`pending_candidates`** | Companion to `list_lessons` — shorthand for `list_lessons({statuses:["pending"]})`.                                                                                            |

### Aggregate + classification

| Tool                     | What it does                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`manifest`**           | Central RAG-style assembly: returns active lessons (deterministic-sorted, gate-annotated, applied_count bumped) + optional memory recall + assembly stats in one call. Preferred entrypoint when you want "what rules apply right now" instead of stitching `list_lessons` + `recall`. |
| **`list_memories`**      | Paginated memory enumeration. Filter-optional via `scope_filter`. Default limit 50.                                                                                                                                                                                                    |
| **`classify_utterance`** | Pattern-classify a user-said line as `fact` / `preference` / `correction` / `workflow_lock`, with a suggested follow-up action. Regex catalog — no LLM call.                                                                                                                           |

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

| Hook                      | What it catches                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PreToolUse — drift**    | Blocks known anti-patterns before they execute — `git commit --amend`, force-push to `main`, substrate-purity violations, implicit `git push`, etc. Catalogued in `src/hooks/drift-patterns.ts`. Surfaces with a 🦑 prefix. |
| **Stop — honesty ledger** | Reconciles claim-vs-action: if the agent said "running tests" but never invoked a test tool, the gap is recorded as a broken promise. Session-scoped, so end-of-turn recap text doesn't false-positive.                     |
| **UserPromptSubmit**      | Surfaces last turn's broken promises to the user at the start of the next prompt.                                                                                                                                           |
| **SessionEnd**            | Clears the session-scoped ledger so disk usage stays bounded.                                                                                                                                                               |

Install all four:

```bash
node dist/index.js hooks install
node dist/index.js hooks uninstall   # idempotent
```

---

## Engine binary distribution (v0.6c)

Once published, `npm install opensquid` will bring the `loop-engine` Rust binary along automatically via npm `optionalDependencies` — same pattern esbuild / biomejs / swc use. Six per-platform packages (`opensquid-engine-{darwin,linux,win32}-{x64,arm64}`) each ship a single native binary; npm's `os` / `cpu` fields ensure only the right one installs on a given host.

Until then (and for git-clone / monorepo dev), opensquid falls through a 5-step discovery chain that locates the engine binary at:

1. `OPENSQUID_ENGINE_BIN` env var
2. The path persisted in `~/.opensquid/config.json` `engine_bin`
3. A bundled npm optional dep (the v0.6c path, no-op pre-publish)
4. `~/projects/*/{engine,}/target/release/loop-engine` auto-search
5. `loop-engine` on `$PATH`

The first auto-discovery hit persists itself back to `config.json` so subsequent sessions start instantly. Move your loop-engine checkout and the next launch silently re-discovers.

---

## Codex packs (v0.4)

opensquid speaks a YAML pack format called **codex** — portable bundles of foundation (tools/domains/methodologies), lessons, and detection rules.

- **Reads** Anthropic / superpowers / ECC / Hermes `SKILL.md` as input — the existing skill ecosystem is accessible day-1 (v0.6d).
- **Writes** opensquid's richer native codex format with explicit activation rules and wedge-gated lessons.
- **Exports** `.claude-plugin/plugin.json` + per-host shims so a codex runs in vanilla Claude Code with opensquid uninstalled. Your packs aren't locked to your runtime.

```bash
node dist/index.js codex list
node dist/index.js codex install <path-or-id>
node dist/index.js codex export <id>   # → .claude-plugin/plugin.json
```

### Importing existing SKILL.md skills (v0.6d)

`codex install <path>` auto-detects when the source is a SKILL.md file (Anthropic skills, obra/superpowers, everything-claude-code, or Hermes Agent skills) and converts it to native codex format on the fly:

```bash
# Directory containing SKILL.md (the obra/superpowers / ECC layout):
node dist/index.js codex install ~/repos/superpowers/skills/test-driven-development

# Single SKILL.md file path also works:
node dist/index.js codex install ~/repos/superpowers/skills/test-driven-development/SKILL.md

# A directory with BOTH codex.yaml AND SKILL.md prefers codex.yaml. Force
# the SKILL.md branch with --source skill_md:
node dist/index.js codex install ~/mixed-pack --source skill_md
```

Conversion is 100% deterministic — no LLM call. Anthropic frontmatter (`name`, `description`, optional `license`, optional `allowed-tools`) maps to first-class codex fields; Hermes extensions (`version`, `author`, `platforms`, `metadata.hermes.*`), ECC `origin: ECC`, and any other non-standard keys are preserved verbatim under the codex `metadata` bucket so nothing is silently dropped. Import provenance lives at `codex.source.{kind, original_variant, original_name, original_path, imported_at}` and is surfaced by `codex list` / `codex doctor`.

---

## Portability: import / export across projects and machines

opensquid has end-to-end import/export at two granularities so the same rules / lessons / memories work across projects, machines, and team handoffs.

**Codex-level** (per skill pack — share a curated rule pack with a teammate or with another project):

```bash
node dist/index.js codex export sangmin-personal-rules --output ~/rules-bundle/
# copy ~/rules-bundle/ to another machine, then:
node dist/index.js codex install ~/rules-bundle/ --force
```

The bundle round-trips through the same install path. Engine v1.2 upsert by `(pack_id, external_id)` means re-installing the same codex updates rows in place — no duplicate engine lessons, no duplicate CLAUDE.md lines.

**System-level** (entire opensquid state — for backup or machine migration):

```bash
node dist/index.js export --output ~/opensquid-backup.tar.gz
# on a new machine:
node dist/index.js import ~/opensquid-backup.tar.gz --replace
```

Bundles every codex, every lesson in all status dirs, every memory with its `.vec` sidecar, sessions, logs, `config.json`, `projects.json`. `--replace` extracts to a tmp staging dir then atomic-renames over the destination — corrupt input never half-deletes your data. `--merge` (default) layers on top of existing data, last-write-wins per file. Format is tar.gz via system `tar` (preinstalled on macOS / Linux / Windows 10+) — zero new runtime dependency.

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

If you use [Hermes Agent](https://github.com/NousResearch/hermes-agent), opensquid is additive — it sits alongside your existing memory backend (mem0 / hindsight / openviking / etc.) and adds a wedge-gated rule layer on top.

Hermes is already an MCP client. One command:

```bash
hermes mcp add opensquid -- node /absolute/path/to/opensquid/dist/index.js
```

Your existing Hermes setup is untouched. Now your agent has `remember` / `promote` / `recall` as MCP tools, with the wedge invariants opensquid enforces:

- Only the human can promote a candidate to a rule. The agent proposes; the user endorses; the engine refuses to self-promote.
- User-authored content is eviction-immune. Background curation can't silently rewrite what you wrote.
- Memories cited by promoted lessons inherit immunity.

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

- _"Remember that I prefer pnpm over npm in this project."_ → `memorize` with project scope auto-detected from the git repo.
- _"What did I tell you about my kids?"_ → `recall` runs hybrid (semantic + text), surfaces the family memory even on partial-token queries.
- _"Show me the full text of mem-a0cdce30."_ → `get_memory` returns the full body, scope, and provenance.
- _"Update that memory — Teddy also loves being chased."_ → `update_memory` mutates content + re-embeds.
- _"Forget that one."_ → `forget`, user-immunity respected.

Storage lives at `~/.opensquid/` (lessons + memories, both with YAML frontmatter + sidecar files for embeddings). Inspect with `ls ~/.opensquid/memories/`.

Set `LOOP_HOME=/some/path` to relocate storage (handy for testing).

### Why `~/.opensquid/` not `~/.loop/` (storage root architecture)

`loop-engine` (the Rust substrate) defaults to `~/.loop/` when invoked standalone. **opensquid intentionally overrides this** by spawning the engine subprocess with `LOOP_HOME=~/.opensquid/` (see `src/engine-client.ts:84`). This is by design, not a bug:

- **`~/.loop/`** = the engine's own data root when you run `loop-engine serve` directly (testing, debugging, manual smoke tests)
- **`~/.opensquid/`** = the engine's data root when opensquid's MCP server spawns it (production agent path)

The two trees do NOT share state. Lessons / memories / phase ledger entries written under one are invisible to the other. This intentional split lets a single `loop-engine` binary serve multiple consumers (opensquid, future TS/Python launchers, manual operator) without their data colliding. Each consumer gets its own root.

**Practical implications:**

- If you smoke-test the engine binary directly (`loop-engine serve` from a shell) and write a phase entry, it goes to `~/.loop/phase_ledger/...`. opensquid's MCP layer will never see it.
- To inspect what opensquid actually wrote, always look under `~/.opensquid/`.
- To force the engine binary to use opensquid's root in manual testing: `LOOP_HOME=~/.opensquid loop-engine serve`.
- The split is enforced at spawn time, not at compile time. The engine binary itself is consumer-agnostic.

This convention was decided 2026-05-16 (per task #132) after a smoke-test surprised the maintainer who wrote phases to `~/.loop/` via direct binary RPC then expected to see them via the opensquid `chat_list_channels` MCP path. Both worked correctly — they just pointed at different roots.

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
