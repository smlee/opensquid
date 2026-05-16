# 🦑 Open Squid roadmap

Living doc. Reflects current product thinking; items shift as we ship + learn. Each release section uses [SemVer 2.0](https://semver.org/).

For shipped releases see [CHANGELOG.md](./CHANGELOG.md).

---

## Current direction (2026-05-16)

**Audience:** Hermes Agent users (primary), Claude Code / Cursor / Codex power users who use Open Squid directly via MCP (secondary). Open Squid is additive — it sits alongside an agent's existing memory backend and adds a wedge-gated rule layer on top. Integration is via MCP; Hermes is already an MCP client. See README → _Pairing with Hermes Agent_.

**Marketing wedge:** "Your agent learns. You decide what gets locked in."

**Versioning policy (pre-1.0):** PATCH (0.0.X) is bug-fix-only. Everything else — new MCP tool, new schema field, new CLI subcommand, new wire-format field, breaking change — is a MINOR bump (0.X.0). MAJOR (X.0.0) reserved until explicit 1.0 declaration. Source of truth: `[[feedback_pre1_versioning]]`.

**Release sequence (SemVer 0.x.y; v1.0 is feature-complete + bulletproof, not a calendar moment):**

- v0.5 — lessons surface (in-flight: shipped v0.5a `list_lessons` + `capture_feedback` + `supersede`; v0.5b `list_memories`; pending v0.5c `manifest.assemble` + skill/persona/team `load_*`)
- v0.6 — release engineering: cross-platform binaries + codex export + system export (binaries + npm publish deferred until npm org exists; codex/system export shipped)
- v0.7 — chat connections bundled (Telegram + Discord + Slack as LOCAL bots; gateway abstraction; per `mem-163bde3b`) **+ v0.7.1 shipped: per-machine chat-daemon owns long-poll, per-project routing + v0.7.2 shipped: Telegram forum-topic per-project routing**
- **v0.8 — drift-as-codex refactor** (current focus, see audit findings + remediation plan below). Hardcoded drift gates → user-configurable codex rules. Stops drift-rule changes from being npm releases.
- v0.9 — additional surfaces (web, mobile) and brain thesis (MCP-of-MCPs orchestration)
- v0.X (whenever feature-complete) — hardening sprint: lock API surface, exhaustive test coverage, all known bugs squashed
- v1.0 — single moment when feature-complete AND bulletproof. Earned, not scheduled.

---

## 🔍 Audit findings (2026-05-16) and remediation plan

Today's end-to-end drift-protection ship cycle surfaced structural gaps in the drift gates themselves. Captured here so they drive v0.8 instead of being absorbed silently into the changelog.

### Audit findings

1. **Workflow-gate enforces only 2 of 7 phases.** The hook blocks `git commit` if `audit` + `post_research` aren't logged for the active task. But the locked rule (`[[feedback_workflow_cycle]]`) requires all seven phases: `pre_research → learn → code → test → audit → post_research → fix`. Result: task #132 (storage root docs) shipped today with only the last two phases logged. The gate green-lit a drift it was built to prevent.

2. **No "session-has-no-task" gate.** The entire live Telegram bootstrap chain (privacy mode debugging → bot re-add → `@userinfobot` chat_id capture → `createForumTopic` → routing write → confirmation send) ran without an active task ID. With no task, the workflow-gate has nothing to enforce against — substantive work happens without phase tracking, invisible to every gate.

3. **Drift gates are hardcoded TypeScript, not data.** Every refinement to `drift-patterns`, `workflow-gate`, `versioning-gate`, `honesty-ledger` requires editing the npm package source, bumping a version, building, publishing. Different users have different workflows — my 7-phase rule isn't anyone else's. Hardcoding mine into the package means everyone else has to fork it.

4. **Versioning slot mistakes.** Patch-bumped 5 minor changes in a row today (0.6.5 → 0.6.6 → 0.6.7 → 0.6.8 → 0.6.9 → 0.6.10 → 0.6.11) for things that were new public surface (new env var, new CLI subcommand, new JSON-RPC protocol, new schema, new autospawn behavior). All should have been minor bumps per pre-1.0 SemVer. The versioning-gate enforces "must bump SOMETHING per commit" but doesn't check whether the slot matches the diff.

5. **Honesty-ledger doesn't reconcile phase-name claims.** The ledger catches "said X / didn't do X" for ~12 patterns, but "I'll log learn and code" → `log_phase(learn)` + `log_phase(code)` isn't one of them. Phase-skip drift is invisible to the gate.

6. **Daemon long-poll 409s against external Telegram MCPs.** Discovered live during the v0.7.2 bootstrap: the chat-daemon collides with Claude Code's `plugin:telegram` bun bot because both want the bot's long-poll. v0.7.1 fixed the multi-opensquid-instance collision but not the external-MCP one. Workaround during bootstrap was to kill the plugin's bun process. Captured as task #144.

### Remediation plan

The remediation isn't "patch the gates" — that just re-creates the same shape with slightly tighter regexes. The remediation is **structural**: drift rules become data (codex YAML) loaded by a generic engine. Then per-user/per-project customization is configuration, not source code, and version bumps stop being the unit of rule-evolution.

#### v0.8.0 — drift-as-codex refactor (BIG)

Port hardcoded TypeScript gate logic into codex-loaded rule definitions:

- **`drifts/<id>.yaml`** in a codex — pattern id, severity, trigger (regex / shell / tool-name match), advisory message, lesson reference. Loader reads the active project's codex (or bundled default) + composes the catalog at hook start.
- **`workflows/<id>.yaml`** in a codex — phase sequence + which phases are required vs skip-with-reason. The workflow-gate becomes a generic enforcer of whatever the active workflow declares. My 7-phase rule ships as a codex preset; users with 4 phases or 9 phases write theirs.
- **`claims/<id>.yaml`** in a codex — claim regex + evidence shape (`tool_call`, `any_of`, `input_contains`). Honesty-ledger reloads its catalog from the active codex.
- **`policies/versioning.yaml`** in a codex — per-commit policy declarations (batch vs patch-per-commit; pre-1.0 SemVer slot enforcement; etc.). Versioning-gate enforces the declared policy.
- **Bundled default codex** ships my locked rules so opensquid out-of-the-box behaves identically to today. Users opt into forking via `opensquid codex install <my-fork>`.

Net effect: rule refinements stop being package releases. Patch-bump churn collapses. Different users' workflows coexist without forks.

#### Post-v0.8.0 — codex publishes (NO version bump on opensquid)

Once v0.8.0 ships the rule-loader engine, these are codex YAML publishes — not opensquid package releases. The whole point of v0.8.0 is that rule additions stop being version bumps:

- **`workflows/default-7-phase.yaml`** — encodes my workflow so the gate enforces all 7 phases, not 2. Backfills audit finding #1.
- **`workflows/no-task-no-action.yaml`** — session-level rule: "if session has N+ substantive Bash calls and no active task ID, warn." Backfills audit finding #2.
- **`policies/versioning-pre1.yaml`** — per-commit slot check: "diff added a new public API symbol AND was bumped as patch → block with hint." Backfills audit finding #4.
- **`claims/phase-claims.yaml`** — patterns for "I'll run pre_research / log learn / etc." reconciled against `mcp__opensquid__log_phase` calls. Backfills audit finding #5.

#### Operational (NOT a version bump) — backfill #132's missing phases

Retroactively log `pre_research`, `learn`, `code`, `test`, `fix` for task #132 with `note=backfilled 2026-05-16 post-audit, original commit was docs-only`. Pure data write, no source code change → no version bump.

#### v0.9.0 — daemon coexistence with external Telegram MCPs (task #144)

Originally misnamed "v0.7.3" — corrected per the pre-1.0 versioning rule (new feature → minor bump, next minor after v0.8.0 is v0.9.0). Two paths to explore: (a) detect external Telegram pollers on daemon start and offer webhook-mode (requires public ingress), (b) detect 409 and fall back to forwarding inbound via the external MCP's stdio if it's a known Claude Code plugin.

#### v0.10+ — additional surfaces (web, mobile) + MCP-of-MCPs

Per the brain thesis. Out of scope until v0.8 + v0.9 land.

#### Patch slots (0.X.Y for any current X)

Reserved for genuine bug fixes only — never scheduled in advance. A patch ships when a bug is found and fixed; the slot is allocated on the spot.

### Why this ordering

v0.8 BLOCKS everything else, because each subsequent gate refinement would otherwise become another patch-spam cycle. Get the architecture right once → every later rule change is a YAML publish, not a release. The v0.7.x audit findings are real but small; they're the FIRST consumers of the v0.8 engine, not pre-requisites for it.

### 🐛 Known bugs (discovered 2026-05-16, slotted for the relevant version)

Surfaced during today's drift-fix track + live Telegram bootstrap. Listed honestly so they don't get re-discovered later.

**Drift / workflow gates (→ fixed by post-v0.8.0 codex publishes, NOT by patch bumps):**

1. **workflow-gate enforces 2/7 phases** (finding #1 above) — green-lit task #132 shipping with phase-skip.
2. **No "session-has-no-task" gate** (finding #2) — entire Telegram bootstrap chain ran phase-less.
3. **honesty-ledger has no phase-claim patterns** (finding #5) — phase-skip drift invisible to claim reconciliation.
4. **versioning-gate doesn't check slot match** (finding #4) — patch-bumped 5 minor changes today.
5. **stripHeredocBodies regex has edge cases** for tab-stripping `<<-EOF` with indented closing delim — handled the common case in v0.6.5 but not exhaustively fuzzed. (Actual bug → patch slot when fixed.)

**Chat-daemon / Telegram:**

6. **chat-daemon 409-conflicts vs external Telegram MCPs** (finding #6, task #144) — collided live with Claude Code's `plugin:telegram` bun bot during the v0.7.2 bootstrap. v0.7.1's coexistence fix was multi-opensquid-only. NEW FEATURE → v0.9.0.
7. **chat-daemon doesn't subscribe to `my_chat_member` updates** — bot-membership-changed events (added to group, removed, permissions changed) don't get logged anywhere. Caused real confusion during the supergroup bootstrap when re-adding the bot produced silent zero-update telemetry. NEW FEATURE (subscribe to additional update types) → minor slot when shipped.
8. **chat_set_project_channel silently fails if no project card exists** — surfaces a clear error message, but operators still have to remember to run `opensquid project init` first. Should auto-run or at least chain the prompt. ARGUABLE: bug (silent fail) → patch, OR feature (auto-run) → minor. Decide on a per-fix basis.
9. **No MCP tool surfaces the orphan inbox** — `chat_poll_inbox` only reads a specific project's inbox. Operators have to `cat ~/.opensquid/inbox/orphan/telegram.jsonl` manually to debug "where did my message go?" Need a `chat_poll_orphan` or `--orphan` flag. NEW FEATURE → minor.
10. **MCP tool descriptions drift from actual version strings** — descriptions still say "v0.7a / v0.7c" in places after v0.7.2 + v0.7.1 changes. No automated check. ARGUABLE: cosmetic doc bug → patch, OR new lint feature → minor.
11. **chat-daemon log truncates inbound text at slice(0, 60)** without grapheme-aware boundary — emoji at the boundary may render broken in logs. Cosmetic. → patch slot when fixed.

**Documentation / process:**

12. **`feedback_pre1_versioning` rule was learned, not detected** — the user had to explicitly correct me after 5 wrong slot bumps. Until v0.8 ships the policies-as-codex layer, this is a re-occurring drift surface.
13. **#132 phase ledger backfill never happened** — operational backfill (pure data write, no source change) → no version bump required. See "Operational" subsection in the Remediation Plan above.
14. **Telegram plugin inbound routing broken to this session** — after the plugin disconnected + reconnected today, it stopped delivering `<channel>` blocks to this Claude Code session even though outbound replies still work. Not opensquid's bug (it's the plugin's session-binding code) but it forces fallback to curl + direct sendMessage. Document in `[[reference]]` memory so future sessions know to expect this.

### Audit-driven additions to v0.8.0 scope (from this section)

The Known Bugs list above isn't just a debug log — it generates concrete v0.8.0 scope additions:

- Codex schema must support **session-level rules** (not just per-tool-call rules) for bug #2
- Codex schema must support **policy-then-slot** rules for bug #4 (versioning gate composition)
- Codex `claims/` section must support **MCP-tool-call evidence** for bug #3 (phase-claim reconciliation)
- Bundled default codex pre-ships rules covering bugs #1, #2, #3, #4 so v0.8.0 ships them as **examples of the system**, not as another round of hardcoded patches.

**Hard rule-outs (do not propose):**

- No Python adapter in Hermes' `plugins/memory/` tree (per `mem-e3e03010`) — MCP integration only
- No "replace Hermes" framing — Open Squid is additive
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

- **Full-body recall option** — `recall` currently truncates `body_preview` at 240 chars. For longer memories, the LLM's re-anchoring is incomplete. Add `include_body: true` parameter (engine already supports it; expose through Open Squid).
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

- Ship Open Squid as a **Claude Skill plus MCP server**, with `UserPromptSubmit` and `Stop` hooks baked in.
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

Expose the rest of loop-engine's structured surface through Open Squid tools.

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

The strategic positioning shift: Open Squid stops being "a memory MCP" and becomes "the agent's central nervous system."

- **MCP-of-MCPs** — Open Squid acts as an MCP client to _other_ MCPs (Notion, GitHub, Telegram, etc.), presents a unified tool surface, routes requests, aggregates context.
- **Wedge applied across arms** — claims from any attached MCP get wedge-gated through Open Squid's promotion path.
- **Anatomical tool naming** — `chromatophore` (color/state visualizer), `ganglion` (local MCP cluster), etc. Lean into the cephalopod metaphor.

Reasoning: see `~/.claude/projects/-Users-slee-projects-loop/memory/project_opensquid_brain_positioning.md` — the squid mascot does triple duty (Squid Game / cephalopod cognition / brain+arms) and v1.1+ is where the "brain" thesis goes load-bearing.

---

## Cross-cutting parking lot

Ideas that don't have a release slot yet:

- **Telegram feedback channel** — user reactions on Telegram bot messages feed `capture_feedback` for the wedge gate (Sangmin's product insight 2026-05-14). Probably v0.5+ once the lesson surface is up.
- **Multi-tenant context** — engine's `Context` already supports tenant/team/user IDs; Open Squid is single-user today. v1.x+ when there's product demand.
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
