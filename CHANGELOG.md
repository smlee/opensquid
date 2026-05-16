# Changelog

All notable changes to `opensquid` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [SemVer 2.0.0](https://semver.org/) starting at 1.0.

---

## [Unreleased]

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

**Hermes positioning + find-simple-solutions rule**
- README: new "Pairing with Hermes Agent" section leads with verbatim issue quotes (#6051 learned-helplessness, #17583 user-vs-agent skill blur, #22563 memory pollution, Kilo "dealbreaker for power users") + one-line `hermes mcp add opensquid` recipe
- ROADMAP: "Current direction (2026-05-16)" section locks audience (Hermes primary), marketing wedge, release sequence (v0.5 → v0.6 → v0.7 → v1.0 = feature-complete + bulletproof, earned not scheduled), hard rule-outs
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
