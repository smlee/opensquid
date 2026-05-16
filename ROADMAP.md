# 🦑 opensquid roadmap

Living doc. Reflects current product thinking; items shift as we ship + learn. Each release section uses [SemVer 2.0](https://semver.org/).

For shipped releases see [CHANGELOG.md](./CHANGELOG.md).

---

## Current direction (2026-05-16)

**Audience:** Hermes Agent users (primary), Claude Code / Cursor / Codex power users who use opensquid directly via MCP (secondary). opensquid is additive — it sits alongside an agent's existing memory backend and adds a wedge-gated rule layer on top. Integration is via MCP; Hermes is already an MCP client. See README → *Pairing with Hermes Agent*.

**Marketing wedge:** "Your agent learns. You decide what gets locked in."

**Release sequence (SemVer 0.x.y; v1.0 is feature-complete + bulletproof, not a calendar moment):**

- v0.5 — lessons surface (in-flight: shipped v0.5a list_lessons + capture_feedback + supersede; v0.5b list_memories; pending v0.5c manifest.assemble + skill/persona/team load_*)
- v0.6 — release engineering: cross-platform binaries + codex export + system export (binaries + npm publish deferred until npm org exists; codex/system export shipped)
- v0.7 — chat connections bundled (Telegram + Discord + Slack as LOCAL bots; gateway abstraction; per `mem-163bde3b`)
- v0.8+ — additional surfaces (web, mobile) and brain thesis (MCP-of-MCPs orchestration)
- v0.X (whenever feature-complete) — hardening sprint: lock API surface, exhaustive test coverage, all known bugs squashed
- v1.0 — single moment when feature-complete AND bulletproof. Earned, not scheduled.

**Hard rule-outs (do not propose):**

- No Python adapter in Hermes' `plugins/memory/` tree (per `mem-e3e03010`) — MCP integration only
- No "replace Hermes" framing — opensquid is additive
- No enterprise SaaS pivot
- No silent provider auto-detect for the auto-classifier (no `auto-classifier` exists anymore — replaced by token-threshold heartbeat in #124; the agent does classification inline)

**v0.4 — shipped (24 commits as of 2026-05-16):**

The "in-ecosystem ship cycle" milestone. Highlights:

- Codex pack format (foundation/lessons/detection rules; portable; exports `.claude-plugin/plugin.json` shims for vanilla Claude Code compat)
- Project ID card (`.opensquid/project.json`); engine binary registry (`~/.opensquid/config.json`)
- Drift-detection PreToolUse hook (catches anti-patterns before commit)
- Honesty ledger (Stop hook reconciles claims vs tool calls; UserPromptSubmit surfaces broken promises; SessionEnd cleanup)
- CLAUDE.md auto-rule publishing on `promote` (and on codex install upsert per #117)
- Pattern-based `classify_utterance` MCP tool + `pending_candidates`
- Engine v1.2 pack-lesson upsert by `(pack_id, external_id)`
- Engine v1.3 lesson surface RPCs (list, capture_feedback, supersede); memory.list
- `opensquid codex export` (portable round-trip bundle)
- `opensquid export / import` (entire `~/.opensquid/` as tar.gz for machine migration)
- Hooks-cli legacy-entry detection + per-event HOOK_IDs (#118)
- Token-threshold heartbeat replaces auto-classifier subprocess (#124) — agent does classification inline; ~1200 LOC + @anthropic-ai/sdk dropped

See [CHANGELOG.md](./CHANGELOG.md) for the full per-commit history.

---

## Shipped — v0.3.1 (2026-05-14)

The "actually usable for daily work" milestone. Three load-bearing
fixes that turn v0.3 from a demo into a tool you reach for unconsciously.
See [CHANGELOG.md](./CHANGELOG.md) for details.

- **`memorize` accepts `scope`** + auto-detects project from CWD
- **`recall` accepts `include_body` + `scope_filter`** (defaults to
  user + detected-project)
- **`get_memory`** tool — fetch full body by id
- **`npx opensquid install | uninstall | doctor`** — idempotent
  sentinel-bracketed CLAUDE.md installer; detect-don't-replace

---

## Shipped — v0.3.0 (2026-05-14)

Five MCP tools wired through loop-engine via JSON-RPC subprocess.

- `remember` / `recall` / `promote` / `eliminate` (text-match for lessons)
- `memorize` (raw memory store, semantic via Qwen3-Embedding-4B)
- `recall` extended to fan out across lessons (text-match) + memories (semantic)
- Engine binary is local cargo build for now (~/projects/loop/engine/target/release/loop-engine)
- Storage at `~/.opensquid/lessons/{status}/<id>.md` + `~/.opensquid/memories/<id>.md`

---

## v0.3.1 detail (historical, retained for context)

Small ergonomic fixes that emerged from real-user testing on 2026-05-14.
This is the "actually usable for daily work" milestone — three load-bearing
fixes that turn v0.3 from a demo into a tool you reach for unconsciously.

### Memory drift / re-recall ergonomics

- **Full-body recall option** — `recall` currently truncates `body_preview` at 240 chars. For longer memories, the LLM's re-anchoring is incomplete. Add `include_body: true` parameter (engine already supports it; expose through opensquid).
- **`get_memory` tool** — explicit fetch by id, returns full memory. Used after `recall` surfaces a hit and the agent wants the canonical content (not just preview).
- **CLAUDE.md installer (`npx opensquid install`)** — idempotent installer that adds our automation directives to `~/.claude/CLAUDE.md` (or `./CLAUDE.md` with `--project`). Critical rules:
  1. **Detect, don't replace.** If a CLAUDE.md already exists, APPEND our block; don't overwrite the user's existing content.
  2. **Sentinel-marked block** lets future installs find + update without duplicating:
     ```markdown
     <!-- opensquid-automation:start v0.3.1 -->
     Use opensquid recall before answering substantive questions — your in-
     context memory drifts after ~10 unrelated turns. Use memorize when the
     user states a non-trivial fact, preference, or observation. Don't
     auto-call remember / promote / eliminate — those require explicit user
     intent (the wedge invariant).
     <!-- opensquid-automation:end -->
     ```
  3. **Idempotent on re-install** — same version → no-op; new version → replace between sentinels.
  4. **Reversible** — `npx opensquid uninstall` strips our block, leaves the rest intact.
  5. **Doctor command** — `npx opensquid doctor` reports what's installed, where, which version.

### MemoryScope (per-project isolation, the cross-project bleed fix)

The engine already has `MemoryScope::{User, Team(id), Skill(id), Project(id), Global}` and `MemoryScopeFilter` for queries. v0.3.1 exposes them through the MCP tool surface — without this, the global CLAUDE.md installer would surface memories from your work-project into your hobby-project context, which is exactly the wrong behavior:

- **`memorize` accepts optional `scope` parameter** — `{ kind: "project", id: "loop-engine" }` etc. Defaults to `User` (matches engine's `MemoryScope::default()`).
- **`recall` accepts optional `scope_filter` parameter** — `{ kind: "exact", scope: {...} }` for exact match, or `{ kind: "any_of", scopes: [...] }` for multi-scope returns. Defaults: return User-scope memories + memories matching the current detected project (if any).
- **Auto-detect project scope from CWD** — when `OPENSQUID_PROJECT` env var is set, OR when running inside a git repo (use repo name), `memorize` defaults `scope` to `Project(<detected>)`. Manual override always wins.
- **Engine-side wiring** — `memory.create` and `memory.search` RPC methods extended to accept `scope` / `scope_filter` params. Engine's `insert_scoped` + `MemoryScopeFilter::matches` are the implementation.

### Why these three together for v0.3.1

The installer creates a global CLAUDE.md that auto-calls `recall` everywhere. Without scope, that means EVERY project sees EVERY memory you've ever stored. With scope shipped in the same release, the installer can default to "project-scoped memorize, project-and-user-scoped recall" out of the box.

Body-recall is the third leg: even with the right memories filtered in, a 240-char preview isn't enough to refresh my drifting context on long memories. Full-body fetch is the load-bearing fix.

Three legs — installer, scope, body-recall — must ship together for the daily-work UX to actually feel right. None of them are useful alone:

- Installer without scope = cross-project bleed
- Scope without installer = no automation, manual re-anchoring
- Both without body-recall = drift survives the re-recall

### Why this is v0.3.1 not v0.4

No new architecture; just exposing existing engine surface (MemoryScope was Phase F work; `include_body` is an existing engine param) + a thin installer script. v0.4 is the structurally bigger move into Claude Skill hooks.

---

## v0.4 — Hooks-based automation + memory lifecycle

> **Detailed design:** [`docs/v0.4-design.md`](./docs/v0.4-design.md) — full architecture, ordering, risks, test plan.

Make the auto-recall + auto-memorize feel native rather than CLAUDE.md-suggested.

### New in v0.4 scope (added 2026-05-14)

- **Origination metadata** — every memory carries `origin: { host,
  session_id, model, cwd_basename, written_at }`. Strengthens the
  wedge gate's external-signal count (multi-session reproducibility =
  harder to fake) and unlocks session-aware recall biasing.

### Hooks-based automation

- Ship opensquid as a **Claude Skill plus MCP server**, with `UserPromptSubmit` and `Stop` hooks baked in.
  - `UserPromptSubmit` → calls `recall` with the user's query → injects results into the prompt context before the model responds.
  - `Stop` → analyzes the just-finished turn for novel facts → prompts the model to consider calling `memorize`.
- Manual override: users can disable specific hooks via env vars (`OPENSQUID_AUTORECALL=0` etc.) for testing.

### Memory lifecycle

- **`update_memory`** — currently insert-only; add editing (description + content).
- **`forget` (memory delete with user-immunity guard)** — same wedge invariant as lessons: user-authored memories immune to engine-initiated deletion.
- **Smart scope auto-detection** — beyond CWD-based project (v0.3.1), detect git-branch context, current skill in session, active persona. Falls back to user-scope.

### Recall quality

- **Hybrid search** — RRF (Reciprocal Rank Fusion) across text-match lessons + semantic memories. The engine's manifest assembly already supports this pattern; expose via `recall`.
- **Similarity threshold** — `recall` returns nothing when top hit < 0.5 (current: returns top-K regardless). Decision-makable signal vs. always-something noise.

---

## v0.5 — Lessons surface + skills/personas/teams

Expose the rest of loop-engine's structured surface through opensquid tools.

- `list_lessons` / `list_memories` (paginated)
- `capture_feedback` (thumbs up/down → wedge gate inputs)
- `supersede_lesson` (point old at new; preserves history)
- `load_skill` / `load_persona` / `load_team` (session-scoped activation)
- `manifest` tool — returns the engine's full assembled manifest (active lessons + memory recall + active skills/personas/teams) as one structured payload

---

## v1.0 — stable distribution

The version that ships to general users who don't have Rust installed.

### Cross-platform binary distribution

- Cross-compile `loop-engine` for darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64 via GitHub Actions matrix
- Publish per-platform npm subpackages (`@opensquid/engine-darwin-arm64` etc.)
- Main `opensquid` package declares them as `optionalDependencies` (esbuild/swc/biome pattern)
- TS launcher discovers + spawns the matching platform binary
- End-user UX: `npx opensquid` works on any machine without Rust knowledge

### Hardening

- SemVer freeze on tool surface
- `cargo public-api` gate on loop-engine
- Public README polish with the wedge claim + 4-layer ratchet defense table
- Published Claude Skill (Claude Code marketplace) with full docs

---

## v1.1+ — MCP orchestration (the brain thesis)

The strategic positioning shift: opensquid stops being "a memory MCP" and becomes "the agent's central nervous system."

- **MCP-of-MCPs** — opensquid acts as an MCP client to *other* MCPs (Notion, GitHub, Telegram, etc.), presents a unified tool surface, routes requests, aggregates context.
- **Wedge applied across arms** — claims from any attached MCP get wedge-gated through opensquid's promotion path.
- **Anatomical tool naming** — `chromatophore` (color/state visualizer), `ganglion` (local MCP cluster), etc. Lean into the cephalopod metaphor.

Reasoning: see `~/.claude/projects/-Users-slee-projects-loop/memory/project_opensquid_brain_positioning.md` — the squid mascot does triple duty (Squid Game / cephalopod cognition / brain+arms) and v1.1+ is where the "brain" thesis goes load-bearing.

---

## Cross-cutting parking lot

Ideas that don't have a release slot yet:

- **Telegram feedback channel** — user reactions on Telegram bot messages feed `capture_feedback` for the wedge gate (Sangmin's product insight 2026-05-14). Probably v0.5+ once the lesson surface is up.
- **Multi-tenant context** — engine's `Context` already supports tenant/team/user IDs; opensquid is single-user today. v1.x+ when there's product demand.
- **Voyage AI fallback** — second-tier paid embedder per the architecture decision. Already supported by the engine's OpenAI-compatible Embedder via config; just needs documentation.
- **Embedded loop-engine** — switch from subprocess to napi-rs native bindings for lower latency. Engineering call: probably not worth it unless profiling shows IPC is a bottleneck.

---

## Pinned references

- `~/projects/loop/docs/ARCHITECTURE.md` — engine-level architecture (storage backends, embedder selection, FTS5 fallback)
- `~/projects/loop/engine/CHANGELOG.md` — engine release notes
- Auto-memory entries (Sangmin's private):
  - `project_opensquid_brain_positioning` — strategic positioning
  - `project_loop_embedder_choice` — embedder decision rationale
  - `project_repo_placement_strategy` — engine in org, MCPs in personal
