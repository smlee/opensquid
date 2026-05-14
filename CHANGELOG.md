# Changelog

All notable changes to `opensquid` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [SemVer 2.0.0](https://semver.org/) starting at 1.0.

---

## [Unreleased]

### Planned for v0.4

- Hooks-based automation (Claude Skill `UserPromptSubmit` + `Stop`).
- `update_memory`, `forget` (user-immunity-respecting deletion).
- Hybrid lesson + memory search via RRF; similarity threshold gating.

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
