# Changelog

All notable changes to `opensquid` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [SemVer 2.0.0](https://semver.org/) starting at 1.0.

---

## [Unreleased]

### Changed — 2026-05-18 (0.7.35 — anti-drift rewrite: ATOMIC CUTOVER)

Fourth and final patch of the architectural rewrite per
`loop/docs/opensquid-anti-drift-unified-evaluator-design.md`. **Cutover
is now live**: `opensquid hooks install` registers Claude Code hooks
pointing at `node <bin> anti-drift <event>` (the new unified
evaluator) instead of `node <bin> hook <event>` (the legacy per-file
handlers).

Changes:
1. **`src/anti-drift/evaluator.ts`** — runners now incorporate the
   legacy side effects that aren't yet expressed as rules:
   - `runPreToolUseEvaluator` calls `recordToolCall` to populate the
     turn-ledger for Stop reconciliation
   - `runStopEvaluator` runs honesty-ledger reconciliation +
     turn-ledger clear + heartbeat `checkAndMaybeArm`, alongside the
     Stop-rule walk (inline-report-missing-phases)
   - `runUserPromptSubmitEvaluator` runs resume-detection +
     broken-promises consume + heartbeat-pending consume +
     `markRecallRequired`, alongside the UPS-rule walk (multi-task
     plan-mirror)
   - `runSessionEndEvaluator` walks SessionEnd rules (drift-catalog
     scan + session-state-cleanup) which already cover the legacy
     `clearSession` behavior
2. **`src/index.ts`** — new top-level subcommand `anti-drift <event>`
   that calls `runEvaluator(event)`. Legacy `hook <event>` dispatch
   preserved for backward compat with un-reinstalled settings.json
   entries.
3. **`src/hooks-cli.ts`** — `buildHookCommand` now returns
   `anti-drift <event>` instead of `hook <event>`. After
   `opensquid hooks install`, settings.json points at the new entry.
4. **`COMMAND_FINGERPRINT`** broadened from `/opensquid/dist/index.js hook `
   to `/opensquid/dist/index.js` so `isOurHook` recognizes BOTH legacy
   `hook <event>` AND new `anti-drift <event>` entries.

After this patch lands:
- New installs use the unified evaluator
- Existing installs that don't re-run `opensquid hooks install`
  continue working via the legacy `hook <event>` dispatch (which
  remains in index.ts)
- The legacy per-file handlers in `src/hooks/pre-tool-use.ts`,
  `stop.ts`, `user-prompt-submit.ts`, `session-end.ts` are no longer
  registered by `hooks install` but their CODE still exists; deleting
  the files is queued for a follow-up patch once dogfood-validation
  confirms the new evaluator behaves identically across all hook
  events.

Tests: full suite 751/751 (no test changes — runners are wired
internally; existing tests cover the same code paths via legacy entry
points + the new test suites cover the anti-drift internals).
Typecheck + prettier + build green.

User action required: re-run `opensquid hooks install` and restart
Claude Code to pick up the cutover. Without re-install, legacy
`hook <event>` continues to fire (still functional).

This completes the design-doc-defined architectural rewrite. All
4 anti-drift files exist (`state.ts`, `rules.ts`, `evaluator.ts` +
inline types). Outstanding items now scoped as small follow-ups:
- `rules.yaml` export for codex chunk-1 schema integration
- Delete legacy `src/hooks/{pre-tool-use,stop,user-prompt-submit,session-end}.ts`
  files (after dogfood-validation)
- D8 full Haiku-parser (current regex heuristic shipped)
- D4 HEREDOC bundled-commit gate
- Engine-side #172 consumer-name scrub

Per `[[feedback_pre1_versioning]]` v4: 0.7.34 → 0.7.35 patch bump.

### Added — 2026-05-18 (0.7.34 — anti-drift rewrite: evaluator.ts orchestrator)

Third patch of the architectural rewrite per
`loop/docs/opensquid-anti-drift-unified-evaluator-design.md`. Adds
`src/anti-drift/evaluator.ts` (~230 LOC) — the single orchestrator
that binds the 4 Claude Code hook events to the declarative rule
list from rules.ts.

Each event's runner:
- **PreToolUse**: walks PreToolUse rules; first block-verdict short-
  circuits exit 2; warns accumulate to stderr; pass through otherwise.
- **Stop**: walks Stop rules; surfaces → violations.log (next UPS
  picks up); always exit 0 (avoids D9 re-prompt-loop territory).
- **UserPromptSubmit**: walks UPS rules; surfaces → stdout (Claude
  Code injects into agent context); always exit 0.
- **SessionEnd**: walks SessionEnd rules (auto-actions: drift catalog
  scan + state cleanup); always exit 0.

Public exports:
- `runEvaluator(event: HookEventName)` — unified CLI dispatch (reads
  stdin, runs the right runner, writes output, exits)
- `runPreToolUseEvaluator(payload)` / `runStopEvaluator(payload)` /
  `runUserPromptSubmitEvaluator(payload)` / `runSessionEndEvaluator(payload)`
  — exported for direct testing
- `aggregatePreToolUse(verdicts)` — pure aggregation function
  (exit + stderr decision from a list of verdicts)

Tests: 8 new in `src/anti-drift/evaluator.test.ts` covering
aggregatePreToolUse contract (pass/block/warn ordering, exit codes,
trailing newline, surface-exclusion-from-PreToolUse). Full suite:
751/751 (was 743 + 8 new).

The evaluator is now functionally complete but not yet wired as the
production entrypoint. The 0.7.35 cutover updates `hooks-cli.ts` to
register hooks pointing at `anti-drift/evaluator.ts` (instead of the
per-file `hooks/*.ts` handlers) AND deletes the legacy handlers.

Per `[[feedback_pre1_versioning]]` v4: 0.7.33 → 0.7.34 patch bump.

### Added — 2026-05-18 (0.7.33 — anti-drift rewrite: rules.ts declarative rule list)

Second patch of the architectural rewrite per
`loop/docs/opensquid-anti-drift-unified-evaluator-design.md`. Adds
`src/anti-drift/rules.ts` (~310 LOC) — the declarative rule list
that replaces the per-file hook orchestration in `src/hooks/`.

18-rule catalog covering all 10 drift D-entries (D1–D10) plus the
preexisting drift-patterns (never-amend, no-implicit-push,
no-force-push-main, substrate-purity, plus auto-actions
honesty-reconcile, heartbeat-arm, session-state-cleanup).

Rule shape per the design doc:
- `id` / `catches` / `hook` (lifecycle event) — metadata
- `when(ctx)` — cheap sync gate that short-circuits before
  expensive check work
- `check(ctx)` — async, returns a `Verdict` (`pass` / `block` /
  `warn` / `surface`)
- `bypass` (optional) — env var that emergency-disables the rule
- `rationale` — agent-facing one-line reason for the error message

Today the `check` functions DELEGATE to existing `src/hooks/*`
helpers (engine-vocab-gate, versioning-gate, workflow-gate,
drift-patterns, inline-report-check, heartbeat, drift-catalog).
This patch ships the declarative SURFACE without re-implementing
every gate; the 0.7.35 cutover migrates the helper bodies into
`src/anti-drift/*` and deletes the old per-hook files.

Public exports:
- `RULES: Rule[]` — the 18-entry catalog
- `rulesForEvent(event)` — filters by hook event + env-var bypass
- `evaluateRules(ctx)` — walks applicable rules, short-circuits on
  the first PreToolUse `block` (most-restrictive-wins), accumulates
  surfaces/warns for Stop/UPS/SessionEnd
- types: `Rule`, `Verdict`, `HookContext`, `HookEvent`

Tests: 20 new in `src/anti-drift/rules.test.ts` covering catalog
shape (every rule has required fields, ids unique, D1-D10 covered),
`rulesForEvent` (filter by event, bypass env var, strict '1' value),
specific `when()` predicates for 7 rules, `evaluateRules`
short-circuit + accumulate semantics, `Verdict` shape contracts,
hook-event coverage. Full suite: 743/743 (was 723 + 20 new).

Next patches:
- 0.7.34 → `evaluator.ts` single orchestrator (binds PreToolUse /
  Stop / UPS / SessionEnd to `evaluateRules`)
- 0.7.35 → atomic cutover (delete `src/hooks/`, point `hooks-cli.ts`
  at `anti-drift/evaluator.ts`)

Per `[[feedback_pre1_versioning]]` v4: 0.7.32 → 0.7.33 patch bump.

### Added — 2026-05-18 (0.7.32 — anti-drift unified evaluator scaffold: state.ts foundation)

User directive: "yes that is what I want a full delivery." Beginning
the architectural rewrite described in
`loop/docs/opensquid-anti-drift-unified-evaluator-design.md`.

This patch lays the foundation: `src/anti-drift/state.ts` — the
filesystem-backed state primitives that the upcoming `rules.ts` +
`evaluator.ts` will read/write. No behavior change to existing
hooks; the new module lives alongside `src/hooks/` until the cutover.

Three state primitives:
- **active-task.json** (per-session) — single source of truth for
  the in_progress task signal. Replaces fragile transcript-parsing
  reliance once the cutover ships. Read returns null on file-absent
  OR malformed (fail-safe).
- **violations.log** (per-session, append-only) — rule firings
  surfaced to UPS via atomic rename-and-consume.
- **drift-catalog.jsonl** (per-project, durable across sessions) —
  audit trail; project-scoped path with session-scoped fallback.

Exports: `readActiveTask`, `writeActiveTask`, `clearActiveTask`,
`appendViolation`, `consumeViolations`, `driftCatalogPath`,
`sessionStateFiles` (SessionEnd cleanup helper).

Tests: 16 new in `src/anti-drift/state.test.ts` (tmpdir-isolated
to keep tests hermetic). Full suite: 723/723 (was 707 + 16 new).

This is the first patch of a multi-patch sequence completing the
architectural rewrite. Subsequent patches:
- 0.7.33 → `rules.ts` declarative rule list (18 entries)
- 0.7.34 → `evaluator.ts` single-binding orchestrator
- 0.7.35 → atomic cutover (delete `src/hooks/`, update `hooks-cli.ts`
  to point at `anti-drift/`)

Per `[[feedback_pre1_versioning]]` v4: 0.7.31 → 0.7.32 patch bump.

### Changed — 2026-05-18 (0.7.31 — D9 prompt-hook: squid emoji prefix for user visibility)

User directive: "you need to put a squid emoji so users can tell."
The D9 Stop-hook prompt (0.7.20) currently returns Haiku's response
without a visual marker, so the user can't immediately distinguish
the automated hook output from agent text in their UI. Other
opensquid hooks (UPS, honesty-ledger, heartbeat) all prefix with
🦑 — D9 should match.

Updated `FALSE_STOP_GUARD_PROMPT` to require Haiku begin its response
with the literal prefix `🦑 [opensquid D9-guard] ` followed by YES/NO
and a one-sentence justification. Added concrete example responses to
the prompt so Haiku's format compliance is high.

User must re-run `opensquid hooks install` (writes the updated prompt
to ~/.claude/settings.json) + restart Claude Code for the change to
take effect. dist/ rebuilt; install command picks up the new constant
automatically.

Tests: 1 new in `hooks-cli.test.ts` — verifies the source file embeds
the `🦑 [opensquid D9-guard]` marker (proxy for the prompt content).
Full suite: 707/707 (was 706 + 1 new).

Per `[[feedback_pre1_versioning]]` v4: 0.7.30 → 0.7.31 patch bump.

### Added — 2026-05-18 (0.7.30 — D3 inline-report variant: Stop-hook check for in-session reports lacking PHASES)

D3's existing `checkChatSendReportFormat` (0.7.25) only fires on
`mcp__opensquid__chat_send` calls. The agent can also write a
completion-shaped status report INLINE in session text — that
escapes D3 entirely. Surfaced this turn: the user had to ask
"where are my 7 phases in the report?" after I posted a chain-ship
summary table without the PHASES heading.

This patch closes the gap with a Stop-hook side check
(`inline-report-check.ts`):

- **Trigger**: assistant text contains 2+ version refs (`0.X.Y`
  shape) OR 2+ commit hashes (`[0-9a-f]{7,}` with at least one
  a-f to exclude decimal IDs)
- **Violation**: trigger fired AND text lacks `PHASES` heading
- **Surface**: writes a `BrokenPromise` entry that UPS injects
  into the next turn (existing pipeline; no new accumulator)

Conservative on purpose: single-version prose mentions don't fire,
single-commit-hash mentions don't fire. The dogfood test exercises
the exact "where are my 7 phases" incident shape (10 versions +
10 hashes, no PHASES) and confirms the check catches it.

New pure helpers: `countVersionRefs`, `countCommitHashes`,
`hasPhasesBlock`, `checkInlineReportFormat`.

`stop.ts` wires the check after honesty reconciliation; uses the
existing `recordBrokenPromise` + UPS surface pipeline. Non-fatal
on any error (consistent with Stop hook being cleanup, not blocking).

Tests: 20 new in `inline-report-check.test.ts`. Full suite: 706/706
(was 686 + 20 new).

Per `[[feedback_pre1_versioning]]` v4: 0.7.29 → 0.7.30 patch bump.

### Changed — 2026-05-18 (0.7.29 — D1 active-task gate upgraded from WARN to BLOCK)

`pre-tool-use.ts` orchestrator now EXITS with code 2 when an
active-task-gated MCP tool (`mcp__opensquid__log_phase`,
`mcp__opensquid__chat_send`) is called without an in_progress
TodoWrite task. Previously the check (`checkActiveTaskRequirement`,
#173 / 0.7.18) only WARNed to stderr; the agent could ignore it
freely (and empirically did — every time).

Catches the D1 headline drift in its strongest form: the agent
MUST call TaskCreate before log_phase / chat_send. Without an
active task, the workflow-gate has no task to validate phases
against, so the entire drift-protection chain falls over —
exactly what happened in the 2026-05-17 evening session per the
TASKS.md drift catalog.

Bypass: `OPENSQUID_SKIP_ACTIVE_TASK_GATE=1` for legitimate
non-task-scoped MCP calls (ad-hoc one-shot chat ping etc.). Loud
stderr warning on bypass.

`checkActiveTaskRequirement` pure function unchanged (still returns
warning string + null). Existing tests (12 in pre-tool-use.test.ts)
still pass — the change is to the orchestrator's response to a
non-null return.

This closes the full anti-drift rewrite sequence shipped in this
session: D9 (0.7.20), D6 (0.7.21), D10 (0.7.22), D5 (0.7.23),
D2 (0.7.24), D3 (0.7.25), D7 (0.7.26), D8 (0.7.27), D4 (0.7.28),
and D1 BLOCK upgrade (this patch). All 10 drifts in the
loop/TASKS.md catalog now have structural protection per
loop/docs/opensquid-anti-drift-unified-evaluator-design.md.

Full suite: 686/686 (unchanged — pure function behavior unchanged).

Per `[[feedback_pre1_versioning]]` v4: 0.7.28 → 0.7.29 patch bump.

### Added — 2026-05-18 (0.7.28 — D4 bundled-commit drift pattern)

New `bundled-commit` drift pattern fires when a `git commit -m`
message references 2+ `#N` task numbers on the same line. WARN
(non-blocking) — bundled commits aren't always bad, but the
auto-commit rule (CLAUDE.md) says prefer multiple small logical
commits over one large catchall, and 2+ task refs in a message is
the typical bundle shape.

Catches D4: commit `bef7eff` bundled "close #166 + defer #168 +
section-header rewrite" into one commit. Future bundles like that
will get warned before commit lands.

Known limitation: HEREDOC commit message bodies are stripped before
pattern matching (per `stripHeredocBodies` from v0.6.5), so refs
inside a HEREDOC body don't fire this pattern. Adding staged-content-
aware detection via a dedicated `bundled-commit-gate` (similar shape
to engine-vocab-gate) is deferred to a later patch — most bundled
commits use inline `-m`.

Tests: 4 new in `drift-patterns.test.ts`. Full suite: 686/686
(was 682 + 4 new).

Per `[[feedback_pre1_versioning]]` v4: 0.7.27 → 0.7.28 patch bump.

### Added — 2026-05-18 (0.7.27 — D8 multi-task plan-mirror reminder in UPS)

New `detectMultiTaskDirective` + `extractTaskRefs` in user-prompt-submit.ts.
When the user's prompt contains 2+ task references in a sequencing
pattern ("166 then 168", "#171 and #172", "166, 168", etc.), inject
a reminder at next UPS asking the agent to mirror back its parsed
plan before executing.

Catches D8: user said "166 then 168", agent did 166 then marked
168 deferred per stale memory. The plan-mirror requirement makes
the misread visible BEFORE the agent commits to the wrong reading.

Detection (intentionally narrow — false-positives in UPS are tolerable
but we don't want to fire on unrelated number prose):
- Explicit `#N` references always count
- Bare 2-4-digit numbers count only when connected by a sequencing
  word (then / after / and then / and / comma)

Soft surface (non-blocking). Agent reads the reminder and is expected
to mirror plan in its next response. Future tightening (Haiku-parsed
structured plan injection per the design doc rule #14) deferred to
a later patch — regex catches the common D8 incident shape and is
cheap.

Tests: 7 new in `user-prompt-submit.test.ts`
(`detectMultiTaskDirective — D8 (0.7.27)`). Full suite: 682/682
(was 675 + 7 new).

Per `[[feedback_pre1_versioning]]` v4: 0.7.26 → 0.7.27 patch bump.

### Added — 2026-05-18 (0.7.26 — D7 heartbeat-recall block via recall-required flag)

The heartbeat mechanism (Stop hook arms a nudge when the transcript
grows past the threshold; UPS surfaces the nudge to the agent's
context next turn) previously had no teeth: the agent could
acknowledge the nudge and continue without calling `recall`, which
is exactly drift D7 from the catalog.

This patch adds a per-session `recall-required.flag` file:

- **Set** by UPS after `consumePendingHeartbeat` returns a nudge
- **Checked** by pre-tool-use before any `mcp__opensquid__*` call
- **Cleared** by pre-tool-use when the agent actually calls
  `mcp__opensquid__recall`

When the flag is set, ANY `mcp__opensquid__*` tool other than
`recall` is blocked (exit 2) with an actionable stderr message.
The agent must call recall first; only then are subsequent MCP
calls allowed.

Implementation:
- New `markRecallRequired` / `isRecallRequired` / `clearRecallRequired`
  exported from `heartbeat.ts` (the flag is heartbeat-related state)
- `heartbeatSessionFiles` now includes the flag path so SessionEnd
  cleanup catches it
- pre-tool-use.ts wires the check + clear into its orchestrator
- Bypass: `OPENSQUID_SKIP_RECALL_GATE=1` for genuine emergencies
  (e.g. engine unreachable, recall genuinely not callable)

Tests: 6 new in `heartbeat.test.ts` (`recall-required flag (D7)`):
flag absence default, mark/check, clear, idempotent clear,
per-session isolation, SessionEnd cleanup inclusion. Full suite:
675/675 (was 669 + 6 new).

Per `[[feedback_pre1_versioning]]` v4: 0.7.25 → 0.7.26 patch bump.

### Added — 2026-05-18 (0.7.25 — D3 7-phase report format check on chat_send)

New `checkChatSendReportFormat` in pre-tool-use.ts fires when
`mcp__opensquid__chat_send` is called with text starting with the
`🦑 #<N>` task-completion report marker but missing the `PHASES`
heading. Non-blocking WARN telling the agent that reports must list
each of the 7 phases (pre_research, learn, code, test, audit,
post_research, fix) with a concrete one-line finding per
`[[feedback_telegram_reports]]` — not just ✅ or a paragraph summary.

Catches D3: the #170 first Telegram message this session was a
free-form summary; user had to ask "where is the 7 layer report?"
to prompt the proper format.

Implementation is a tiny pure function alongside
`checkActiveTaskRequirement` (#173 / D1 partial fix), wired into
the orchestrator next to it. Heuristic: any chat_send body matching
`^\s*🦑\s+#\d` is interpreted as a task report; absence of the
literal `PHASES` keyword surfaces the warning. Accepted noise: a
genuine non-report message starting with the squid + hash pattern
will false-fire — rare in practice, easy to bypass by not opening
with the marker.

Tests: 6 new in `pre-tool-use.test.ts`
(`checkChatSendReportFormat — 0.7.25 / drift D3`). Full suite:
669/669 (was 663 + 6 new).

Per `[[feedback_pre1_versioning]]` v4: 0.7.24 → 0.7.25 patch bump.

### Added — 2026-05-18 (0.7.24 — D2 Telegram routing redirect)

New drift pattern `telegram-redirect-report` fires when the agent
calls `mcp__plugin_telegram_telegram__reply` with a body starting
with `🦑 #<N>` (the established task-completion report marker).
Surfaces a WARN telling the agent these reports go via
`mcp__opensquid__chat_send` to the project's `report_channel`
(supergroup + topic) per `[[feedback_telegram_reports]]`, not via
plugin:telegram reply (which is the user's DM).

Catches D2 in the catalog: the agent's first 0.7.10 #170 completion
report this session was sent via plugin:telegram reply to the
RaumPilates DM instead of the squidbot supergroup, leaking
opensquid-internal content into a cross-purpose channel.

Implementation:
- `DriftPattern.tool` type broadened from
  `"Bash" | "Edit" | "Write" | "*"` → `string` so MCP tool names
  match directly. Existing patterns unchanged; new pattern matches
  exactly `mcp__plugin_telegram_telegram__reply`.
- Trigger uses `text_regex` on the `text` field of the tool input
  (`^\s*🦑\s+#\d`). Severity `warn` (non-blocking) because the user
  may legitimately want to reply with the squid emoji + a hash; the
  warn re-routes intent without preventing the call.

Tests: 4 new in `drift-patterns.test.ts`
(`drift catalog — telegram-redirect-report (D2)`). Full suite:
663/663 (was 659 + 4 new).

Per `[[feedback_pre1_versioning]]` v4: 0.7.23 → 0.7.24 patch bump.

### Added — 2026-05-18 (0.7.23 — D5 multi-patch catch-up bump detection in versioning-gate)

D5 root cause was actually the versioning-gate not firing during
broken-D1 sessions (the workflow-gate session_id mismatch took down
the surrounding hook chain). #173 fix structurally prevents D5 going
forward — every src commit now triggers the existing gate, which
already requires a matching version-line diff in the same commit.

This patch adds a complementary signal: WARN (non-blocking) when the
manifest's version diff is a multi-patch jump (e.g., 0.7.10 → 0.7.14
in one commit). Per `[[feedback_pre1_versioning]]` v4: every src
commit = exactly one patch bump. A multi-patch jump in a single
commit usually means earlier src commits shipped without bumps —
which is the exact D5 incident shape.

Implementation:
- `manifestHasVersionBump` → `readManifestVersionBump` (returns the
  parsed `{from, to}` jump or null)
- New `parseVersionJumpFromDiff` pure fn handles Cargo + package.json
  shapes (anchored vs unanchored regex per existing v0.6.3 audit fix)
- New `isMultiPatchJump` pure fn — same major.minor, patch advances
  by > 1
- Only flags same-major.minor patch jumps; minor/major bumps are
  user-authorized (PATCH-ONLY rule forbids agent from naming them,
  not from observing them)

12 new tests in `versioning-gate.test.ts`:
- 4 for `parseVersionJumpFromDiff` (Cargo, package.json, multi-patch,
  null on non-version diff)
- 6 for `isMultiPatchJump` (D5 shape, 2-step, normal +1, minor bump,
  first-time, non-SemVer)
- 2 end-to-end via real tmpdir git fixtures (warns on jump, silent
  on +1)

Full suite: 659/659 (was 647 + 12 new).

Per `[[feedback_pre1_versioning]]` v4: 0.7.22 → 0.7.23 patch bump.

### Added — 2026-05-18 (0.7.22 — D10 automated drift catalog at SessionEnd)

New SessionEnd-time scanner that walks the session's JSONL transcript
and records three classes of drift markers to a per-project (or
per-session fallback) JSONL log:

1. **User-correction phrases** in user messages — "you drifted",
   "stop X-ing", "don't repeat", "no not that"
2. **Locked-rule citations** in user OR assistant messages —
   `feedback_*`, `mem-<hex>`, `drift D\d+`
3. **Agent mea-culpa phrases** in assistant messages — "I should have",
   "I drifted", "I false-stopped", "my mistake"

Entries land at `<dataRoot>/projects/<uuid>/drift-catalog.jsonl` when
the project UUID resolves from cwd (via the same
`findProjectCard` walk used elsewhere), or
`<dataRoot>/sessions/<id>/drift-catalog.jsonl` as fallback so data
isn't lost on no-card sessions.

Entry schema: `{timestamp, session_id, kind, evidence, context}` —
context is ±100 chars surrounding the match for retroactive analysis.

Catches drift D10 in the catalog: previously the agent only catalogued
its drifts AFTER the user prompted "please put in all the drifting
issues found recently." This makes the cataloguing automatic — the
dogfood proof writes itself.

Fail-open: any error (missing transcript, parse failure, write
failure) is swallowed with a stderr warning. SessionEnd is cleanup,
not blocking.

`session-end.ts` now reads `transcript_path` + `cwd` from the hook
payload (previously only `session_id`) and runs the scan before
`clearSession` (so any session-scoped state used for context is still
available).

Tests: 18 new in `drift-catalog.test.ts` covering each marker class,
malformed-line handling, entry-shape verification, and
`resolveCatalogPath` for both project-card and session-fallback
branches. Full suite: 647/647.

Per `[[feedback_pre1_versioning]]` v4: 0.7.21 → 0.7.22 patch bump.

### Added — 2026-05-18 (0.7.21 — D6 engine-vocabulary gate — cwd-aware, scans -m message + staged diff)

New `engine-vocab-gate` fires in the PreToolUse hook for `git commit`
when the working directory looks like an engine repo
(`*/engine` or `*-engine`). Two-layer scan:

1. **Commit message** — parses the `-m` flag from the bash command
   (including HEREDOC bodies) and rejects matches for
   `opensquid|claude[._\- ]code|open[._\- ]squid` (case-insensitive,
   word-bounded).
2. **Staged diff** — runs `git diff --cached --unified=0` and scans
   added lines for the same consumer-name pattern. Excludes paths
   under `src/host/claude_code/**` (structurally consumer-specific)
   and lines that look like MIT/Copyright attribution comments.

Replaces the prior `substrate-purity` drift pattern (in
`drift-patterns.ts`), which only matched commit messages where the
bash command itself contained the path `loop/engine` — which it
basically never does in real engine work (cwd is the engine dir, the
command is just `git commit -m "..."`). The new gate uses the
hook-payload `cwd` directly.

Catches drift D6 in the catalog: engine commit `dfe7480` (0.5.2)
message + CHANGELOG referenced "opensquid" repeatedly when both
should have stayed substrate-pure per
`[[feedback_engine_vocabulary_discipline]]`.

Override: `OPENSQUID_SKIP_ENGINE_VOCAB_GATE=1` for genuine
emergencies (migration notes etc.). Loud stderr warning on bypass.

Tests: 23 new in `engine-vocab-gate.test.ts` covering
`isEngineRepoCwd` (7), `scanCommitMessage` (6), `parseDiffForConsumerNames` (7),
`checkOverrideEnv` (3). Full suite: 629/629.

Wiring: `pre-tool-use.ts` adds `cwd?: string` to its `ClaudeHookInput`
type (provided by Claude Code's hook payload per the official hooks
reference) and threads it into both the new gate AND the existing
versioning-gate (which previously defaulted to `process.cwd()`, fine
in practice but the explicit threading is cleaner).

Per `[[feedback_pre1_versioning]]` v4: 0.7.20 → 0.7.21 patch bump.

### Added — 2026-05-17 (0.7.20 — D9 false-stop guard via Claude Code native prompt hook)

`opensquid hooks install` now writes a second Stop hook entry of
`type: "prompt"` alongside the existing `type: "command"` Stop hook.
Claude Code evaluates the prompt against the assistant's just-finished
turn using `claude-haiku-4-5`; YES allows the stop, NO blocks it and
re-prompts the agent.

Drift D9 (false stops — trailing "Run it?" / "Want me to start B4?" /
"Should I continue?" politeness reflexes) is now caught and rolled back
to a recovery turn without user intervention. Catches the patterns
catalogued in `loop/TASKS.md` D9 + violations of
`feedback_full_automation_mode`.

Implementation choices per research synthesis 2026-05-17:

- Uses Claude Code's **native** `type: "prompt"` hook primitive — no
  `claude --print` subprocess wrapper in opensquid code. Auth, latency
  budget, and lifecycle are framework-managed.
- Prompt is framed so the default (YES, allow stop) fires on most
  turns; only trailing politeness reflexes tip to NO.
- Subscription-bound (model = `claude-haiku-4-5`); counts against
  Claude Code subscription quota per `project_llm_provider_via_claude_code`.

`isOurHook` recognizes the new entry by `_id`
(`opensquid-stop-false-stop-guard`); `uninstall` removes it cleanly;
`doctor` counts it under Stop. Tests: 3 new in `hooks-cli.test.ts`
covering recognition + foreign-id rejection + unmarked rejection.
Suite: 606/606.

**This is one rule of the broader anti-drift rewrite designed in
`loop/docs/opensquid-anti-drift-unified-evaluator-design.md`.** D9 ships
first because the user explicitly flagged it as the most painful drift.
Rules for D1 (already partially shipped 0.7.18), D2, D3, D4, D5, D6,
D7, D8, D10 land in subsequent patches per the same design doc.

Per `[[feedback_pre1_versioning]]` v4: 0.7.19 → 0.7.20 patch bump.

### Cleanup — 2026-05-17 (0.7.19 — relocate internal planning out of public repo)

Per directive "nothing internal should be public-facing": removed all
internal-planning content from the opensquid repo. Functionally a no-op
for consumers.

Removed from repo (relocated to internal monorepo):

- `docs/drift-as-codex-design.md`
- `docs/v0.4-design.md`
- `docs/v0.5-hybrid-recall-design.md`
- `ROADMAP.md`

Edited (dropped broken refs to the moved files):

- `CHANGELOG.md` — removed two doc-link sentences inside historical 0.7.3
  and v0.5 entries
- `src/index.ts` — comment in the hybrid-recall block no longer points at
  the moved design doc

Added:

- `.gitignore` entry for `.opensquid/` so local runtime state doesn't leak
  into the public repo

### Added — 2026-05-17 (0.7.18 — pre-tool-use warns when active-task-gated MCP tool called without in_progress task #173 / drift D1)

The workflow-gate silently fail-opens when no `in_progress` TodoWrite
task exists in the transcript (workflow-gate.ts:97-100). That's
correct behavior for legitimate ad-hoc commits — but it also masks
the failure mode "agent never calls TaskCreate." During the
2026-05-17 evening session, the agent shipped #166/#168/#170 with
phase ledger entries written but the workflow-gate disengaged the
whole time because no in_progress task existed.

This commit adds visibility: when the planned tool is
`mcp__opensquid__log_phase` or `mcp__opensquid__chat_send` AND
`readActiveTaskId(transcript_path)` returns null, the PreToolUse
hook emits a loud stderr warning:

```
🦑 [opensquid] mcp__opensquid__log_phase called without an in_progress TodoWrite task —
the entries it writes WON'T be validated by the workflow-gate.
Call TaskCreate (and set in_progress) first so the gate has an
active task to enforce against.
```

Non-blocking — legitimate ad-hoc MCP usage still works. Transcript-
read failures are swallowed so the hook never blocks on its own bug.

New exported helper `checkActiveTaskRequirement(call, transcriptPath)`
for direct testing. `pre-tool-use.test.ts` is NEW — pre-tool-use.ts
previously had no direct test coverage despite being the most
load-bearing hook.

**Why this is the headline drift fix:** before this commit, the
gate's silent fail-open mode meant the entire drift-protection
track could be visually green (phases logged, ledger written) while
actually validating nothing. Now the gap surfaces at the call site,
not at end-of-session.

**Tests:** 6 new tests in `src/hooks/pre-tool-use.test.ts`. Full
suite 603/603 (was 597). Pre-push checklist green.

### Changed — 2026-05-17 (0.7.17 — drift-as-codex chunk 3b: honesty-ledger claim catalog moves to codex #168)

`honesty-ledger.ts`'s 15-entry `CLAIM_PATTERNS` array was previously
maintained directly in TypeScript. Now it's sourced from
`src/codex/bundled-default/codex.yaml` under the `claims:` section,
loaded once at module init via the chunk-2 loader, and bridged into
the existing `ClaimEvidenceShape` shape so the rest of the file is
unchanged.

**Schema extension:** added `{ kind: "any_tool" }` to
`CodexClaimEvidence` (types.ts + parse.ts zod). Two of the 15
patterns (`starting-now`, `audit-done`) use this evidence kind and
required the schema to support it. The codex catalog now matches
the honesty-ledger semantics 1:1.

**Bridge function:** `codexEvidenceToLedgerEvidence()` maps codex
evidence kinds (`tool_call`) to the ledger's legacy names
(`tool_called`); also drops codex's `input_contains.field`
parameter, which the ledger doesn't use. Single seam between the
two vocabularies.

**Fail-open:** if the codex is unloadable, `CLAIM_PATTERNS` is the
empty array and no claims fire. Stderr warning emitted at module
init for visibility. Same fail-open posture as workflow-gate
(chunk 3a).

**Behavior preserved:** all 15 patterns ported byte-for-byte from
the previous TS array — same regex, same evidence shapes, same
promise labels (codex `unfulfilled_message`). The 78 honesty-ledger
tests pass unchanged; full suite 597/597.

**Dead code removed:** the previous TS-hard-coded array was deleted
from honesty-ledger.ts. Git history preserves it; no value to
keeping a 250-line dead reference in the source.

### Changed — 2026-05-17 (0.7.16 — drift-as-codex chunk 3a: workflow-gate reads required phases from codex #168)

`workflow-gate.ts` previously had its required-phase list hard-coded
as a `REQUIRED_PHASES` const. Now it derives the list at gate-check
time by calling `loadBundledDefaultCodex()` (from chunk 2) and
filtering `default_workflow_id`'s phases to those with
`required: true`. Same 6 phases as before (pre_research, learn, code,
test, audit, post_research — `fix` stays soft), but sourced from
YAML, not TypeScript.

New exported function `getRequiredPhasesFromCodex()` for direct
testing. Fail-open behavior added: if the codex is unloadable (parse
error, missing file, missing default_workflow_id), the gate emits a
stderr warning and allows the commit, consistent with the other
fail-open paths (engine-unreachable, no-transcript, no-active-task).

**Tests:** 2 new tests in `src/hooks/workflow-gate.test.ts` —
codex-sourced phase list matches expected 6, `fix` excluded. The
12 pre-existing tests pass unchanged (semantics preserved). Full
suite 597/597 (was 595).

This is the first real consumer of the chunk-2 loader. Chunk 3b
(honesty-ledger cutover) follows next.

### Added — 2026-05-17 (0.7.15 — drift-as-codex chunk 2: bundled-default codex loader #168)

New module `src/codex/loader.ts` reads `src/codex/bundled-default/codex.yaml`
once per process and returns the parsed `FocusedCodex`. Singleton
cache; cross-platform path resolution that works in both the src tree
(vitest direct execution) and the dist build (published npm package).
A test-only `__resetCachedCodexForTesting()` clears the cache for
deterministic unit tests.

This is the substrate piece of drift-as-codex — chunks 3a (workflow-
gate cutover) and 3b (honesty-ledger schema bridge + cutover) consume
this loader to source their rule lists from the codex instead of
hard-coded TypeScript constants. Without this loader, the chunk-1
schema + bundled YAML were a hill of unused infrastructure; with it,
the bundled codex becomes the source of truth.

**Tests:** `src/codex/loader.test.ts` (NEW, 6 tests) — loads + parses,
exposes drift/workflow/claim/policy sections, singleton cache, reset-
for-testing semantics, standard-7-phase workflow shape, versioning-
pre1-patch-only policy shape. Full suite 595/595 (was 589 before).

### Fixed — 2026-05-17 (0.7.14 — engine-client stuck after subprocess exit, SHIP-BLOCKER #170)

`EngineClient` was permanently broken after any external engine
subprocess exit (crash / OOM / pkill / signal). The cause:
`ensureStarted()` memoizes its initial-ping promise in
`this.startupAck`, but `proc.on("exit")` only cleared `proc` and
`reader` — `startupAck` stayed resolved. Next call: `ensureStarted()`
saw the cached resolved promise and returned without respawning;
`call()` then saw `proc === null` and rejected with
`"engine subprocess not running"`. Permanent until opensquid (and
therefore Claude Code) restarted.

This violates the explicit "Survive crashes: if the subprocess exits,
the next call respawns" invariant documented in the engine-client
header — the architecture was supposed to be self-healing across
engine crashes. The bug surfaced during #166 validation when `pkill`
was used to flush the running engine binary after rebuild; the same
failure mode hits any public user who ever sees their engine crash.

**Fix:** add `this.startupAck = null;` in the `proc.on("exit")`
handler. 3 LOC in `src/engine-client.ts:108-110`.

**Tests:** new `src/engine-client.test.ts` — first tests for this
file. Mocks `node:child_process.spawn`, simulates subprocess exit
deterministically, verifies (a) a second call after exit respawns
into a fresh subprocess and (b) in-flight pending calls reject
correctly when the subprocess dies. 589/589 full suite.

**Manual repro (for reference if the test ever regresses):**

1. Start any opensquid MCP session
2. `pkill -f 'loop-engine serve'`
3. Call any opensquid MCP tool that uses the engine (e.g. `log_phase`)
4. Pre-#170: permanent `"engine subprocess not running"` until Claude
   restart. Post-#170: respawn transparently, call succeeds.

### Docs — 2026-05-17 (0.7.13 — README rewrite for public release, B4)

Added a 5-minute setup block near the top of the README (4-step bash:
clone+build, claude mcp add, hooks install, restart+verify). Replaced
the terse "Hooks (v0.4)" section with an expanded "Drift protection
(optional)" section covering all 6 hooks (drift-patterns + workflow-
gate + versioning-gate + honesty-ledger + UserPromptSubmit + SessionEnd)
with their skip env-vars (`OPENSQUID_SKIP_DRIFT`,
`OPENSQUID_SKIP_WORKFLOW_GATE`, `OPENSQUID_SKIP_VERSION_GATE`,
`OPENSQUID_HEARTBEAT_TOKENS`), install/uninstall idempotency notes, an
inline-prefix skip pattern with 3 examples, and a "what's NOT a hook"
disclaimer so users who only want the memory MCP know they can skip
hook installation entirely.

### Fixed — 2026-05-17 (0.7.12 — honesty-ledger prose false-positives in 3 patterns #169)

Three claim patterns from #150 were firing on prose that describes
the system rather than on first-person commitments. Six+ false-
positive nags observed during 2026-05-17 evening conversation.

**`phase-logged`** — dropped the bare `\blog_phase\b` alternation.
Fired on any mention of the tool name in prose ("the log_phase tool
writes to...", "mcp**opensquid**log_phase" in code references). The
phase-word-aware alternations ("logged the audit phase", "phases
logged") still fire and catch the legitimate promises.

**`version-slot-assignment`** — split into two alternations:
inherently-committal phrasings (`next minor`, `next major`, `bumping
to (minor|major)`, `ships as vX.Y.Z`) fire on any match; bare version
strings (v0.8, v0.9, v1.0) now REQUIRE a first-person commitment verb
within ~40 chars before. Solves the false-positive where the agent
references a slot the USER previously named ("the user wants v0.8 to
do X") or quotes a roadmap line in scoping prose. Verb list also
extended to plurals (ships/bumps/releases/tags/names/picks).

**`session-no-task`** — tightened bare `\bexecuting\b` to require
first-person framing: `(?:I'?(?:'?m|'?ll)|now\s+i'?(?:m|ll))\s+executing`.
Was firing on passive descriptions like "the script is executing
the migration" or "while opensquid is executing the codex". Other
alternations (`now i'll`, `let me X`, `i'll X`) already required
first-person; only `executing` was over-broad.

**Tests:** 15 new tests (3 false-positive eliminators + 12 true-
positive retention cases). 2 existing tests updated to reflect the
new behavior (1 flipped from `toContain` to `not.toContain` for the
bare-`log_phase` case; 1 changed "Executing" → "I'm executing"). Full
suite 587/587.

### Fixed — 2026-05-17 (0.7.11 — workflow-gate session_id mismatch #166, engine 0.5.2 lockstep)

**The headline drift gate was a no-op for the entire 2026-05-17
evening session, and would have stayed that way indefinitely.**

`log_phase` (writer) supplied a PID-derived MCP session id
(`mcp-<pid>-<startMs36>`) while the workflow-gate hook (reader)
supplied Claude Code's session UUID. The engine indexed entries by
session_id as a path segment, so the two id surfaces never matched.
Writes went into `~/.opensquid/phase_ledger/mcp-19117-tf4ul0/...`
while reads looked under `~/.opensquid/phase_ledger/26e0203a-.../...`
— different filesystem locations entirely. Gate found an empty
ledger and would have blocked every commit, except other fail-open
paths (no transcript, no in_progress task, engine RPC errors) were
the dominant code path so the brokenness was invisible.

**Fix:** drop `session_id` from the phase-ledger storage scheme
entirely. The ledger is now keyed by `task_id` alone. A task that
spans multiple sessions (e.g. after `claude --resume`) accumulates
phases across them correctly, which matches the actual semantics of
the 7-phase workflow.

**Breaking change for direct engine RPC consumers** (none exist
outside opensquid). The engine ships matching changes; both packages
ship in lockstep.

**Migration:** `~/.opensquid/phase_ledger/mcp-*` subdirectories from
before the fix become orphaned. They aren't read by the new code and
can be deleted with `rm -rf ~/.opensquid/phase_ledger/mcp-*` (the
new layout writes directly under `phase_ledger/<task_id>/`).

**Tests:** 12 workflow-gate tests + 9 engine RPC tests updated. One
test (`task_get_ledger_isolates_sessions`) deleted — sessions no
longer isolate by design. Full opensquid suite 572/572, engine suite
587/587.

### Added — 2026-05-17 (0.7.10 — resumed-session detection + auto-reanchor prompt #164)

Fourth of five fixes from the resume-drift investigation (#160). When a Claude Code session resumes after a long gap (process restart, `claude --resume`, user came back from lunch), the agent doesn't auto-load memory/rules — that only happens on first session start. Result: resumed sessions silently inherit yesterday's state without re-anchoring.

**Fix:** UserPromptSubmit hook now tracks a per-session `ups-last-at.txt` marker. On each firing, computes the gap since the last UPS. If >5 minutes, treats this as a resumed session and injects a re-anchor prompt at the top of the next turn: "🦑 Session resumed (Xm since last activity). Before continuing, re-anchor: call `recall` for the active task, scan recent assistant turns for any unfulfilled commitments, re-read any locked rule the next action would touch."

**First firing of a session:** writes the marker but doesn't inject (no resume has happened yet).

**Tests:** 8 new in `src/hooks/user-prompt-submit.test.ts` (first-firing-null, gap<5min null, gap>=5min injects, multi-hour gap shows correct minutes, marker updates each firing, exactly-boundary case, corrupt marker tolerated, per-session isolation). Full suite 573/573.

Combined with 0.7.7 (heartbeat), 0.7.8 (turn-ledger), 0.7.9 (active-task staleness), the resume-drift cluster from #160 is 4-of-5 addressed. FIX-E (verify session-id stability across resume) is research-only and remains queued.

Per PATCH-ONLY pre-1.0 rule: src change → patch bump. 0.7.9 → 0.7.10.

### Fixed — 2026-05-17 (0.7.9 — readActiveTaskId demotes stale in_progress tasks #163)

Third of three load-bearing fixes from the resume-drift investigation (#160). Workflow-gate's "what task am I working on?" picks the most-recently-touched `in_progress` task by transcript line index. But if I marked task X `in_progress` yesterday and forgot to mark it completed, X stays the "active task" today even when I'm working on Y. Result: gate enforces against X's phase ledger when it should enforce against Y's (or nothing).

**The fix:** track `lastTouchedAt` (epoch ms from the transcript event's `timestamp` field) alongside `lastTouchedIdx`. After picking the best in_progress task, compare its timestamp to the latest transcript activity. If the gap exceeds 1 hour, return null instead — workflow-gate fails open (no enforcement) rather than enforcing against the wrong task.

**Backward compat:** when events lack timestamps, the function falls back to its original line-idx behavior. Existing tests still pass without modification.

**Tests:** 4 new (stale-only → null, recent kept, mixed stale+recent picks recent, no-timestamps falls back to original). Full suite 565/565.

Combined with 0.7.7 (heartbeat estimator) and 0.7.8 (turn-ledger per-turn reset), the three load-bearing resume-drift causes from #160 are now all addressed. FIX-D (auto-rule-reload on resume) and FIX-E (MCP session-id verification) remain queued.

Per PATCH-ONLY pre-1.0 rule: src change → patch bump. 0.7.8 → 0.7.9.

### Fixed — 2026-05-17 (0.7.8 — turn-ledger resets per-turn at Stop, not per-session #162)

Companion to 0.7.7's heartbeat fix; addresses the second of the two load-bearing causes from the resume-drift investigation (#160).

**The bug:** honesty-ledger reconciled assistant claims in the LATEST turn against tool calls from the ENTIRE session's `turn-ledger.jsonl`. The ledger only cleared at `SessionEnd`. On long resumed sessions, a `git push` from yesterday satisfied today's "I'll push" claim — false-negative on broken-promise detection. The ledger silently grew unbounded and dragged claim-reconciliation precision with it.

**The fix:** Stop hook now calls `clearTurnLedger(sessionId)` after reconciliation completes. Each turn's claims reconcile against ONLY that turn's tool calls. `SessionEnd` clear stays as the cleanup path for when the session actually ends (it's a no-op at that point if Stop ran).

**No new tests:** `clearTurnLedger` is already unit-tested in honesty-ledger.test.ts; the wiring change is a 2-line import + call in stop.ts. Full suite still 561/561.

Per PATCH-ONLY pre-1.0 rule: src change → patch bump. 0.7.7 → 0.7.8.

### Fixed — 2026-05-17 (0.7.7 — heartbeat estimator counts conversation only, not whole-file char/4 #161)

Resume-drift investigation (#160) identified that long sessions were getting heartbeat reminders against inflated token counts — `char_count / 4` of the WHOLE transcript JSONL file, which includes tool_result bodies, base64 images, JSON envelope overhead, thinking blocks, system frames, etc. On this very session's 125 MB transcript the old estimator reported 31 million tokens; the new one reports 1.5 million — **20.5x deflation**, matching what actually represents context-window pressure.

**Counts:** user `string`/`text` content + assistant `text` blocks + `tool_result` content (capped at 2000 chars per result so big file-reads don't dominate).

**Skips:** `thinking` blocks (agent internal CoT), `tool_use` args (compact + outbound), `attachment`/`system`/`file-history-snapshot`/`permission-mode`/`ai-title`/`last-prompt` frames (not conversation).

**Stale-checkpoint reset (audit MED #3):** when an existing checkpoint shows >10x the current estimator's value, it's an artifact of the old whole-file estimator — reset baseline to 0 so the next crossing fires cleanly instead of being permanently stuck under a wildly inflated baseline.

**Tests:** 10 new (8 for the new estimator: string/text/thinking-skipped/tool_use-skipped/tool_result-capped/nested-tool_result/non-conversation-skipped/malformed-JSON-tolerated; 2 for the stale-reset path). Existing 4 checkAndMaybeArm tests updated to write valid JSONL envelopes. Full suite: 561/561.

**Real-world verification:** ran the new estimator against this session's 125 MB transcript live during the cycle — 1,523,123 tokens vs old 31,186,763. Heartbeat will now fire when conversation pressure ACTUALLY crosses 20k, not when noise crosses it.

Per PATCH-ONLY pre-1.0 rule: src change → patch bump. 0.7.6 → 0.7.7.

### Changed — 2026-05-17 (0.7.6 — drift-fix track: workflow-gate now enforces 6/7 phases + 3 new honesty-ledger claims #150)

Addresses the largest drift-source share (60%) from yesterday's session retro: agent classification errors. Two changes go together:

**workflow-gate.ts — REQUIRED_PHASES expanded** from `["audit", "post_research"]` to `["pre_research", "learn", "code", "test", "audit", "post_research"]`. `fix` stays soft (skip-with-reason allowed; audit often finds nothing actionable). This matches the bundled-default codex's standard-7-phase workflow exactly, so drift-as-codex chunk 2/3 cutover becomes a clean deletion of the hardcoded array.

**Why this matters:** yesterday's #132 (storage root docs) shipped with only 2 of 7 phases logged because the gate only required those 2. Pre-research, learn, code, and test were silently skipped. The expanded gate would have blocked that commit and demanded the missing phases be logged first.

**honesty-ledger.ts — 3 new claim patterns:**

1. **`version-slot-assignment`** — catches assistant text like "v0.8", "v0.9", "v1.0", "next minor", "bumping to minor", "ships as v0.X.Y" without an AskUserQuestion / TaskCreate / TaskUpdate tool call providing evidence of user authorization. Direct response to yesterday's 6+ unauthorized slot allocations that drove the user to escalate the versioning rule to v4 (PATCH-ONLY).
2. **`phase-claim-forward`** — catches forward-tense phase announcements (`Phase 3/7 — code:`, `now in phase audit`, `starting test`) without a `mcp__opensquid__log_phase` call in the same turn. Today's `phase-logged` pattern only catches past-tense; this catches the announcement-before-the-work gap.
3. **`session-no-task`** — catches substantive-work verbiage ("executing", "now I'll", "let me build") without TaskCreate / TaskUpdate / TaskGet evidence. Catches the Telegram bootstrap shape from yesterday where ~20 substantive Bash/curl/edit calls ran with no active task ID, making the workflow-gate unenforceable.

**Operational (no code) — backfilled #132's 5 missing phases** via `log_phase` calls with `note: BACKFILLED 2026-05-17`. The phase ledger for #132 now shows all 7 phases honestly, with the backfill provenance explicit.

**Tests:** 15 new (13 honesty-ledger covering each new pattern's fire + clear paths + the 2-pattern-overlap negative-test for catalog sanity; 2 workflow-gate covering the new BLOCKS-on-missing-pre_research case + the all-6-required ALLOW case). 36 existing workflow-gate test cases updated to match the 6-phase expansion. Full suite: 551/551.

**Backward compatibility:** OPENSQUID_SKIP_WORKFLOW_GATE=1 emergency bypass still works. The bundled-default codex from 0.7.3 (#146) was already designed against this shape, so its workflow definition needs no edits.

**Drift-as-codex sequencing:** these rules are hardcoded in TS today because the loader (chunk 2) doesn't exist yet. When chunk 2 lands, this commit's patterns port to YAML and the hardcoded copies disappear in chunk 3 (cutover).

Per PATCH-ONLY pre-1.0 rule: src change → patch bump. 0.7.5 → 0.7.6.

### Added — 2026-05-16 (0.7.5 — telegram/discord/slack bot_token from .env or env var #148)

**Bot tokens can now live in `.env` files or env vars** instead of being inlined in `~/.opensquid/config.json`. The motivation: the user wanted opensquid to run a DIFFERENT Telegram bot than Claude Code's `plugin:telegram` MCP (which holds its own bot's long-poll). Storing the new bot's token in `~/.loop/.env` lets opensquid pick a different bot at startup without any config.json edit — no more 409 collision because they're different bots, not the same one being fought over.

**Priority order (highest first):**

1. `process.env.OPENSQUID_TELEGRAM_BOT_TOKEN` (or `_DISCORD_`, `_SLACK_BOT_`, `_SLACK_APP_`)
2. `.env` file in search order: `$OPENSQUID_ENV_FILE` → `~/.loop/.env` → `~/.opensquid/.env` → `<cwd>/.env` (first match wins)
3. `~/.opensquid/config.json` `chat_connections.<platform>.bot_token` (legacy fallback)

**`.env` parser** supports:

- Standard `KEY=VALUE` lines
- Single + double-quoted values
- `#` comments + blank lines
- **Bare-token fallback**: a single non-comment line that matches the Telegram bot-token shape (`<digits>:<base64-ish>`) is treated as `OPENSQUID_TELEGRAM_BOT_TOKEN`. Covers the "I just saved the raw token" case without forcing reformatting.

**Operator observability:** chat-daemon logs which source each platform's token came from at startup:

```
[chat-daemon] token sources: telegram=env-file (env-file: /Users/slee/.loop/.env)
```

Token VALUE is never logged. Just the source. So you can debug "which bot is this daemon actually using" without leaking the secret.

**Tests:** 15 new in `src/chat/env-token.test.ts`: parsing (KEY=VALUE, quotes, comments, bare-token fallback, bare-token rejected when KEY=VALUE present), `locateEnvFile` search order, all 5 priority cases (env > file > config-json > missing, env-wins-over-file, file-wins-over-config). Fixed 2 autospawn tests that broke from picking up the real `~/.loop/.env` — same HOME-override isolation pattern. Full suite 536/536.

Per PATCH-ONLY pre-1.0 rule: src change → patch bump. 0.7.4 → 0.7.5.

### Fixed — 2026-05-16 (0.7.4 — telegram daemon 409 outbound-only fallback #147)

**Telegram chat-daemon no longer dies on a 409 Conflict with external pollers.** When the daemon's long-poll loses to another consumer (typically Claude Code's `plugin:telegram` bun bot), the adapter now degrades to OUTBOUND-ONLY mode instead of nulling the bot reference. `sendMessage` keeps working via HTTPS API; only inbound is yielded. A periodic 60-second retry attempts to reclaim the long-poll, so if the competing consumer disconnects, inbound resumes transparently.

**Symptom this fixes:** earlier today the user couldn't reliably receive Telegram messages because the daemon's long-poll kept losing to the plugin's bun bot. Workaround was killing the plugin's bun process. Now the daemon gracefully shares — outbound always works, inbound reclaims when possible.

**New observability:** `chat_daemon_status` MCP tool now reports `outbound_only_platforms: [...]` so operators can see which platforms are degraded. Direct answer to the "where did my inbound message go?" debug question.

**Non-409 errors still tear down** as before (those are genuine adapter failures, not coexistence).

**Tests:** 5 new in `src/chat/adapters/telegram.test.ts`: fresh adapter starts in long-poll mode; 409 degrades to outbound-only without nulling bot; both "409" and "Conflict" substrings trigger detection; non-409 errors still tear down; retry timer scheduled on outbound-only entry. Full suite 521/521.

Per PATCH-ONLY pre-1.0 rule: src change → patch bump. 0.7.3 → 0.7.4.

### Added — 2026-05-16 (0.7.3 — drift-as-codex chunk 1: schema + bundled-default #146)

**Foundation for the drift-as-codex refactor.** Hardcoded drift gates (drift-patterns, workflow-gate, honesty-ledger, versioning-gate) will become generic loaders reading rule definitions from codex YAML. This chunk ships the schema + a bundled-default codex encoding today's rules. No loader yet (chunk 2). No removal of hardcoded TS (chunk 3, after behavioral equivalence is proven).

**New codex sections on `FocusedCodex` (all optional, additive):**

- `drifts` — port of `DriftPattern` shape. Each entry: `id`, `tool` (Bash/Edit/Write/\*), `trigger` (bash_contains/bash_regex/text_regex), `lesson`, `message`, `severity` (block/warn).
- `workflows` — new shape. Each workflow has `id`, ordered `phases` (each with `name`, `required` flag, optional `description`), and `enforce_on` list of terminal tool calls that trigger gate enforcement.
- `default_workflow_id` — codex-level pointer to the default workflow when multiple are defined.
- `claims` — port of honesty-ledger pattern shape. `id`, `claim_pattern` (regex), `evidence` (discriminated union: `tool_call` / `bash_contains` / `bash_regex` / `input_contains` / recursive `any_of`), `unfulfilled_message`, `severity`.
- `policies` — declarative rules. Two kinds in v1: `versioning` (per_commit_required, allowed_slots, slot_for) and `phase_logged` (workflow_id, enforce_on).

**Bundled-default codex** (`src/codex/bundled-default/codex.yaml`):

- 4 standard drifts: never-amend, no-implicit-push, substrate-purity, no-force-push-main
- `standard-7-phase` workflow with all 7 phases (pre_research → learn → code → test → audit → post_research → fix); `fix` marked optional
- 5 honesty-ledger claims (telegram-sent, pushed, tagged, phase-logged, fmt-clippy) — full ~12-pattern catalog ports in a later chunk
- `versioning-pre1-patch-only` policy encoding the PATCH-ONLY rule from `[[feedback_pre1_versioning]]`
- `phase-logged-7-phase` policy referencing the standard workflow

Added to npm `files` array so it ships with the published package.

**Tests:** 13 new tests in `src/codex/bundled-default/bundled-default.test.ts`: round-trip parse, focused-codex id check, presence of 4 drifts + 7-phase workflow + 5 claims + both policies, schema rejection of bad severity / empty phases / empty allowed_slots, backward compat (codex without any new sections still parses). Full suite: 516/516.

**Backward compatibility:** all four new fields are optional on `FocusedCodex` — existing codexes parse unchanged. Hooks still use hardcoded TS until chunk 2 (loader) and chunk 3 (cutover) land.

Per [[feedback_pre1_versioning]] v4 PATCH-ONLY rule: src change → patch bump. 0.7.2 → 0.7.3.

### Added — 2026-05-16 (v0.7.2 — Telegram forum-topic support #143)

**One supergroup, per-project topics, one bot.** v0.7.1 already let multiple Claude Code projects share a bot token via the chat-daemon; v0.7.2 adds the cleaner UX of having each project as a Telegram **forum topic** inside a single shared supergroup, instead of N separate channels.

**User-facing flow:**

1. User creates a supergroup → Group Info → toggle "Topics" ON
2. User adds the bot as admin with "Manage Topics" permission
3. User gives chat_id to the agent
4. Agent calls `chat_create_topic({chat_id, name})` — creates the topic via grammy `api.createForumTopic` AND auto-writes the new `message_thread_id` to the active project's `chat-routing.json` as `report_topic_id` + adds it to `inbound_topic_ids`
5. Subsequent `chat_send({channel: "project:telegram", ...})` posts into that topic; inbound messages from that topic route to this project's inbox

**New MCP tool:**

- **`chat_create_topic(chat_id, name, icon_color?, icon_custom_emoji_id?, project?)`** — creates a forum topic and (default) writes the routing automatically. `project: false` to just return the id without writing.

**chat-routing.json schema additions** (Telegram only):

- `report_topic_id` — `message_thread_id` outbound `chat_send` posts to
- `inbound_topic_ids` — when set, ONLY inbound messages with these thread_ids route here (strict; falls through to orphan if not matched). When unset, all messages from `inbound_chat_ids` route here (legacy v0.7.1 behavior preserved)

**Wire-format additions:**

- `OutboundMessage.threadId` — adapters that don't support threading ignore it
- `ChatMessage.threadId` — populated on inbound for Telegram topic messages
- `InboxMessage.thread_id` — persisted in JSONL inbox lines (v=1 schema unchanged; new field is additive)
- RPC `send` method gains `threadId` param
- New RPC method `create_topic({platform:"telegram", chat_id, name, ...})` → `{message_thread_id, name}`

**Routing index:**

`buildRoutingIndex` now emits composite keys `<platform>:<chat_id>:<thread_id>` when `inbound_topic_ids` is set, so two projects can share a supergroup but get distinct inbound routing by topic. Daemon's onMessage handler tries the topic-specific key first, falls back to chat-only.

**Telegram adapter:**

- New `createTopic(chatId, name, opts)` wraps `grammy.api.createForumTopic`
- Inbound handler reads `message_thread_id` from `ctx.message` into `ChatMessage.threadId`
- Outbound `send` passes `message_thread_id` to `grammy.api.sendMessage` when `OutboundMessage.threadId` is set

**Backward compat:** projects with no `inbound_topic_ids` continue to route by chat_id alone (legacy v0.7.1 behavior tested explicitly). `chat_send` without `project:` magic still works exactly as before. v0.7.1 users see zero behavior change until they opt into topics.

**Tests:** 3 new routing tests for topic-aware index keys (topic-specific emission, two-projects-one-supergroup distinction, legacy chat-only fallback). Full suite: 503/503.

**Permissions / errors:** bot needs "Manage Topics" admin right; failure surfaces as a clear API error on the `chat_create_topic` call. The supergroup needs Topics enabled in settings — Telegram surfaces "CHAT_FORUM_REQUIRED" if not.

Per v0.6.3 versioning-gate: src change → version bump same commit. MINOR 0.7.1 → 0.7.2 (new public MCP tool + new public schema field).

### Added — 2026-05-16 (v0.7.1 — chat-daemon RELEASE — Phase E of v0.7.1 #142)

**v0.7.1 chat-daemon shipped end-to-end.** Multiple Claude Code projects can now share one bot token without the "last-connected wins" Telegram bug. The per-machine daemon owns the long-poll; per-project `chat-routing.json` declares each project's outbound channel + inbound chat allowlist; agent-side MCP tools route through the daemon transparently.

**New MCP tools:**

- **`chat_set_project_channel(platform, report_channel?, inbound_chat_ids?)`** — write the active project's chat-routing.json. Detects the project via the existing `.opensquid/project.json` card (or `OPENSQUID_PROJECT_UUID` env var). Patches in place: omitted fields preserve existing values.
- **`chat_poll_inbox(platform?, limit?, since?)`** — read recent inbound messages from the active project's inbox JSONL. Default limit 20; `since` filters strict-greater-than on `enqueued_at`. Skips malformed lines safely.
- **`chat_daemon_status()`** — report whether the daemon is running, its pid + version + active platforms + uptime. Hits the daemon RPC for live data; falls back to pidfile-only when RPC is unavailable.

**`chat_send` magic value:**

- `channel: "project:<platform>"` auto-resolves to the active project's report_channel
- Lets agents say "send my report to my chat" without knowing the chat_id literally
- Falls back to error if no card exists or no report_channel configured for that platform

**Phase rollup** (every Phase A-D commit was independently shippable; Phase E is the user-facing surface + release):

- **Phase A** (v0.6.8 #138) — `opensquid chat-daemon {start|stop|status|restart}` lifecycle + PID file + fork-detach + stdin-resume gotcha fix
- **Phase B** (v0.6.9 #139) — JSON-RPC 2.0 outbound socket; `chat_send` daemon-first with in-process fallback; cross-platform socket address (Unix sockets / Windows named pipes)
- **Phase C** (v0.6.10 #140) — per-project chat-routing.json schema, chat_id → uuid lookup, JSONL inbox writer with project + orphan paths, 30s routing polling reload
- **Phase D** (v0.6.11 #141) — MCP-side auto-spawn via atomic fs.open(lock,'wx'), stale-lock cleanup, fire-and-forget on MCP boot so stdio never waits
- **Phase E** (v0.7.1 #142, this commit) — MCP tools, README architecture section, ROADMAP update, version bump to 0.7.1

**Docs:**

- README new "Chat-daemon — multi-project Telegram / Discord / Slack" section with architecture diagram, lifecycle table, per-project routing example, full MCP tool surface
- ROADMAP updated to mark v0.7.1 shipped
- This CHANGELOG entry rolls up the full release

**Tests:** 7 new inbox-read tests (single platform / all platforms / restricted platform / limit / since / malformed-line resilience / empty-inbox); existing 49 daemon tests still pass. Full opensquid suite: **500/500**.

**Compatibility:** v0.7.1 is fully backward compatible with v0.7.x — single-project users without the daemon get identical behavior via the in-process fallback path. The daemon only spawns when `chat_connections` is configured.

**Version bump** 0.6.11 → 0.7.1 (minor — new public MCP tools + new user-visible architecture, but no removed surface).

### Added — 2026-05-16 (v0.6.11 — daemon auto-spawn from MCP server, Phase D of v0.7.1 #141)

**MCP server now opportunistically ensures the chat-daemon is running** so users never have to remember `opensquid chat-daemon start`. Fire-and-forget on every MCP server boot — non-blocking, errors land in stderr.

**Decision tree (`ensureDaemonRunning`):**

1. `no_config` — no `chat_connections` in `~/.opensquid/config.json` → skip
2. `already_running` — `status()` reports the daemon up → done (every steady-state startup hits this)
3. Try to acquire `~/.opensquid/chat-daemon.spawn.lock` atomically via `fs.open(path, 'wx')`:
   - **Lock acquired:** re-check status (race window) → call `startDaemon` → release lock in finally
   - **Lock NOT acquired:** another MCP server is mid-spawn → poll `status()` for up to 8s for the peer's pidfile → `waited_for_peer`
4. Stale lock cleanup: lockfile older than 15s is unlinked + retried (covers the case where a previous spawner crashed mid-init)
5. Errors: surface as `status: 'error'`, MCP server boot continues regardless

**Cross-platform note:** atomic O_CREAT|O_EXCL via Node's 'wx' flag works on POSIX AND Windows. Signal-driven shutdown is still Unix-only; Windows users may need to manually `opensquid chat-daemon stop` if the daemon ever needs killing.

**Tests:** 5 new autospawn tests covering no_config decision branch, lock release after attempt regardless of spawn outcome, stale-lock cleanup, no-throw on corrupt config (degrades to no_config), already_running detection against a peer-spawned daemon. Full suite: 493/493.

Per v0.6.3 versioning-gate: src change → version bump same commit. PATCH 0.6.10 → 0.6.11.

### Added — 2026-05-16 (v0.6.10 — per-project chat-routing + inbound inboxes, Phase C of v0.7.1 #140)

**Per-project chat-routing.json schema** lets each project declare its own outbound report channel + inbound channel/chat allowlist on a single bot token. The daemon reads all routing files on boot, builds a `<platform>:<chat_id>` → `project_uuid` index, and on each inbound message looks the source channel up and appends to the matching project's JSONL inbox. No match → orphan inbox catch-all.

**Schema** (`~/.opensquid/projects/<uuid>/chat-routing.json`):

```jsonc
{
  "telegram": {
    "report_channel": "telegram:-1001234567890",
    "inbound_chat_ids": ["-1001234567890"],
  },
  "discord": { "report_channel": "...", "inbound_channel_ids": ["..."] },
  "slack": { "report_channel": "...", "inbound_channel_ids": ["..."] },
}
```

UUID is the stable primary key because the project's human-friendly `id` can be renamed without rewriting routing files.

**Inbox format** (`~/.opensquid/projects/<uuid>/inbox/<platform>.jsonl`):

- One JSON line per inbound message (NDJSON)
- Schema `v: 1` for future evolution
- Carries: id, platform, channel, sender + sender_id, text, received_at, enqueued_at, mentions_bot
- Atomic appends via POSIX O_APPEND (small writes are atomic; lines are typically <1KB)
- Orphan inbox at `~/.opensquid/inbox/orphan/<platform>.jsonl` for messages from allowed-but-unrouted channels

**Lifecycle:**

- Routing is loaded on daemon start
- 30-second polling loop rebuilds the index — operators can edit routing files and the daemon picks it up without `chat-daemon restart`
- Collision warn: if two projects claim the same inbound chat_id, the daemon logs a warning and the later one wins (Map insertion order)
- `saveProjectChatRouting` writes via tmp + rename so partial writes never leave corrupt files

**Tests:** 20 new tests across routing.test.ts (path derivation, load null/valid/malformed, collectInboundChannels per platform, buildRoutingIndex correctness + collision warn, saveProjectChatRouting overwrite) and inbox.test.ts (project + orphan paths, JSONL line format, mentions_bot/sender_id preservation, multi-line text framing safety). Daemon module total: 42 tests, 1.85s. Full suite: 488/488.

Per v0.6.3 versioning-gate: src change → version bump same commit. PATCH 0.6.9 → 0.6.10.

### Added — 2026-05-16 (v0.6.9 — chat-daemon outbound RPC, Phase B of v0.7.1 #139)

**MCP `chat_send` now routes through the chat-daemon when one is running**, falling back transparently to the in-process gateway when not. This is the load-bearing fix for the v0.7 "last-connected wins" Telegram bug: multiple Claude Code projects can share a bot token because they all hand the actual `bot.api.sendMessage` call off to the single per-machine daemon (which owns the only long-poll connection per token).

**Wire protocol:**

- JSON-RPC 2.0 over newline-delimited JSON
- Methods: `ping` (liveness + version), `list_channels` (active platforms + uptime), `send` (channel, text, replyTo?)
- Standard JSON-RPC error codes (-32700 / -32600 / -32601 / -32602 / -32603)
- Per-request connection (no pooling) — keeps the implementation under 100 LOC; fine for the expected traffic profile

**Cross-platform socket address (`daemonSockAddress`):**

- macOS / Linux → `~/.opensquid/chat-daemon.sock` (Unix domain socket)
- Windows → `\\.\pipe\opensquid-chat-daemon-<root-basename>` (named pipe)
- Node's `net.createServer({path})` and `net.connect({path})` accept both shapes — no platform branching at the call site, just at the address derivation

**MCP integration:**

- `chat_send` tries `DaemonClient.send()` first
- On `DaemonUnreachableError` (ENOENT / ECONNREFUSED / EACCES) falls back to the in-process gateway with no visible behavior change
- Response includes `via: "daemon" | "in_process"` so the operator can diagnose which path served the call
- Backward compatible: single-project users without the daemon get identical v0.6.x behavior

**Tests:** 10 new RPC integration tests against real sockets (no transport mocks): daemonSockAddress shape per OS, ping/list_channels/send happy paths, INVALID_PARAMS + METHOD_NOT_FOUND error codes, 3-way concurrent pipelining, DaemonUnreachableError on no-listener + post-close paths, DaemonRpcError surfaces message + code. End-to-end smoke verified: real daemon + real DaemonClient roundtrip cleanly with platform=telegram active. Full suite: 466/466.

Per v0.6.3 versioning-gate: src change → version bump same commit. PATCH 0.6.8 → 0.6.9.

### Added — 2026-05-16 (v0.6.8 — chat-daemon binary skeleton, Phase A of v0.7.1 #138)

**New `opensquid chat-daemon {start|stop|status|restart}` subcommand.** First step toward fixing the v0.7 "last-connected wins" Telegram bug: a per-machine daemon will own the single long-poll connection so multiple Claude Code projects can run their own opensquid MCP servers without colliding on the bot token. This commit ships only the lifecycle layer (process management); outbound RPC is Phase B, per-project routing is Phase C, MCP auto-spawn is Phase D, full release is Phase E.

**Lifecycle primitives:**

- PID file at `~/.opensquid/chat-daemon.pid`, log file at `~/.opensquid/chat-daemon.log`
- `start` spawns a detached child via `child_process.spawn(..., {detached: true, stdio: ['ignore', logFd, logFd]})` + `child.unref()` — standard Node fork-detach
- Worker writes its own pidfile on boot, installs SIGTERM/SIGINT handlers, parks on a `setInterval(()=>{}, 1<<30)` no-op timer (NOT `process.stdin.resume()` — that doesn't work when stdio[0] is 'ignore')
- `status` reads the pidfile and checks `process.kill(pid, 0)` for liveness; reports `stale_pid` when the pidfile points at a dead process
- `stop` sends SIGTERM, waits a grace period, falls back to SIGKILL; cleans up pidfile
- Idempotent: `start` against a running daemon returns `already_running:true` without spawning a second process; `stop` against a not-running daemon returns `stopped:false` without error
- Pidfile cleanup: graceful path via the worker's shutdown handler; SIGKILL fallback in the parent's stop()
- Stale pidfile handling: `startDaemon` clears stale pidfiles before spawning so a crashed previous daemon doesn't block startup

**Cross-platform note:** signals (SIGTERM/SIGINT) work on macOS/Linux. Windows process model lacks proper signals — `process.kill` on Windows is a forceful terminate. Phase D's auto-spawn + socket layer will use Node's path-based net API (Unix sockets on macOS/Linux, named pipes `\\.\pipe\opensquid-chat-daemon` on Windows) for cross-platform coverage.

**Internal worker entrypoint:** `opensquid chat-daemon-worker` is the long-running process spawned by `start` — never invoke it manually. It's wired into argv routing in src/index.ts but documented as internal.

**Tests:** 10 new lifecycle tests against real detached child processes (status-not-running x3, stop-idempotency x2, end-to-end start/status/stop x4, plus daemonPaths derivation). Full suite: 456/456.

Per v0.6.3 versioning-gate: src change → version bump same commit. PATCH 0.6.7 → 0.6.8.

### Fixed — 2026-05-16 (v0.6.7 — drift-patterns inline-prefix bypass #137 follow-up)

**v0.6.6's bypass didn't actually work because env vars set inline (`OPENSQUID_SKIP_DRIFT=1 git push ...`) don't propagate to the hook process.** The hook is a sibling subprocess spawned by Claude Code, not a child of the would-be Bash subprocess, so it reads its own `process.env` (which doesn't see the prefix). Discovered immediately on the v0.6.6 push — bypass set inline, hook still fired.

**Fix:** `decide()` now also accepts the original `ToolCallInput` and inspects the command string for an inline `OPENSQUID_SKIP_DRIFT=1` prefix (regex: `(^|\\s|;|&&)\\s*OPENSQUID_SKIP_DRIFT=1(\\s|$)`). Either the parent process env OR the command-string prefix triggers the bypass; both paths produce the same audit-trail stderr line. Defensive: substring match (e.g. `MY_OPENSQUID_SKIP_DRIFT=1`) is rejected by the word-boundary anchor.

**Tests:** 3 new bypass paths (inline prefix in plain command, inline prefix after `cd ... &&`, substring rejection) + value-strictness for inline (`OPENSQUID_SKIP_DRIFT=true` still blocks). Full suite: 446/446.

Per v0.6.3 versioning-gate: src change → version bump same commit. PATCH 0.6.6 → 0.6.7.

### Added — 2026-05-16 (v0.6.6 — drift-patterns emergency bypass #137)

**`OPENSQUID_SKIP_DRIFT=1` now downgrades every drift block to an audit-trail warning.** Mirrors the existing `OPENSQUID_SKIP_VERSION_GATE` and `OPENSQUID_SKIP_WORKFLOW_GATE` env vars so operators have one consistent "this hook is wrong, get out of my way" mental model across all three gates.

**Why:** the documented "uninstall hooks → push → reinstall" workaround for the `no-implicit-push` block doesn't actually work mid-session — Claude Code caches the settings.json hook command at session start, so editing it mid-session has no effect. The bypass env var is the only path that works without a session restart. Discovered while pushing the #132 storage-root docs commits.

**Behavior:**

- Env unset → drift hits behave as before (blocks exit 2, warns exit 0)
- `OPENSQUID_SKIP_DRIFT=1` → all hits collapsed to single stderr line listing the bypassed pattern ids, exit 0
- `OPENSQUID_SKIP_DRIFT=true` / any other value → no bypass (matches the strict `==="1"` parsing of the other two gates)

**Tests:** 4 new bypass tests (bypass downgrades to exit 0 / includes all hit ids in audit trail / strict `===\"1\"` parsing / empty-hits stays silent). Full suite: 442/442.

Per v0.6.3 versioning-gate: src change → version bump same commit. PATCH 0.6.5 → 0.6.6.

### Fixed — 2026-05-16 (v0.6.5 — drift-block HEREDOC false-positive #136)

**Drift-block hook false-fired against my own commit during v0.6.4 dogfood.** The `no-implicit-push` rule's regex matched against the entire bash command string, including HEREDOC commit message bodies. When the v0.6.4 commit message described regex patterns containing the literal upload-verb string, the drift-block fired against itself.

**Fix:** new `stripHeredocBodies` helper runs before `stripQuotedStrings` so HEREDOC bodies (`<<DELIM ... DELIM` and variants) are removed before any drift regex sees them. Recognizes: unquoted (`<<EOF`), single-quoted (`<<'EOF'`), double-quoted (`<<"EOF"`), tab-stripping (`<<-EOF`), and combined variants. Fail-open on truncated HEREDOCs.

**Tests:** 9 new drift-patterns tests (5 stripHeredocBodies variants + 3 false-positive resistance scenarios + 1 regression assertion against the exact v0.6.4 commit shape that bit me). Full drift-patterns suite: 29/29. Full opensquid suite: 438/438.

Per v0.6.3 versioning-gate: src change → version bump same commit. PATCH 0.6.4 → 0.6.5.

### Added — 2026-05-16 (v0.6.4 — claim catalog expansion #135)

**Honesty-ledger expanded with 5 new claim patterns + 2 evidence kinds.** Third item in the drift-fix track after #131 (workflow-gate active-task detection) + #134 (versioning gate). Each new pattern targets a specific "said it / didn't do it" drift shape observed in today's session.

**New patterns:**

- `telegram-sent` — claim of "Telegram report sent / sent to Telegram / pinged you" must be satisfied by either `mcp__plugin_telegram_telegram__reply` OR `mcp__opensquid__chat_send` (whichever path is wired). Caught today's silent skip when the plugin MCP disconnected.
- `pushed` — claim of "pushed to origin / pushing the engine / pushed it / pushed the branch / pushed the PR / pushed the changes" must be satisfied by `git push` Bash call.
- `tagged` — claim of "tagged v0.5.0 / created the tag v0.5.0 / new tag v0.5.0" must be satisfied by `git tag` Bash call. Requires a version-shaped token nearby to avoid false-positives on prose like "tagged for review."
- `phase-logged` — claim of "logged audit phase / phases logged / log_phase" must be satisfied by `mcp__opensquid__log_phase` MCP tool call. Tightened to require "phase" keyword or literal `log_phase` to avoid false-positives on debug prose like "logged audit results."
- `fmt-clippy` — claim of "fmt clean / clippy passes / prettier clean" must be satisfied by cargo fmt / cargo clippy / prettier / npm run format Bash call.

**New evidence kinds:**

- `any_of` — composable evidence. Satisfied when ANY listed option matches. Lets multi-tool claims (Telegram via plugin OR via opensquid) resolve correctly.
- `input_contains` — substring match against a non-Bash tool's input_summary. Reserved for future patterns like "bumped Cargo.toml" (Edit tool + needle "Cargo.toml").

**Audit-driven tightening (caught pre-commit):**

- MED — `tagged` regex fired on prose like "tagged for review" / "tagged as P0." Now requires `tagged\s+v?\d+\.\d+` shape.
- MED — `phase-logged` fired on "logged audit results" / "logging test results." Now requires "phase" keyword or literal `log_phase`. False-negative cost acceptable since workflow-gate is the primary defense.
- LOW — `pushed` missed common phrasings ("pushed it", "pushed the branch"). Expanded alternation.

**Coverage:** 49 honesty-ledger tests (22 existing + 27 new across the 5 patterns + audit-tightening assertions). Full suite: 429/429.

### Added — 2026-05-16 (v0.6.3 — versioning-discipline gate)

**Per-commit version bump enforcement (#134).** New `versioning-gate` PreToolUse hook intercepts `git commit` calls and blocks them when source code is staged without a Cargo.toml / package.json version bump in the same commit. Structural fix for the "batching multiple fixes into one minor bump" pattern (`mem-d2cc0e78`).

Logic:

1. `git diff --cached --name-only` → list staged files
2. No `src/**` files staged → allow (docs/CI/config commits don't need bumps)
3. `src/**` staged → require a manifest (Cargo.toml or package.json) to also be staged WITH a `version` line diff
4. Otherwise block with actionable stderr listing the offending files

**Fail-open invariant** + emergency env override (`OPENSQUID_SKIP_VERSION_GATE=1` with loud BYPASS warning) — mirrors the v0.6.1 workflow-gate shape.

Composition: two gates now run sequentially on `git commit` — workflow-gate (audit + post_research must be logged) then versioning-gate (version bump must be in this commit). First gate to block exits non-zero.

**Audit-driven fix (caught pre-commit):**

- HIGH — original `^"version"` anchor on the package.json regex false-blocked legitimate bumps in MINIFIED package.json. Dropped the anchor on the package.json branch; kept Cargo's anchor since TOML is line-oriented.

**Coverage:** 19 versioning-gate tests against REAL tmp git repos (same lesson as v0.6.2's real-fixture pattern — don't synthesize, exercise the actual surface). Cases include docs-only allow, Cargo bump allow, both pretty + minified package.json allow, src-only block, manifest-without-version-line block, workspace any-bump policy, override bypass, fail-open on non-repo cwd. Full suite: 402/402 passing.

### Fixed — 2026-05-16 (v0.6.2 — workflow gate active-task detection)

**The v0.6.1 workflow gate silently allowed every commit (#131).** The hook called `readActiveTaskId(transcriptPath)` which only recognized `TodoWrite` tool_use blocks. Claude Code's harness `TaskCreate` / `TaskUpdate` tools serialize as delta events (not snapshots) with the assigned task id coming back in the matching `tool_result` text ("Task #N created successfully"). Sessions using TaskCreate/Update exclusively — including my own dogfood session — silently returned null → no active task → fail-open allow → gate never fired. Five today's commits went through without check.

Caught by smoke-testing the v0.6.1 release against the actual hook flow.

**Fix:** extended `readActiveTaskId` to recognize all three shapes via single forward pass. State map `{task_id → {status, lastTouchedIdx}}`, chronology IS the sort key (latest write per id wins naturally, no special-case ordering).

- TodoWrite (snapshot) → each todo's status written at the snapshot's line index
- TaskUpdate (delta) → taskId → status at line index
- TaskCreate (delta) → tool_use_id lookup in pre-indexed `toolResultText` map → extract id from `"Task #N created"` via loose regex `/Task\s+#?[\w-]+/i` (survives future wording drift)

**Audit caught + fixed pre-commit** (real audit cycle, not skipped this time):

- HIGH — stale docstring referenced the discarded two-pass design
- MED — fragile regex would miss future Claude Code wording variants
- MED — no real-world fixture test (the same testing gap that let v0.6.1 ship broken). Captured 3 real events from an actual Claude Code session into `src/hooks/__fixtures__/real-task-shape.jsonl`; test asserts the fix detects "1" as active.

**Coverage:** 23 transcript tests (12 TodoWrite + 5 TaskUpdate + 3 TaskCreate + 2 mixed-mode + 1 real-fixture). Full suite 383 pass.

Per the patch-vs-minor discipline (`mem-d2cc0e78`): this is **PATCH** — fix to existing v0.6.1 workflow-gate feature, no new MCP tool, no API change.

### Added — 2026-05-16 (v0.6.1 — workflow enforcement)

**Phase ledger commit gate — turn the 7-phase rule into a real block (#128)**

The 7-phase workflow (`pre_research → learn → code → test → audit → post_research → fix`) has been a top-priority promoted rule for weeks, but it lived only as text in `CLAUDE.md`. Today proved that surfacing ≠ enforcement: I drift-skipped audit + post-research on five features shipped this morning, retroactive audits surfaced 5 HIGH bugs. This release wires the rule into a PreToolUse hook backed by the engine's new phase-ledger store. Requires loop-engine 0.5.0+.

**`log_phase` MCP tool**

- New tool surface: `{task_id, phase, note?, session_id?}` → records the phase entry in the engine ledger. Idempotent (re-logging returns `newly_recorded: false`). Agent calls this as each phase completes.
- `session_id` defaults to `mcp-<pid>-<ts>` if the caller omits it.

**`workflow-gate` PreToolUse hook extension** (`src/hooks/workflow-gate.ts`)

- Wired into the existing PreToolUse hook (no new event registration). Fires ONLY when the planned tool is `Bash` and the command matches `git\s+commit\b` (excluding `--amend` which has its own gate). Avoids paying the engine-spawn cost on every Bash call.
- Active-task detection via `readActiveTaskId` (transcript JSONL walker → most-recent `TodoWrite` `in_progress` item). Fall-through to allow when no active task — supports ad-hoc commits outside any task flow.
- Required phases: `audit` + `post_research` (per user direction — the two empirically skipped phases that target today's failure mode). Pre-research / learn / code / test / fix are not gated.
- **Fail-open invariant**: any error reaching the engine, parsing the transcript, or detecting the active task → allow with a stderr warning. The gate is best-effort drift protection, not a hard safety wall.
- Emergency override: `OPENSQUID_SKIP_WORKFLOW_GATE=1` bypasses with a loud stderr warning. For genuine emergencies only.

**Engine-client bridge methods**

- `OpenSquidEngine.logPhase` → `task.log_phase` RPC
- `OpenSquidEngine.getTaskLedger` → `task.get_ledger` RPC

**Tests**

- 12 workflow-gate tests (fail-open inputs, active-task drives decision, fail-open on engine error, emergency override).
- 12 transcript-active-task tests (no transcript, no TodoWrite, no in_progress, single TodoWrite, MOST RECENT wins, stale fallback prevention, mixed events, numeric ids, malformed JSON).
- Full suite: 372/372 passing.

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
- Lazy-init pattern in `src/index.ts`: chat gateway opens on first chat\_\* tool call, cached for the rest of the MCP session. Non-chat sessions pay zero cost.
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
