# Changelog

All notable changes to `opensquid` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [SemVer 2.0.0](https://semver.org/) starting at 1.0.

---

## [Unreleased]

### Added — 2026-05-16 (v0.7 complete — v0.7b + v0.7c)

**Discord + Slack adapters land — v0.7 chat connections feature-complete (#121)**

Building on v0.7a's gateway + Telegram. Both new adapters follow the same shape — dynamic-import the SDK, validate identity/token in one round-trip, attach a message handler, normalize to the shared `ChatMessage` shape, enforce allowlists at the adapter boundary.

**v0.7b — Discord adapter (`src/chat/adapters/discord.ts`)**
- SDK: `discord.js` v14 (new optional dep). Heavyweight but standard — rolling our own Gateway WebSocket client would be ~500 LOC of fragile protocol code (heartbeats, resume tokens, sharding, identify backoff, zlib decompression).
- Intents declared: `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages` — forgetting `DirectMessages` silently drops DM events (a known newcomer gotcha).
- Outbound: `channel.send()` for channel messages, threaded replies via `reply: { messageReference }`.
- Identity captured on `ready` event; bot's own messages filtered via `author.bot`.

**v0.7c — Slack adapter (`src/chat/adapters/slack.ts`)**
- SDK: `@slack/web-api` + `@slack/socket-mode` (new optional deps). Intentionally skips `@slack/bolt` to avoid the Express runtime drag — Bolt v4 pulls in `express@5` even when only using Socket Mode.
- Two tokens: `bot_token` (xoxb-...) for Web API, `app_token` (xapp-...) for the Socket Mode WebSocket. Validator catches prefix swaps before connection.
- Ack-first message handling — Slack's 3-second retry clock is unforgiving even in Socket Mode. We `await ack()` before dispatching to handlers.
- Filters out subtypes (channel_join, bot_message, message_changed) and bot-authored messages.
- `<@bot_id>` mention detection.

**Factory wiring** — `src/chat/factory.ts` now activates all three platforms when their config blocks are valid. Validation issues against any configured platform are blocking — no more "silent skip" for unimplemented platforms because everything's implemented.

**Tests** — 5 new Discord adapter tests + 6 new Slack adapter tests + 2 updated factory tests (3-platform activation + discord-only + slack-only paths). Full suite: 347/347 passing.

**v0.7 closeout** — the chat-connections feature is feature-complete per the user's "telegram, discord, slack should be 0.7 together" direction. Three platforms, three adapters, one gateway, two MCP tools. Bot tokens slot into `~/.opensquid/config.json` `chat_connections.<platform>` when the user is ready (per the user direction "you can get to bot token later").

### Added — 2026-05-16 (v0.7a)

**Chat connections — gateway abstraction + Telegram adapter (#121)**

First slice of v0.7 chat connections. Three-platform plan (Telegram + Discord + Slack ship together as v0.7); this drop lands the foundation + the first adapter. Discord and Slack are stubbed in the factory and warn at startup until v0.7b / v0.7c add their adapters.

- `src/chat/gateway.ts` — `ChatGateway` orchestrator + adapter contract. Normalizes every inbound message to a single `ChatMessage` shape (`{platform, channel, sender, text, mentionsBot, ...}`). Routes outbound by `<platform>:<native_id>` channel id prefix. One handler stack across all platforms.
- `src/chat/config.ts` — per-platform config blocks stored under `chat_connections.{telegram,discord,slack}` in `~/.opensquid/config.json`. Each block has its own `bot_token` (Slack also needs `app_token` for Socket Mode) + optional `allowlist_*_ids` for sender whitelisting. Validation surfaces shape errors before opening a connection.
- `src/chat/adapters/telegram.ts` — long-polling adapter via `grammy` (new optional dep). Dynamically imported only when the telegram block is configured, so non-telegram installs don't pay the cost. Allowlist enforcement at adapter boundary — silent drop, no bot echo of policy decisions. `@-mention` + `/cmd@bot` detection rolled in.
- `src/chat/factory.ts` — builds a `ChatGateway` from config. Skips platforms whose adapters aren't implemented yet (warn, don't crash) so users can pre-configure Discord/Slack tokens in anticipation of v0.7b/c without breaking opensquid. Throws only when a configured + implemented platform has a real validation issue.
- New MCP tools: `chat_send` (route outbound by channel id) + `chat_list_channels` (report active platforms + allowlists + validation issues).
- Lazy-init pattern in `src/index.ts`: chat gateway opens on first chat_* tool call, cached for the rest of the MCP session. Non-chat sessions pay zero cost.
- 32 new tests (18 gateway, 9 telegram-adapter constructor + mention detection, 5 factory).
- Connection mechanism choices (per research): Telegram long-poll (grammy `bot.start()`), Discord Gateway WebSocket (discord.js, v0.7b), Slack Socket Mode (@slack/socket-mode + @slack/web-api directly, skipping Bolt to avoid the Express drag, v0.7c). All three are outbound-only — no public webhook required.

Outstanding for v0.7 completion:
- v0.7b: Discord adapter + `discord.js` optional dep
- v0.7c: Slack adapter + `@slack/web-api` + `@slack/socket-mode` optional deps + chat inbox bridge (inbound messages → MCP context surfacing)

### Added — 2026-05-16 (v0.6c)

**Cross-platform binary distribution scaffolding (#125)**

The infrastructure for shipping the `loop-engine` Rust binary alongside `opensquid` via npm `optionalDependencies` (esbuild / biomejs / swc pattern). No user-visible behavior change in this drop — local dev still resolves the binary via the existing 5-step discovery chain — but the publish-day flip is now a one-liner away.

- Engine repo (`MindcraftorAI/loop-engine`): `.github/workflows/release.yml` — triggers on `v*` tag, builds 6 target triples in a matrix (`{x86_64,aarch64}-apple-darwin`, `{x86_64,aarch64}-unknown-linux-gnu`, `{x86_64,aarch64}-pc-windows-msvc`), packages each as a tar.gz or zip with sha256, uploads to a GitHub Release. Linux arm64 uses the gcc-aarch64-linux-gnu cross-toolchain on the x86 ubuntu runner. All native runners for the rest.
- opensquid repo: 6 platform-specific stub packages at `npm/engine-<platform>-<arch>/package.json` with the correct `os` / `cpu` / `preferUnplugged` fields per the esbuild pattern. Each ships exactly one binary at `bin/loop-engine` (or `.exe`).
- Main `opensquid/package.json` adds an `optionalDependencies` block listing all 6 — npm filters by `os`/`cpu` so only the right one installs per host.
- Bootstrap resolver at `src/engine-binary-resolver.ts` — pure, sync, side-effect-free. Maps `(process.platform, process.arch)` → optional-dep name → resolves the package's `package.json` via `createRequire` → returns the `bin/<name>` path. Returns null cleanly when the dep isn't installed (pre-publish dev, `--no-optional`, wrong-platform install), so the legacy discovery chain stays the fallback.
- `src/config.ts::resolveEngineBin` inserts the bundled-binary check at slot 3 (between persisted config and ~/projects search). Bundled hits intentionally NOT persisted to config.json — the path is deterministic from npm layout, persisting it would point at stale node_modules paths across upgrades.
- 14 new unit tests for the resolver (platform→package map, binary name per platform, unsupported platform null, current-platform null pre-publish).
- Publish step is deferred — when ready, `git tag v1.x.y` in the engine repo runs the release workflow, then a script populates each `npm/engine-*/bin/` with the matching artifact, bumps versions in lockstep, and runs `npm publish` for each platform pkg + the main one.

### Added — 2026-05-16 (v0.6d)

**SKILL.md foreign-format import (#126)**

`opensquid codex install <path>` now auto-detects when the source is a SKILL.md file (Anthropic skills, obra/superpowers, everything-claude-code (ECC), Hermes Agent skills) and converts it on-the-fly to opensquid's native codex format. No `--source` flag needed in the common case — pass any SKILL.md (file or containing directory) and the right thing happens.

- Auto-detection precedence: `--source skill_md|native` override → `*.md` basename ends in `SKILL.md` → directory contains `SKILL.md` but no `codex.yaml` → fall back to native `codex.yaml` (codex.yaml wins on collision; pass `--source skill_md` to force).
- Variant heuristic: `origin: ECC` → ecc · `platforms:` or `metadata.hermes.*` → hermes · path includes `superpowers/skills/` or `/superpowers/` → superpowers · else → anthropic (pure spec) or unknown (non-standard fields present).
- Field mapping: `name` → slugified codex `id` (with the original preserved at `source.original_name`) · `description` → codex `description` + lesson `trigger` · `version` → codex `version` (defaults `1.0.0` with `metadata.imported.synthesized_version: true`) · `author` → `author.name` · `license` → `license` · Anthropic experimental `allowed-tools` → `foundation.tools[]` · Hermes `platforms` / `metadata.hermes.{tags,related_skills}` / ECC `origin` and every other non-standard key → preserved verbatim under `metadata.*` (Postel's-law catch-all so foreign fields aren't dropped). Body → verbatim at `lessons/<id>/lesson.md`.
- Provenance: every imported codex gets a `source: { kind: skill_md, original_variant, original_name, original_path, imported_at }` block so `codex list / doctor` and future exports can surface the lineage.
- 100% deterministic — no LLM call. Sub-skill body splitting deferred until a real corpus demands it (per find-simple-solutions).
- 28 unit tests + 7 CLI integration tests + 6 real-world fixtures (Anthropic skill-creator, Anthropic pdf, superpowers TDD, ECC tdd-workflow, Hermes dogfood, Hermes google_meet underscore-rewrite).

### Added — 2026-05-15 → 2026-05-16 ship cycle

**Codex format + auto-publish (#100-#106, #116, #117)**
- Codex pack format: YAML manifest (foundation/lessons/detection rules), portable across MCP hosts, exports `.claude-plugin/plugin.json` shims for vanilla Claude Code compat
- `opensquid codex install|list|remove|doctor|export` CLI
- Project ID card at `.opensquid/project.json` (identity survives folder moves)
- Engine binary registry at `~/.opensquid/config.json` (portable engine path)
- Auto-publish promoted lessons into `<!-- opensquid-rules -->` block in CLAUDE.md — both on `lesson.promote` MCP call AND on `codex install` (#116)
- Engine v1.2: `lesson.create` upserts by `(pack_id, external_id)` — re-installing the same codex updates rows in place instead of minting new ids (#117)

**Drift detection + honesty ledger + heartbeat (#110, #113-#115, #118, #124)**
- PreToolUse hook intercepts known anti-patterns (`git commit --amend`, force-push, substrate-purity violations, implicit `git push`)
- Stop hook reconciles claims-vs-action against the session tool-call ledger ("agent said 'running tests' but no Bash test call this turn")
- UserPromptSubmit surfaces broken promises + heartbeat nudges
- SessionEnd cleanup bounds disk usage
- Hooks-cli per-event HOOK_IDs + legacy-entry detection (#118 — fixes the duplicate-hook entries observed when re-installing codexes)
- Token-threshold heartbeat (#124) replaces the original auto-classifier subprocess: counts transcript tokens, arms a re-anchor nudge when delta crosses `OPENSQUID_HEARTBEAT_TOKENS` (default 20K). Agent does classification work inline per CLAUDE.md classify-and-act rules. Net delta: dropped ~1200 LOC + @anthropic-ai/sdk dependency; added ~340 LOC. In-MCP-ecosystem, no subprocess, no external LLM, no SDK.

**Lessons surface v0.5 (#119)**
- v0.5a (7ffc82b): `list_lessons` MCP tool (paginated, status-filtered, deterministic sort) + `capture_feedback` (thumbs_up/down → wedge gate signal-diversity input) + `supersede` (point old at new, causal chain preserved)
- v0.5b (2707df1): `list_memories` MCP tool (paginated, scope-filtered, frontmatter-only response)
- v0.5c (e390444): `manifest` MCP tool — central RAG-style assembly returning active lessons (deterministic-sorted, gate-annotated) + memory recall + assembly_stats in one call. Engine v1.4: `manifest.assemble` RPC handler.

**Portability: import / export across projects and machines (#122, #123)**

opensquid now has end-to-end import/export at two granularities — a single skill pack (codex) and the entire opensquid state — so the same rules / lessons / memories work across projects, machines, and team handoffs.

Codex-level (per skill pack):
- `opensquid codex install <path>` — IMPORT from a local directory containing `codex.yaml` + `lessons/`. Seeds lessons into the engine as promoted (pack-authored = user-equivalent, eviction-immune). Auto-publishes one line per lesson into the user's CLAUDE.md `<!-- opensquid-rules -->` block. Engine v1.2 upsert by `(pack_id, external_id)` means re-installing the same codex updates rows in place — no duplicate engine rows, no duplicate CLAUDE.md lines.
- `opensquid codex export <id> [--output <path>] [--force]` — EXPORT to a portable directory bundle. Output layout matches the install-source so a freshly installed bundle round-trips cleanly: `export on A → copy bundle → install on B` is the cross-machine/cross-project workflow. Bundle includes `.opensquid-export.json` provenance manifest (timestamp + opensquid version + source codex id).
- `opensquid codex list|remove|doctor` — round out the lifecycle.

System-level (entire opensquid state):
- `opensquid export [--output <path>] [--force]` — EXPORT the entire `~/.opensquid/` tree (every codex, every lesson in all status dirs, every memory with `.vec` sidecar, sessions, logs, config.json, projects.json) as a single tar.gz archive. Default filename `./opensquid-<timestamp>.tar.gz`.
- `opensquid import <archive> [--merge|--replace]` — IMPORT the archive back. `--merge` (default) layers on top of existing data, last-write-wins per file. `--replace` extracts to a tmp staging dir then atomic-renames over the destination — corrupt input never half-deletes your data.
- Validates that an input archive looks like an opensquid export (checks for `.opensquid/` root entry via `tar -tzf`) before doing anything destructive.
- Format: tar.gz via system `tar` (preinstalled on macOS, Linux, Windows 10+). Zero new runtime dependency. Encryption deferred — pipe through `gpg -c` externally for sensitive memories.

**Positioning + find-simple-solutions rule**
- README: new "Pairing with Hermes Agent" section with one-line `hermes mcp add opensquid` recipe; opensquid is additive (sits alongside Hermes' existing memory backend)
- ROADMAP: "Current direction" section locks the release sequence (v0.5 → v0.6 → v0.7 → v1.0 = feature-complete + bulletproof, earned not scheduled) and hard rule-outs
- `sangmin-personal-rules` codex gains find-simple-solutions promoted lesson — meta-rule from the #112 → #124 arc: build simplest thing that solves actual user need; add complexity only when simple version provably insufficient

**Sole-author trailer convention**
- All commits authored solely by Sangmin Lee. No `Co-Authored-By: Claude` trailers on this repo.

### Added — v0.5 hybrid recall

- **`recall` defaults to engine hybrid mode**: every memory query runs both
  semantic (cosine-similarity neighborhood on the embedder output) and text
  (token-overlap + substring match on description+body) in parallel, then
  RRF-merges by id. Items appearing in both lists get a strict score boost
  and `source: "both"`.
- **`min_similarity` flows down to the engine**: per-sub-search floor
  applied to RAW per-source scores BEFORE the RRF merge. Replaces the v0.4
  opensquid-side post-filter, which couldn't sensibly threshold RRF scores
  (range ≤0.033) against the same 0.5 default tuned for raw cosine.
- **`MergedHit.source` + `MemoryHit.source`**: carries the engine's
  attribution through the opensquid RRF. Renders as `"semantic"`, `"text"`,
  or `"both"` in the JSON response.
- **engine-client.ts**: `searchMemory()` accepts `mode` + `min_similarity`
  parameters. Backward-compatible — old callers default to `"semantic"`.

Solves the v0.4 false-negative on proper-noun queries (e.g. `"Gianna"` —
semantic 0.486 < 0.5 threshold but description literally contains the name).
Dogfood-verified end-to-end against the family memory.

See `docs/v0.5-hybrid-recall-design.md` for the locked design.

### Added — v0.4 Phase 1 (origination metadata)

- **`memorize` auto-attaches `origin` block** to every memory:
  `{ host, session_id, model, cwd_basename, written_at }`. Detected
  from env (`CLAUDE_SESSION_ID`, `OPENSQUID_HOST`, `OPENSQUID_MODEL`,
  `ANTHROPIC_MODEL`) with a `sha1(start_time+pid)[:8]` fallback for
  session_id. Explicit `origin` argument on the tool call overrides
  auto-detect.
- **`get_memory` returns `origin` block** alongside content + scope.
  Pre-v0.4 memories return `origin: null` cleanly.
- New `src/origin.ts` with `detectOrigin()` helper; engine v1.0+
  required for the wire schema.

### Added — v0.4 Phase 4 (recall quality)

- **`min_similarity` parameter** on `recall` (default `0.5`). Hits
  with similarity below the threshold are dropped per-source BEFORE
  merging — `merged: []` is the new "no relevant context"
  decision-makable signal. Pass `min_similarity: 0` to reproduce
  v0.3.1 behavior (return top-K regardless).

- **RRF (Reciprocal Rank Fusion) merge** — `recall` now returns a
  unified `merged` array alongside the per-source `lessons` /
  `memories` lists. Items keep their original similarity score;
  `rrf_score` = `sum over each list: 1 / (60 + rank_in_that_list)`
  with rank 1-based. When an entity surfaces in BOTH lists (v0.5+
  hybrid search), it accumulates contributions and naturally ranks
  above single-source items.

- New `src/recall.ts` with `filterBySimilarity`, `mergeRrf`, and
  type stubs.

### Added — v0.4 Phase 3 (memory lifecycle)

- **`update_memory`** tool — mutate description / content / scope on
  an existing memory. Identity (id, created_at, citation count,
  derived_from, origin) is always preserved. Re-embeds on content
  change (visible in subsequent recall similarity scores); the
  description/scope-only path skips the embed call. Errors when no
  mutable field is supplied OR when the id doesn't exist.
- **`forget`** tool — the user-facing memory delete. Default
  `force: false` respects user-immunity (returns RpcError -32003 if
  the memory is cited by a user-authored lesson). `force: true` is
  the user-initiated override. Idempotent — forgetting an
  already-gone memory returns `ok: true`.
- New engine-client methods: `updateMemory()`, `deleteMemory()`.

### Planned for v0.4 (remaining)

- Hooks-based automation (Claude Skill `UserPromptSubmit` + `Stop`).
- Hybrid lesson + memory search via RRF; similarity threshold gating.
- Wedge gate `origin_diverse` signal (multi-session reproducibility).

---

## [0.3.1] — 2026-05-14

The "actually usable for daily work" milestone. Three load-bearing
fixes from real-user testing on 2026-05-14: body-recall (truncation
defeats re-anchoring after drift), project-scope isolation (no cross-
project bleed), CLAUDE.md installer (automation that doesn't require
manual prompting each session).

### Added

- **`memorize` accepts optional `scope`** — `MemoryScope` shape (`"user"`,
  `"global"`, `{team:id}`, `{skill:id}`, `{project:id}`). When omitted,
  opensquid auto-detects the current project from `OPENSQUID_PROJECT`
  env var or the git repo's basename, falling back to `User`.

- **`recall` accepts `include_body` + `scope_filter`** — `include_body:
  true` returns the FULL memory body in `body_preview` (no 240-char
  truncation), critical for re-anchoring on long memories after
  context drift. `scope_filter` restricts results to memories matching
  a `MemoryScopeFilter` (default: `any_of([user, <detected-project>])`).

- **New `get_memory` tool** — fetch one memory by id with full content
  and scope. Companion to `recall` for the "preview hit looks relevant
  but is truncated" workflow.

- **`npx opensquid install | uninstall | doctor`** — idempotent
  CLAUDE.md installer with sentinel-bracketed block. Defaults to
  `~/.claude/CLAUDE.md`; `--project` flag targets `./CLAUDE.md`.
  - **DETECT, DON'T REPLACE**: existing CLAUDE.md content preserved;
    block is appended (or replaced in-place if a previous version's
    block is present).
  - **Idempotent**: same version on re-install → no-op.
  - **Reversible**: `uninstall` strips just the block; `doctor` reports
    installed version + diff vs current.

### Changed

- Engine v1.0.0 final (memory.get + scope/include_body wiring).
- `memorize` and `recall` defaults are scope-aware out of the box — the
  CLAUDE.md installer's auto-recall directive is safe to enable globally
  without leaking memories across projects.

---

## [0.3.0] — 2026-05-14

Engine integration milestone. opensquid is now a thin RPC client over
`loop-engine serve` — the engine owns all the real logic (wedge gate,
storage, lifecycle, semantic embedding), opensquid is the MCP↔engine
bridge.

### Added

- **`memorize`** tool — raw memory store, embedded via Qwen3-Embedding-4B
  (Ollama, local default).
- **`recall`** extended to fan out across lessons (text-match) +
  memories (semantic). Returns mixed results ranked by similarity.
- **`engine-client.ts`** — JSON-RPC 2.0 client that spawns `loop-engine
  serve` as a subprocess. Handles lazy-spawn, crash-recovery, lifetime
  pinning to the MCP session.
- Engine binary discovery via `OPENSQUID_ENGINE_BIN` env var.

### Removed

- The v0.1 TS reimplementation of the wedge gate + storage. Engine is
  the source of truth — opensquid v0.3 is RPC-only.

---

## [0.1.0] — 2026-05-14

First functional release. Four MCP tools route through a local file-storage backend at `~/.opensquid/lessons/{status}/<id>.json`. On-disk format mirrors `loop-engine`'s status-as-directory invariant so v0.2 integration is a storage-layer swap, not a rewrite.

### Added

- **`remember`** — captures a candidate lesson at `○ pending`. Accepts `description`, `body`, `evidence[]`, `authored_by` (`user`/`agent`).
- **`recall`** — text-match search across all non-discarded lessons. Naive token-overlap + substring boost; returns top N with similarity scores.
- **`promote`** — runs the wedge gate. Checks: body ≥50 chars, ≥1 evidence entry, `thumbs_up ≥ thumbs_down`, ≥1h age, not already terminal. Pass → moves to `□ promoted`; block → returns structured `BlockReason` list.
- **`eliminate`** — discards a lesson. User-authored lessons immune unless `force=true`. Moves to `discarded/` with optional reason.
- File-storage layout matching loop-engine's ADR-0010 (directory = canonical status).
- Forward-compatible `Lesson` type — same fields as loop-engine's `LessonFrontmatter`.
- `OPENSQUID_HOME` env var override for test isolation.

### Known limits

- Concurrent MCP requests can race (rare in practice — Claude Code / Cursor send one tool call at a time). Mutex lands in v0.2.
- Recall is text-match only; no semantic similarity. Embedder integration in v0.2.
- No multi-tenant scoping. Single-user only.

---

## [0.0.1] — 2026-05-14

Initial scaffold.

### Added

- MCP server skeleton on `@modelcontextprotocol/sdk`.
- Four-tool surface: `remember`, `recall`, `promote`, `eliminate`.
- Tool implementations stub out with a static response until `loop-engine`'s public crate surface is consumable.
- README with the Squid Game-inspired design language (○ △ □ status icons, "pass the gate or get eliminated" framing).
- MIT license.
- CI workflow scaffold.

[Unreleased]: https://github.com/smlee/opensquid/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/smlee/opensquid/releases/tag/v0.3.1
[0.3.0]: https://github.com/smlee/opensquid/releases/tag/v0.3.0
[0.1.0]: https://github.com/smlee/opensquid/releases/tag/v0.1.0
[0.0.1]: https://github.com/smlee/opensquid/releases/tag/v0.0.1
