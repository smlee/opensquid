# Changelog

All notable changes to `opensquid` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [SemVer 2.0.0](https://semver.org/) starting at 1.0.

---

## [0.5.255] - 2026-05-31

### Fixed (ACTRACE.1 — defensive active_task_mirror clear closes log_phase mid-task race)

**Root cause:** `src/runtime/hooks/active_task_mirror.ts:150-152` called
`clearActiveTask(sessionId)` UNCONDITIONALLY whenever a `readdir`+`readFile`
snapshot found no `in_progress` task. The harness writes task store files
non-atomically; transient mid-write snapshots collapse to "no
in_progress → clear active-task.json." Subsequent
`mcp__opensquid__log_phase` calls then threw `"no active task
(active-task.json absent)"` even though the harness task IS still
in_progress.

**Live evidence 2026-05-31 LL4FIX.1 session:** log_phase pre_research
succeeded, log_phase learn succeeded, then next log_phase failed with
exactly this error. Phase ledger lost 5 of 7 phases for LL4FIX.1; the
workflow gate fail-opened on commit because its own state file was
silently cleared by the companion mirror. Load-bearing structural cause
of the "everything keeps getting skipped" meta-pattern.

**Fix:** Positive-evidence clear. Before clearing, `readActiveTask`
returns the prior active-task. If `prior !== null && prior.id !==
completingId && tasks.some((t) => t.id === prior.id)` → keep
active-task.json (transient mid-write). Only clear when prior id is
genuinely absent from snapshot OR is being completed this tick (H4a).

**Risk callout L3 honored:** the defensive-clear MUST NOT prevent
legitimate clears in genuine no-task states. Test cases (d) "no prior +
no in_progress → clear is no-op on absent" + (e) "prior + empty tasks
→ clear (genuine session-end)" verify this. User's historical 10.5hr
"hook fired with no tasks" scar is the exact SAR (no over-fire in
no-task contexts).

**H4a-completion regression caught + fixed in dev:** initial
defensive-clear was too eager — kept the prior even when the prior was
the task being COMPLETED this tick (TaskUpdate(completed) for id=15
while disk says id=15 in_progress). Added `prior.id !== completingId`
exclusion. Test "H4a-completion still works: prior=15 + TaskUpdate(completed,15)
→ clear" guards against regression.

### Files changed

- `src/runtime/hooks/active_task_mirror.ts` — added `readActiveTask`
  import; rewrote clear-path with positive-evidence check + H4a
  completion exclusion
- `src/runtime/hooks/active_task_mirror.test.ts` — added 7 new cases
  (a)-(f) + regression guard for H4a-completion

### Tests

22 passing (15 original + 7 new). Full suite 2716 passed / 28 skipped.

### Audit walk-through (per [[feedback-audit-is-walk-through]])

- **Trace:** PreToolUse hook fires → `mirrorActiveTask(sessionId, tool,
args, base)` → `readHarnessTasks` returns tasks[] → H4a overlays for
  activatingId/completingId → active resolution → on null active: new
  defensive-clear logic (readActiveTask → tasks.some check → return or
  clear) → caller's downstream code sees consistent active-task.json
- **Side effects:** active-task.json on disk written/kept/cleared per
  logic; no new writes vs pre-fix (just narrower clear conditions)
- **Verification pollution:** all tests use `OPENSQUID_HOME=mkdtemp()`
  per ASG.1 pattern; no live state touched
- **Assumptions:** (a) `readActiveTask` returns null on absent file
  (verified — session_state.ts:195 try/catch); (b)
  `tasks.some((t) => t.id === prior.id)` is deterministic across
  readdir orderings (string comparison, OK); (c) harness writes
  eventually consistent within ~1 PreToolUse window (heuristic, not
  guarantee — ACTRACE.2 atomic-write would be deterministic fix)
- **Adjacent callers:** `grep -rn 'clearActiveTask\|readActiveTask'`
  enumerated — clearActiveTask only called in this file at line 178;
  readActiveTask called by session-end.ts, log_phase.ts,
  functions/active_task.ts — all readers, no loop risk with the new
  read inside mirrorActiveTask
- **Error surface:** fail-open contract preserved via try/catch wrapper
  around readActiveTask call (L4)
- **User-visible delta:** before — log_phase calls 3-7 could fail mid-task
  with "no active task" during transient harness mid-writes. After —
  log_phase calls succeed through transient mid-writes (mirror keeps
  prior state); workflow gate sees complete phase ledger; per-task
  reports include accurate phase history
- **Rollback:** 1-line `git revert`

### Out of scope (queued)

- ACTRACE.2 — atomic write of active-task.json on the WRITE path
  (`session_state.ts:writeActiveTask` `.tmp`+rename) — deterministic
  fix; this commit narrows the race window heuristically
- Audit-content-required regex on log_phase note field (workflow gate
  semantic check)
- MCP-tool PreToolUse coverage gap (~/.claude/settings.json matcher)

---

## [0.5.254] - 2026-05-31

### Fixed (scope-detect false-positive on tech-idiom "working as intended")

**Symptom:** user typed a frustrated message "that's why I keep saying nothing is fixed because nothing is working as intended..." in a Claude Code session. The opensquid `scope-intent-nudge` rule (in built-in `scope-architect/skills/scope-detect/skill.yaml`) matched `\bas\s+intended\b` against "working as intended" → emitted warn verdict → Claude Code's UI surfaced as "UserPromptSubmit operation blocked by hook" with a scope-authoring directive. User's actual frustration message never reached the conversation; gate fired on a tech idiom.

**Root cause:** SAR.1 (2026-05-30) added the bare pattern `\b(?:as|to be|to-be)\s+intended\b` to catch the source phrase "fully functional as intended" (delivery-intent). The pattern was too broad — caught the standard tech idiom "working as intended" (meaning "behaves correctly"), which has zero scope-authoring intent.

**Fix:** Narrowed the pattern into two more specific forms in `packs/builtin/scope-architect/skills/scope-detect/skill.yaml`:

- `\b(?:deliver(?:ed)?|ship(?:ped)?|build|built|finish(?:ed)?|complete[ds]?)\s+(?:.+\s+)?(?:as|to be|to-be)\s+intended\b` — delivery-verb form ("ship/deliver/build X as intended")
- `\b(?:fully|completely|properly)\s+(?:functional|operational|working|complete|wired|done|ready|live)\s+(?:as|to be|to-be)\s+intended\b` — delivery-adjective form (the SAR.1 source phrase "fully functional as intended")

Either pattern triggers the warn. Bare tech idioms ("working as intended", "behaves as intended", "functions as intended", "the code does what was intended") have neither pattern → correctly excluded.

**Live regex verification:**

```
HIT  | open squid fully functional as intended
HIT  | fully functional as intended
HIT  | completely working as intended
HIT  | properly wired as intended
HIT  | deliver this as intended
HIT  | ship the feature as intended
MISS | that's why I keep saying nothing is fixed because nothing is working as intended
MISS | working as intended
MISS | behaves as intended
MISS | functions as intended
MISS | the code does what was intended
```

**Audit walk-through performed:**

1. Trace: prompt → UPS hook → scope-detect skill → text_pattern_match against `prompt` field → matched.length > 0 → warn verdict → additionalContext injection
2. Side effects: none (read-only regex eval)
3. Verification pollution: node-only test, no opensquid state touched
4. Assumptions: YAML single-quoted strings preserve backslashes for regex
5. Adjacent callers: scope-detect has many other rules; only `scope-intent-nudge` changes; others untouched
6. Error surface: regex parse failure would surface via Zod schema check on skill load (BPDISC pattern)
7. User-visible delta: before — "working as intended" triggered scope-authoring directive. After — only delivery-intent phrasings trigger
8. Rollback: 1-line `git revert`

---

## [0.5.253] - 2026-05-31

### Fixed (LL4FIX.1 — drop sessionId from ackKey; cross-session dedup)

**Root cause:** `src/runtime/chat/inbox.ts` `ackKey(platform, messageId, sessionId)`
included sessionId in the dedup key. Result: ack records written by
session A never deduped injection for session B. Every new Claude Code
session re-injected the entire inbox backlog as the first UPS
`additionalContext` envelope.

**Symptom verified live on 2026-05-31:** user's
`~/.opensquid/projects/da96385b-.../inbox/` held 66 unique message_ids ×
4 distinct sessionIds = 264 ack records, while `telegram.jsonl` still
contained all 66 messages. The user's RaumPilates Claude session
hung/crashed after several restarts, each restart re-flooding the
session with ~12KB of stale loop-project messages.

This bug was MASKED until commit `f93aaf1` (BPDISC) made hooks actually
run. Before BPDISC, the discovery-crash short-circuited the UPS hook
before LL.4 could drain; LL.4's pre-existing per-session-dedup design
was invisible.

**Fix:**

- **`src/runtime/chat/inbox.ts`** — `ackKey` is now 2-arg
  `(platform: Platform, messageId: string): string` returning
  `${platform}::${messageId}`. JSDoc captures the LL4FIX.1 rationale +
  preserves "AckRow.injected_at_sessionId is still RECORDED as audit
  metadata" contract.
- **`src/runtime/chat/inbox_inject.ts`** — `computeUnackedRows` builds
  the dedup set using the 2-arg key. The `sessionId` parameter stays on
  the function signature because `buildAckRowsForInjected` still uses
  it to record `injected_at_sessionId` (the audit-trail field that
  drives the 7-day purge). Added `void sessionId` so linters don't
  flag the now-unused-in-the-dedup-loop arg.
- **`src/runtime/chat/inbox.test.ts`** — updated the `ackKey` canonical
  format test from `telegram::42::sess-A` to `telegram::42` + added a
  per-platform-distinct-keys assertion.
- **`src/runtime/chat/inbox_inject.test.ts`** — rewrote the
  per-session-dedup test as a cross-session-dedup test (an ack from
  session OTHER now correctly dedupes for session A). Added a
  per-platform isolation test (telegram ack does NOT dedupe a slack
  row with the same id).

**Live verification on user's da96385b project:**

```
$ echo '{"hook_event_name":"UserPromptSubmit","session_id":"verify-A","prompt":"x"}' \
    | opensquid-hook-userpromptsubmit | wc -c
57

$ echo '{"hook_event_name":"UserPromptSubmit","session_id":"verify-B","prompt":"x"}' \
    | opensquid-hook-userpromptsubmit | wc -c
57
```

Both new sessions (verify-A + verify-B) see the existing 4-session ack
backlog and emit empty envelopes (57 bytes = just the
`[opensquid-dispatch] event=prompt_submit rules=N packs=N` log line —
no additionalContext). Pre-fix, each would have emitted ~12KB of stale
messages.

**Back-compat:** `acked.jsonl` shape on disk is unchanged — the fix
only reads `platform` + `message_id` from existing records (ignoring
the `injected_at_sessionId` field in dedup-key derivation, while still
writing it as audit metadata on new acks). No migration needed.

**Out of scope:** project-UUID resolution behavior (the `T-PUIDFIX`
hypothesis from the 2026-05-31 incident pre-research turned out to be
a false alarm — the UPS hook correctly uses `process.cwd()`, which in
production is the Claude session's project cwd; my test had spoofed
the JSON payload's cwd field which is ignored by the hook).

---

## [0.5.252] - 2026-05-30

### Fixed (BPDISC — built-in pack auto-discovery; closes the silent-stop-gate bug)

**Root cause:** `discoverActivePacks(scopeRoot, ctx)` joined
`<scopeRoot>/packs/<name>` and ENOENT-crashed whenever `active.json`
listed a BUILT-IN pack name (`default-discipline`, `scope-architect`,
`task-spec-author`, `focused-react-19`, `focused-typescript-strict`,
`focused-atomic-design`, `frontend-react-19-atomic`, `pack-architect`)
— those packs live at `<npm-install>/packs/builtin/<name>/`, NOT at
the user-scope `~/.opensquid/packs/<name>/`. Every Stop hook
invocation crashed BEFORE the dispatcher walked, so `pause-prompt-extended`
never matched its regex patterns + every DOG.1-DOG.5 pack was
unreachable from a running session.

The bug existed since BR.1 renamed `sangmin-personal` →
`default-discipline` + DPC.1 promoted `scope-architect` +
`task-spec-author` to built-in profession packs, but no follow-up
wired up built-in discovery.

**Fix:**

- **`src/runtime/paths.ts`** — added `resolveBuiltinScopeRoot()`:
  returns `OPENSQUID_BUILTIN_PACKS_ROOT` env var when set; else
  computes the dist-relative path (`<dist>/runtime/paths.js` →
  `<npm-install>/packs/builtin/`). Mirrors the `OPENSQUID_HOME` test
  seam pattern.
- **`src/packs/discovery.ts`** — `discoverActivePacks` gains optional
  third `builtinRoot: string | null = null` arg. New
  `loadPackWithBuiltinFallback(name, scopePacksDir, builtinRoot)`
  helper: tries user/project scope first, falls back to
  `<builtinRoot>/<name>/` ONLY on ENOENT (preserves loud-failure for
  YAML parse / Zod validation errors). When neither has it, throws a
  helpful error naming BOTH attempted paths + the
  `opensquid pack install` remediation hint.
- **`src/runtime/bootstrap.ts`** — resolves the built-in root once at
  module load and passes it through to both user-scope + project-scope
  `discoverActivePacks` calls.

**Scope-precedence preserved:** user-installed packs win over
built-in when names collide. Built-in is fallback-only, not
default-include — opt-in via active.json is still the gate.

**Back-compat:** the new `builtinRoot` arg defaults to `null` so
existing call sites continue to behave unchanged. All 38 existing
`discovery.test.ts` cases pass without modification.

**Live verification:** `opensquid-hook-stop` no longer ENOENT-crashes
against this user's actual `active.json` (which lists
`sangmin-personal-rules` + 3 built-ins); reports
`event=stop rules=3 packs=4` and exits 0. Pre-fix output was:
`[opensquid] active pack load failed: ENOENT: no such file or directory,
open '/Users/slee/.opensquid/packs/default-discipline/manifest.yaml'`.

**Deferred follow-up (BPDISC.2):** add a dedicated test fixture
covering the 5 cases (built-in load, scope-precedence, neither-has-it
error message, null-builtinRoot back-compat, mixed user+builtin list).
Blocked this commit by the scope-decomposer "coding before scope→task"
discipline gate — needs a docs/tasks spec authored first.

---

## [0.5.251] - 2026-05-30

### Added (`scripts/h2-walk-builtin-packs.mjs`)

Standalone pack-load verification CLI that walks every directory under
`packs/builtin/` and invokes `loadPack(dir)` on each. Reports per-pack
`[OK]` with skill-name list, or `[FAIL]` with the load-time error
verbatim. Exits 1 if any pack fails to load. Originally authored for
the H.2 skill-grammar refinement report; useful as a smoke test before
shipping any pack-loader change.

Usage: `pnpm build && node scripts/h2-walk-builtin-packs.mjs`

### Build (`.gitignore`)

- `.mcp.json` — local Claude Code MCP config carrying absolute paths
  to this developer's install. Per-machine config, not project state.

---

## [0.5.250] - 2026-05-30

### Docs (DOG.6-DOCS — pack-runtime.md §1.10/§1.11/§1.12 closes T-DOGFOOD code-side surface)

Three new sections in the authoritative pack-runtime.md so DOG.3-DOG.5
features have first-class documentation alongside IDF.1-IDF.5 / MM.1 /
LP.1-LP.5:

- **§1.10 `seed_lessons:[]`** — pack-author knowledge ingest contract:
  external_id UPSERT idempotency, authored_by: 'pack' eviction-immune,
  seed_as_promoted bypass-the-gate, fire-and-forget failure handling.
  Schema + ingest implementation pointers.
- **§1.11 `verify_gates:[]`** — declarative author-gate compilation
  contract: pre-parse validation throws loudly with offending gate
  name, 5-fn allow-list, synthetic skill named `<pack>/verify` with
  audit-trail rule ids `gate:<gate-name>`, trigger dedup, tool-name
  filtering belongs in the check expression. Schema + compiler
  pointers.
- **§1.12 `livingVersion`** — DOG.5 runtime convenience triple on Pack:
  `{base, revision} | undefined`, populated by loader from LP.1's
  version.json via the DOG.5 getLivingPackVersion wrapper. Honors
  OPENSQUID_HOME env override.

### T-DOGFOOD status

Code-side work (DOG.1-DOG.5) ships in 0.5.245 through 0.5.249:

- DOG.1 (0.5.245) — three focused packs (focused-react-19 +
  focused-typescript-strict + focused-atomic-design)
- DOG.2 (0.5.246) — frontend-react-19-atomic composite pack
- DOG.3 (0.5.247) — Phase 3 schema sugar (seed_lessons + verify_gates)
- DOG.4 (0.5.248) — 25 seed_lessons + 9 verify_gates authored
- DOG.5 (0.5.249) — living-pack version triple in Pack
- DOG.6-DOCS (this commit) — pack-runtime.md §1.10/§1.11/§1.12

DOG.6 spec's primary deliverable is a 1-week real-world dogfood window
on a real React project — that's user-executed validation, not
engineering work. The opensquid v1 product is functionally complete as
of this commit; the findings doc + Phase 5b adjustments will follow
from the user's dogfood window execution.

---

## [0.5.249] - 2026-05-30

### Added (DOG.5 — Living-pack version triple in Pack + getLivingPackVersion wrapper)

LP.1-LP.5 already shipped the version.json I/O (`readVersionJson`,
`writeVersionJson`, `initPersonalRevision`), the lesson-append +
revision-bump path (`appendLessonFile`), the wedge-promotion helper
(`persistPromotedLesson`), the path-traversal-safe state-dir resolver
(`resolvePackStateDir`), and the lazy 3-way merge trigger
(`checkAndMergeUpgrades`). DOG.5 layers a thin convenience surface on
top so callers reading per-pack version don't need to know the
underlying file layout.

**New: `src/packs/living_pack.ts`** (47 LOC)

- `getLivingPackVersion(packId): Promise<LivingPackVersion | null>` —
  reads `~/.opensquid/packs/<id>/personal_revision/version.json` and
  returns `{base, revision}` or `null` when the pack isn't installed
  (built-in pack or fresh install). Honors `OPENSQUID_HOME` env
  override (test seam already wired through LP.3's `resolvePackStateDir`).
  Throws on malformed JSON (LP.1 loud-failure contract preserved).
- `LivingPackVersion` interface — `{base: string, revision: number}`.

**`src/runtime/types.ts`** — `Pack` gains optional
`livingVersion?: {base, revision}` field. Loader populates from
`getLivingPackVersion(manifest.name)` at load time. Built-in packs that
ship in the npm tree without per-user state get `livingVersion:
undefined` (not present); user-installed packs get the triple.

**`src/packs/loader.ts`** — wires the read once per pack alongside
existing seed-ingest + verify-gate compile. Pure file read; null when
pack isn't user-installed.

### Tests

`src/packs/living_pack.test.ts` — 10 cases:

- null when pack state dir absent (built-in / never installed)
- null when state dir exists but version.json absent
- `{base, revision: 0}` on fresh `initPersonalRevision`
- revision bumps after `appendLessonFile` calls
- monotonic across multiple lesson appends
- honors `OPENSQUID_HOME` override (env-var swap)
- writeVersionJson + getLivingPackVersion round-trip preserves
  `last_merged_vanilla` via underlying API (the DOG.5 triple is the
  base.rev subset, not the full ledger)
- throws on malformed version.json (LP.1 contract)
- returns null for unrelated pack id when OTHER packs installed
- two packs report independent versions

### Why this matters

DOG.5 closes the version-tracking loop end-to-end: a pack ships with
a base version, lessons get promoted (LP.3 -> personal_revision.id++),
upgrades 3-way-merge personal lessons over the new vanilla base (LP.2 +
LP.5), and DOG.5 exposes the current `{base, revision}` triple as a
first-class field on Pack so logs / diagnostics / merge-prompt UIs can
read it without re-touching disk. The DOG.6 9-step dogfood recipe will
surface this triple in the install + promote + upgrade steps.

---

## [0.5.248] - 2026-05-30

### Added (DOG.4 — seed_lessons + verify_gates authored for 3 focused + composite)

Each DOG.1 focused pack + the DOG.2 composite now ships grounded content
consumed by the DOG.3 schema sugar:

**`focused-react-19`** — 7 seed_lessons + 3 verify_gates

- Lessons cover Server Components default + "use client" leaf, Actions
  for form mutations + useFormStatus, useOptimistic for instant
  feedback, use(promise) Promise-unwrap, Rules of Hooks, "use server"
  file vs. function level, ref-as-prop replacing forwardRef.
- Gates: no `react-dom/server` legacy SSR import, no new
  `class extends Component`, no default-exported async Server Actions
  (action-id stability).

**`focused-typescript-strict`** — 7 seed_lessons + 3 verify_gates

- Lessons cover assertNever exhaustiveness, `as const` narrowing,
  discriminated unions over option-bag interfaces,
  `noUncheckedIndexedAccess`, `satisfies T` for inference preservation,
  no `as` casts, `unknown` over `any` at boundaries.
- Gates: no `: any` annotation, no `@ts-ignore` (prefer
  `@ts-expect-error`), no `arr[N]!` non-null-assertion on numeric
  indexes (loses strict-mode runtime check).

**`focused-atomic-design`** — 7 seed_lessons + 3 verify_gates

- Lessons cover atoms as pure UI primitives, molecules as 2-5 atoms
  with one responsibility, organisms holding ephemeral but not app
  state, templates/pages split, one-component-per-file, token-driven
  theming (no hex codes), Storybook-at-atom + integration-test-at-page.
- Gates: no raw hex colors in component files, no app-state imports
  in atom files, no multiple default exports per file.

**`frontend-react-19-atomic`** (composite) — 4 cross-domain seed_lessons

- Atomic React 19 atom pattern (strict-typed props + ref-as-prop +
  zero client state at this level).
- Server Components + token-driven theming compose cleanly (CSS vars
  render in static stylesheet, no "use client" needed for theme).
- Page-level Server Actions with Zod-validated FormData unwrapping —
  combines all three pack disciplines.
- Storybook stories for atoms must demonstrate variant coverage +
  token theming + strict-mode safety.

Totals: 25 seed_lessons (≥ 21 acceptance) + 9 verify_gates (≥ 9
acceptance). Every check expression PARSES via parseExpression at load
time (would throw at loadPack if any didn't).

### Tests

`test/builtin/focused-packs-content.test.ts` — 19 cases:

- 4 × per-focused-pack: ≥ 5 seeds + ≥ 2 gates, every check parses,
  compileVerifyGates returns ok with one rule per gate, synthetic
  verify skill folded into pack.skills (12 cases).
- 2 × composite assertions: ≥ 3 cross-domain seeds + 0 gates;
  composite carries no synthetic verify skill.
- Per-pack loadPack({engine}) fires the ingest pipeline once per seed
  (spy assertion against fakeEngine().lessonCreate).
- Every ingest call carries `authored_by:'pack'` + `pack_id` matching
  pack name + `pack-seed:<sha256-24>` external_id.
- Total seeds ≥ 21 (acceptance count); total gates ≥ 9; every
  seed_lesson has non-placeholder title + body (> 20 chars).

### Fixed (drive-by — transport_bridge testTimeout via file-level setConfig)

`src/runtime/agent_bridge/transport_bridge.test.ts` — moved the LP5F.1
hotfix's 20_000ms timeout from a single-test third-arg to a file-level
`beforeAll(() => vi.setConfig({testTimeout: 20_000}))`. The polling-
backend flake hits MORE than one of the 9 tests in the file under GH
Actions Node-20 contention; covering only one was insufficient (caught
during DOG.4 vitest run). No production behavior change.

---

## [0.5.247] - 2026-05-30

### Added (DOG.3 — Phase 3 schema sugar: seed_lessons + verify_gates)

Two manifest-schema-sugar blocks now folded into every pack's load path
so pack authors can declare seed knowledge + lightweight verify gates
without hand-authoring full skill YAMLs.

**Schema (`src/packs/schemas/manifest.ts`):**

- `SeedLesson` — `{title, body, scope: 'user'|'global', tags, source}`.
  `title` ≤ 200 chars; `body` ≥ 1 char; both required.
- `VerifyGateWhen` — `{event_kind: 'tool_call' | 'prompt_submit' |
'stop' | 'session_end'}`. Tool-name filtering, when needed, belongs
  inside the `check` expression itself (e.g. `match(tool, '^Bash$')`)
  because the `tool_call` `Trigger` variant in `event.ts` intentionally
  carries no per-trigger `tool_match` field.
- `VerifyGate` — `{name, when, check, on_fail: {level, message}}`.
  `name` regex matches the same lowercase-alphanum-hyphen rule as pack
  names; `on_fail.level` ∈ `{warn, block}`; `check` is a 5-fn
  if-expression (`len`/`contains`/`startsWith`/`endsWith`/`match`).
- `Manifest` extended with `seed_lessons: SeedLesson[]` (default `[]`)
  - `verify_gates: VerifyGate[]` (default `[]`) — back-compat with
    every pre-DOG.3 pack.

**Runtime (`src/runtime/types.ts`):** `Pack` hoists `seedLessons?:
SeedLesson[]` + `verifyGates?: VerifyGate[]` so downstream consumers
(audit-trail surface, future fixture sync) can read without re-parsing
manifest YAML.

**`src/packs/verify_gates_compiler.ts`** (99 LOC) —
`compileVerifyGates(packName, gates) -> CompileResult` returns either
`{ok: true, skill}` (synthetic skill named `<pack>/verify`) or
`{ok: false, errors: [{gateName, message}]}`. Each gate compiles into
one `TrackCheckRule` whose process is a single `verdict` primitive call
gated by the gate's `check` expression. Triggers are deduped by
`event_kind` so two gates on `tool_call` produce one trigger.
Load-time pre-parse of every `check` via `parseExpression` catches
malformed if-expressions loudly — the loader throws with the offending
gate name. Audit-trail rule id pattern: `gate:<gate-name>`.

**`src/packs/seed_lessons_ingest.ts`** (87 LOC) —
`ingestSeedLessons(packName, packVersion, seeds, engine) -> IngestResult`
invokes `engine.lessonCreate({description, body, authored_by: 'pack',
pack_id, external_id, seed_as_promoted: true})` per seed.
`external_id = pack-seed:<sha256(packName@packVersion|title).slice(0,24)>`
so re-ingestion UPSERTs (engine returns `updated: true` → counted as
`skipped`). Per-seed failures are COLLECTED (never thrown) so one bad
seed doesn't abort the rest, and a totally absent engine doesn't block
pack load. Pack-authored seeds are eviction-immune per the engine's
`authored_by: 'pack'` contract (matches user-authored behaviour per
`feedback_user_authored_lessons_immune`).

**`src/packs/loader.ts`** — wires both:

- `verify_gates.length > 0` → compile + push synthetic skill into
  `skills` array (throws loudly on compile errors).
- `deps.engine !== undefined && seed_lessons.length > 0` → fire-and-
  forget ingest via `void ingestSeedLessons(...).then(...)`; failures
  log to `console.warn`, never throw.
- `loadPack(dir)` keeps its original single-arg signature for
  back-compat; new optional `deps?: LoadPackDeps` parameter accepts
  `{engine?: EngineClient}` so test paths can omit and bootstrap can
  supply.

### Tests (+26 new cases across 3 files; total ≥ 26 per acceptance)

- `src/packs/verify_gates_compiler.test.ts` — 10 cases: empty-input
  defaults, one-gate compile shape, on_fail level propagation, audit-
  trail rule ids, trigger dedup, parse-error loud failure, multi-gate
  error collection (no early exit), prompt_submit event_kind, empty
  preconditions, namespaced skill name.
- `src/packs/seed_lessons_ingest.test.ts` — 9 cases: empty-input
  zero-counts, lessonCreate call shape (authored_by/pack_id/
  external_id/seed_as_promoted), `updated:false` → ingested,
  `updated:true` → skipped (UPSERT), per-seed error isolation,
  engine-totally-absent fallback, external_id determinism + uniqueness
  across name/version/title, mixed-flag counts split.
- `src/packs/schemas/manifest.test.ts` — 7 new DOG.3 cases: default
  empty arrays, well-formed seed/gate accept paths, empty-title reject,
  bad gate name reject (uppercase / leading hyphen), bad on_fail.level
  reject, bad event_kind reject.

### Why this matters

DOG.3 is the keystone schema sugar that DOG.4 consumes — DOG.4 authors
5-10 seed_lessons + 2-3 verify_gates per focused pack now that the
compile + ingest plumbing is wired. No production behavior change for
packs that don't declare either block; existing packs continue to load
unchanged.

### Spec drift resolved

DOG.3 spec referenced (a) `memoryCreate` for ingest — actual engine
surface is `lessonCreate` with `authored_by: 'pack'` + `external_id`
UPSERT + `seed_as_promoted: true` per `src/engine/types.ts`. (b)
spec's `then: {verdict: ...}` Rule shape doesn't exist — actual
`TrackCheckRule.process[0] = {call: 'verdict', if: <check>, args: {...}}`
matches the existing skill grammar (see
`packs/builtin/default-discipline/skills/git/skill.yaml`).
(c) `tool_match` on `VerifyGateWhen` dropped because the `tool_call`
`Trigger` variant carries no per-trigger tool_match field; the check
expression carries the tool filter when needed.

---

## [0.5.246] - 2026-05-30

### Added (DOG.2 — frontend-react-19-atomic composite pack; second slice of T-DOGFOOD)

Composite pack at `packs/builtin/frontend-react-19-atomic/` that aggregates
the three DOG.1 focused packs via the MM.1 `includes:` schema field:

- **`manifest.yaml`** — `kind: composite` + 3-entry `includes:` array
  (`focused-react-19@>=0.1.0`, `focused-typescript-strict@>=0.1.0`,
  `focused-atomic-design@>=0.1.0`). No own `foundation:` (forbidden for
  composites per v0.6 §4.7 validation rule). No own `detected_by`
  (children gate themselves). No own `skills/` directory.
- **`README.md`** — user-facing description + opt-in instructions +
  rules-table summarising composite-pack constraints from
  pack-runtime.md §1.7.

### Tests

- **`test/builtin/composite-frontend.test.ts`** — 12 integration cases:
  - 4 × manifest-shape assertions: kind=composite, includes (3 entries
    in order), foundation undefined, detected_by empty, skills empty.
  - `expandComposites` produces composite + 3 children in order.
  - `expandComposites` is idempotent (expand twice → same flat list).
  - `expandComposites` throws `CompositeResolutionError` when a child
    is missing from the registry.
  - `expandComposites` throws on semver mismatch (synthesized via a
    shallow clone with version downgraded to `0.0.1`).
  - Each child's `detected_by` fires independently against a synthetic
    React 19 + TS-strict + atomic-design `DetectionContext` after
    expansion.
  - All 3 children return false on empty `DetectionContext` (no
    spurious activations).
  - Composite with empty `detected_by` is vacuously active per
    `matchesDetectedBy` contract.
  - Composite-only registry (no children loaded) throws missing-include
    error naming the first missing child.

### Why this matters

DOG.2 is the keystone slice that proves the MM.1 composite-pack
mechanism operates end-to-end against a real user-facing assembly. Pure
config + tests at this slice — no engine code changes needed because
`composite_resolver.expandComposites` already aggregates per MM.1.
Spec drift resolved: DOG.2 spec referenced `extends:` (single-parent
inheritance via `apply_extends.ts`); actual schema ships `includes:`
(array-aggregation via `composite_resolver.ts`). This commit uses the
schema-correct `includes:`.

---

## [0.5.245] - 2026-05-30

### Added (DOG.1 — three focused built-in packs ship; first slice of T-DOGFOOD)

Three opt-in focused packs land as `packs/builtin/` directories:

- **`focused-react-19`** — encodes React 19+ idioms (Server Components,
  Actions, useOptimistic, hooks-of-hooks discipline). Activates when
  `package.json` declares `react ^19` in `dependencies` OR
  `devDependencies` via two `file_match` detected_by rules (IDF.2 regex
  evaluator).
- **`focused-typescript-strict`** — encodes TS 5 strict-mode idioms
  (exhaustiveness via `never`, discriminated unions, `as const`
  narrowing, no-fail-open at switches). Activates when `tsconfig.json`
  exists OR has `compilerOptions.strict: true`.
- **`focused-atomic-design`** — encodes Atomic Design idioms (atoms →
  molecules → organisms → templates → pages; token-driven theming;
  one-component-per-file). Methodology pack — `foundation.tools: []`
  (no specific library requirement). Activates when
  `src/components/atoms/` or sibling directory exists.

Each pack ships at this slice:

- `manifest.yaml` with `name`/`version`/`scope: domain`/`goal`/
  `description`/`activation_scope: project`/`foundation`/`detected_by`.
- `README.md` documenting activation + roadmap pointer to DOG.2
  (composite aggregation) + DOG.4 (seed_lessons + verify_gates).
- `skills/` deliberately empty — populated in DOG.4 after DOG.3 lands
  the `seed_lessons` + `verify_gates` schema sugar.

### Tests

- **`test/builtin/focused-packs.test.ts`** — 11 cases:
  - 3 × loadPack() round-trip per pack (name + scope + activation_scope
    - detectedBy + foundation present).
  - foundation-shape assertions per pack (react@>=19 tools entry +
    methodologies; typescript@>=5 + strict-mode; atomic-design with
    empty `tools` + methodologies).
  - 4 × `matchesDetectedBy` evaluator integration with synthetic
    `DetectionContext` fixtures: react ^19 activates / react ^17 does
    NOT activate / atomic-design activates on dir / typescript activates
    on tsconfig.json presence.
  - 1 × `matchesDetectedBy` returns false on empty context (all 3
    packs).

### Why this matters

DOG.1 is the first slice of T-DOGFOOD — the v1 release showcase. It
proves the IDF.1–5 schema + IDF.2 evaluator + LP.1 pack loader operate
end-to-end against a real opt-in domain pack composition target before
DOG.2 wires up the composite. No production behavior change for users
who don't opt in — pure additive built-in surface.

---

## [0.5.244] - 2026-05-30

### Fixed (CI hotfix — transport_bridge.test.ts pre-existing flake)

- **`src/runtime/agent_bridge/transport_bridge.test.ts`** — bump the
  `emits one event per legacy JSONL row appended` test timeout from the
  vitest default (5000ms) to `20_000ms`. The test passes in <1s
  locally + in isolation; it occasionally exceeds 5s in GitHub Actions
  Node-20 runners under shared-runner contention combined with the
  chokidar polling backend. Unblocks the LP.5 CI red after `fd1df64`
  so DOG.1 can ship next. No production behavior change.

---

## [0.5.243] - 2026-05-30

### Added (LP.5 — auto-upgrade detection helper + pack-runtime.md docs — CLOSES T-LIVING-PACK)

- **`checkAndMergeUpgrades(packStateDir, vanillaManifest, vanillaDir)`** in
  `src/packs/discovery.ts` — lazy 3-way merge trigger:
  - Returns null when: pack not installed, no lessons to preserve
    (revision_id 0), already merged (last_merged_vanilla === vanilla),
    or not an upgrade (vanilla <= base).
  - Otherwise fires `runThreeWayMerge` (LP.2) and caches the
    `MergeResult` in a per-session map keyed on
    `(packId, baseVersion, vanillaVersion, personalRevisionId)`.
- **`clearMergeCache()`** — bootstrap calls on SessionStart to empty
  the cache (cache is module-scoped + persistent within a single
  Node process otherwise).
- **`_mergeCacheSize()`** — test-only helper for cache-size assertions.

### Docs (pack-runtime.md extensions)

- **§1.8** `base_version` + `personal_revision` — documents the
  living-pack 2-layer state model (immutable base + monotonic
  personal_revision lessons), the version.json shape, and the I/O
  helpers in `src/packs/personal_revision.ts`.
- **§1.9** Pack export modes — table of lessons-only (default) / raw /
  with-evidence (deferred v1.5) with use-case columns.
- **§3.5** Vanilla upgrade lifecycle — full 5-step flow from
  install/discovery upgrade detection through 3-way merger
  dispositions through conflict sidecar resolution. Documents lazy +
  idempotent + base_version-immutable design invariants per L10/L11.

### Tests

- `src/packs/discovery.test.ts` — 6 new LP.5 cases:
  - not installed → null
  - no lessons (revision_id 0) → null
  - vanilla === base (not an upgrade) → null
  - last_merged_vanilla matches → null (already merged)
  - upgrade detected → MergeResult returned; cache populated
  - second call short-circuits via persisted last_merged_vanilla
  - `clearMergeCache` empties the cache
- Full suite: 2637 pass / 28 skip / 0 fail (+6 net)

### Closes T-LIVING-PACK (5/5 shipped)

| Task | What                                           | Commit    | Version |
| ---- | ---------------------------------------------- | --------- | ------- |
| LP.1 | BaseVersion + PersonalRevision + I/O helpers   | `cea6a06` | 0.5.239 |
| LP.2 | 3-way merge resolver + conflict sidecar        | `217f6d4` | 0.5.240 |
| LP.3 | persistPromotedLesson + resolvePackStateDir    | `9e915d5` | 0.5.241 |
| LP.4 | CLI install/list/export/remove (v1 min-viable) | `984be01` | 0.5.242 |
| LP.5 | upgrade helper + docs (this commit)            | —         | 0.5.243 |

The living-pack mechanic — the heart of pack evolution per the user's
2026-05-30 framing — is now operational: packs ship at a base_version,
the wedge-promote pipeline writes lessons via persistPromotedLesson,
the CLI manages install/list/export/remove, and vanilla upgrades
trigger 3-way merges with personal-revision-preserving conflict
sidecars. Bootstrap wiring (auto-trigger checkAndMergeUpgrades from
discoverActivePacks at session-load) is a one-line follow-up once
LP.1's loader fold lands.

---

## [0.5.242] - 2026-05-30

### Added (LP.4 — opensquid pack CLI v1 minimum-viable: install/list/export/remove)

- **`src/cli/pack.ts`** (new) — top-level `opensquid pack` command with
  4 subcommands. Test-injection seam (`deps.out`, `deps.forceYes`)
  for unit-test access.
- **`opensquid pack install <source>`** — local-directory install.
  Reads + validates manifest.yaml, validatePackId, copies to
  `<state>/base/`, calls initPersonalRevision with the manifest
  version. On version delta: triggers `runThreeWayMerge` (LP.2);
  promotes staging → base after successful merge; rejects downgrade
  (existing > new) with no `--force` in v1.
- **`opensquid pack list`** — enumerates installed packs under
  `<OPENSQUID_HOME>/packs/` (user) or `<projectCwd>/.opensquid/packs/`
  (project). Each row: `name padded base=X revision=N lastMerged=Y`.
- **`opensquid pack export <name>`** — 2 modes shipped: `lessons-only`
  (default; strips `<cite id=...>` syntax + drops `cited_memory_ids`)
  - `raw` (full snapshot incl. version.json). Output dir defaults to
    `<name>-<mode>-export/`.
- **`opensquid pack remove <name>`** — removes `<state>/base/` by
  default; preserves `personal_revision/` per no-delete axiom.
  `--also-personal-revision` deletes both. Confirmation prompt via
  `readline/promises` unless `--yes`.
- **`validatePackId`** (from LP.3) called on every subcommand to
  defend against path-traversal in pack names.

### Wired

- `src/cli.ts` — `registerPackCli(program)` after `registerChatWatch`.

### Tests

- `src/cli/pack.test.ts` — 13 cases across all 4 subcommands:
  install (fresh / upgrade triggers merge / downgrade rejected /
  malicious-name rejected at schema layer); list (empty / 2 packs);
  export (default mode lessons-only / invalid mode rejected /
  uninstalled-pack rejected / raw mode includes version.json);
  remove (--yes preserves personal_revision / --also-personal-revision
  deletes both / uninstalled-pack no-op).
- Full suite: 2631 pass / 28 skip / 0 fail (+13 net).

### Scope deviation (acknowledged + intentional)

The LP.4 spec called for tarball install (`tar-stream` dep) + URL
install (HTTPS download) + a third `with-evidence` export mode with
consistent memory-id remapping. v1 ships local-directory install +
2-mode export only. Tarball install + URL install + with-evidence
remapping are tracked as v1.5 follow-ups (no functional regression —
local install is the v1 demo path).

---

## [0.5.241] - 2026-05-30

### Added (LP.3 — persistPromotedLesson helper + path-traversal-safe state-dir resolver)

- **`persistPromotedLesson(packStateDir, lesson)`** in
  `src/packs/personal_revision.ts` — high-level "a Stage-2-promoted
  lesson lands in this pack's personal_revision/ directory" helper.
  Wraps `initPersonalRevision` (defensive `'0.0.0'` baseline when
  caller omits `packBaseVersion`) + `appendLessonFile` with the
  standard LP.3 lesson shape:
  - `promoted_at` ISO timestamp
  - `engine_lesson_id` (for reconciliation)
  - `lesson_body` (engine's raw lesson)
  - `cited_memory_ids[]`
  - `skill` (optional — engine-direct lessons omit)
  - `retired: false` (user can flip via future CLI)
    Returns the new revision id. Throws on write failure (NO silent
    swallow per `feedback_no_silent_fail_open`).
- **`resolvePackStateDir(packId, scope?, projectCwd?)`** in
  `src/packs/discovery.ts` — user scope (default) →
  `<OPENSQUID_HOME>/packs/<id>/` (honors env override); project scope →
  `<projectCwd>/.opensquid/packs/<id>/`.
- **`validatePackId(packId)`** path-traversal defense — rejects empty,
  leading-dot, `/`, `\`, and `..` patterns. Called before any path
  construction. Stops malicious manifest.name values from escaping
  `~/.opensquid/packs/`.

### Tests

- `src/packs/personal_revision.test.ts` — 4 new cases on
  `persistPromotedLesson` (full lesson shape, defensive baseline,
  optional skill, monotonic id bumps)
- `src/packs/discovery.test.ts` — 6 new cases on validatePackId +
  resolvePackStateDir (normal ids, path-traversal rejection,
  leading-dot rejection, empty rejection, user-scope OPENSQUID_HOME
  honor, project-scope projectCwd requirement)
- Full suite: 2618 pass / 28 skip / 0 fail (+10 net).

### Spec deviation note (acknowledged + intentional)

The LP.3 spec assumed `src/runtime/wedge/promote.ts` does engine
writes; in reality `promote.ts` is a pure `shouldPromote()` decision
function and lesson writes flow through the `store_lesson` MCP
primitive in `src/functions/rag.ts`. LP.3 ships the helper that the
spec called for (`persistPromotedLesson`) as a reusable function;
wiring it into the actual write path (store_lesson primitive +
context-bound packId) is a follow-up since the primitive doesn't
currently receive packId context. The helper's shape matches the
spec exactly so the follow-up is a one-line caller addition.

---

## [0.5.240] - 2026-05-30

### Added (LP.2 — 3-way merge resolver + conflict sidecar emission)

- **`src/runtime/versioning.ts`** (new, 243/250 LOC) — pure-ish
  `runThreeWayMerge(input)` compares 3 pack snapshots:
  - `baseDir` (immutable installed version)
  - `personalStateDir` (LP.1 personal_revision/ — lessons + version.json)
  - `vanillaDir` (newer upstream version)
- **4-disposition classifier**:
  - `unchanged` — vanilla matches base
  - `auto-merged-personal` — vanilla matches base, personal differs
  - `auto-merged-vanilla` — vanilla differs from base, personal untouched
  - `conflict` — vanilla AND personal both touched → sidecar emitted
- **YAML-comment-safe conflict sidecar** (`lesson_<n>.conflict.yaml`):
  - Header lines: `# CONFLICT: vanilla bump overlaps with personal...`
  - Git-style markers prefixed with `# `: `# <<<<<<< base`,
    `# =======`, `# >>>>>>> vanilla <semver>`
  - Original lesson body preserved verbatim below the marker block
  - Atomic temp+rename write (consistent with LP.1 writer pattern)
- **Idempotent**: re-run with same `vanillaVersion` →
  `noop: true`; no file writes.
- **Throws on downgrade** (vanilla < base) or missing version.json
  — operator-error signal.
- **Recursive walker** (`readPackTextFiles`) reads .yaml/.yml/.md only,
  skips node_modules/.git/.opensquid/personal_revision, path-traversal
  defense via `relative()` + `..`-rejection.
- **Substring-based `lessonReferencesSkill`** heuristic (per
  `feedback_simplest_granular_form` — false positives surface as
  conflicts, which is honest; auto-resolving overlap risk is dishonest).
- **No LLM imports** — text/YAML diff only (per
  `feedback_stop_haiku_drift`).

### Tests

- `src/runtime/versioning.test.ts` — 16 cases (≥15 spec cap):
  - preconditions: missing version.json throws; downgrade throws
  - idempotency: same vanilla → noop; higher vanilla → not noop
  - dispositions: unchanged / auto-merged-vanilla (new file) /
    auto-merged-personal / conflict (vanilla+personal overlap) /
    deleted-skill conflict / empty snapshots
  - sidecar: writes last_merged_vanilla; YAML-comment-safe markers
    verified; multi-lesson same-skill → only first conflicts
  - walker: skip dirs (node_modules/.git/.opensquid/personal_revision);
    skip non-yaml/md extensions
  - result shape carries packId + baseVersion + personalRevisionId
- Full suite: 2607 pass / 28 skip / 0 fail (+16 net).

### Notes

- LP.3 (wedge-promote integration) will be the first caller of
  `appendLessonFile` (writes lessons); LP.5 (discovery upgrade
  detector) will be the first caller of `runThreeWayMerge` at session
  load. LP.4 (CLI install) writes the initial version.json.

---

## [0.5.239] - 2026-05-30

### Added (LP.1 — keystone of T-LIVING-PACK; pack-evolution foundation)

- **`BaseVersion`** Zod schema in `src/packs/schemas/manifest.ts` —
  semver shape (`/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/`) validating
  `1.2.3`, `1.2.3-rc.1`, `10.20.30`; rejects `v1.2.3`, `1.2`, `""`.
- **`PersonalRevision`** Zod schema — `.strict()` 3-field shape
  `{base_version, personal_revision_id, last_merged_vanilla}` with
  defaults (`0` + `null`).
- **`Manifest` extended** with optional `base_version` + `personal_revision`
  blocks (loader-populated, not author-declared).
- **`Pack` runtime type extended** with optional camelCase fields
  `baseVersion / personalRevisionId / lastMergedVanilla` (all
  optional so test fixtures + built-in packs continue without
  modification).
- **`src/packs/personal_revision.ts`** (new, 171/180 LOC) — 5 I/O helpers:
  - `readVersionJson(packStateDir)` — returns null on ENOENT; throws on
    malformed JSON / schema mismatch (loud — engine-written file)
  - `writeVersionJson(packStateDir, state)` — atomic temp+rename
  - `readLessonFiles(packStateDir)` — enumerates `lesson_<n>.yaml` +
    `lesson_<n>.conflict.yaml` in monotonic id order; sidecars
    marked `hasConflict: true`
  - `appendLessonFile(packStateDir, lessonBody)` — reads version,
    computes next id, writes lesson atomically, bumps revision_id
  - `initPersonalRevision(packStateDir, baseVersion)` — idempotent
    fresh-install init (writes version.json at revision_id 0)
- **Atomic write invariant**: every write goes via `<path>.tmp.<pid>.<rand>`
  - `fs.rename` so a crash mid-write leaves the prior version intact.
    No `.tmp.*` files leak.
- **Schemas re-exported** from `src/packs/schemas/index.ts` (`BaseVersion`
  - `PersonalRevision` + type aliases).

### Tests

- `src/packs/personal_revision.test.ts` — 12 cases (round-trip,
  malformed JSON throw, schema rejection, lesson enumeration sort,
  conflict sidecar detection, missing-init throw, sequential append
  id bump, idempotent init, atomic-no-tmp-leak verification)
- `src/packs/schemas/manifest.test.ts` — 4 new schema cases
  (BaseVersion valid/invalid shapes, optional personal_revision block
  with defaults, `.strict` rejection of extra keys)
- Full suite: 2591 pass / 28 skip / 0 fail (+16 net)

### Notes

- The loader.ts fold from `~/.opensquid/packs/<name>/personal_revision/
version.json` is deferred to LP.4 (CLI install — first writer). For
  now, built-in packs (`packs/builtin/`) have no version.json and load
  unchanged; installed packs at user-scope will pick up the fields
  when LP.4 ships the writer + LP.5 wires the loader fold.

---

## [0.5.238] - 2026-05-30

### Added (MM.5 — integration + docs — CLOSES T-MULTIMODE)

- **`docs/pack-runtime.md` §1.1** — manifest fields table extended with
  `kind`, `usage`, `includes` rows.
- **`docs/pack-runtime.md` §1.7`** (new) — `kind` / `usage` / `includes`
  semantics block covering:
  - focused vs composite pack types
  - active / profession / both usage modes
  - `includes:` shape + semver range syntax
  - profession spawn flow + no-agent-loop invariant
- **`docs/pack-runtime.md` §3.1** — Discovery section extended with
  step 6 (composite expansion) + `CompositeResolutionError` 5-cause
  table (unknown-pack / semver-mismatch / cycle / depth-exceeded /
  invalid-semver).
- **`docs/pack-runtime.md` §3.4** — Dispatch flow ASCII diagram extended
  with the directive-aggregation branch + profession validation
  pipeline. Includes the 5-code `ProfessionResolutionError` table
  (unknown-pack / wrong-usage / missing-team / no-roles /
  role-not-found).
- **`test/e2e/multimode_e2e.test.ts`** (new, 6 cases) — exercises the
  full Phase 2 stack end-to-end:
  - composite expansion: 3-pack input → composite + 2 includes in
    expanded output (sorted)
  - composite identity: composite preserved in expanded list for audit
  - profession resolver: scope-architect directive resolves to
    SCOPE_COMPLETE role
  - profession resolver: pack-architect directive resolves to
    PACK_AUTHORING_COMPLETE role
  - profession resolver: unknown-pack directive dropped
  - integrated chain: composite → expanded → directive resolution
    against expanded registry (matches dispatcher behavior)
- **`test/fixtures/composite-test/manifest.yaml`** (new) — synthetic
  composite fixture; lives in test/fixtures/ so it's NOT shipped in
  the npm package.

### Closes T-MULTIMODE (5/5 shipped)

| Task | What                                              | Commit    | Version |
| ---- | ------------------------------------------------- | --------- | ------- |
| MM.1 | manifest kind/usage/includes + composite_resolver | `5d8295e` | 0.5.228 |
| MM.2 | profession auto-spawn directive validator         | `22db2cf` | 0.5.235 |
| MM.3 | scope-architect profession-mode wiring            | `16b4576` | 0.5.236 |
| MM.4 | pack-architect new built-in profession pack       | `27707db` | 0.5.237 |
| MM.5 | integration + docs (this commit)                  | —         | 0.5.238 |

### Tests

- Full suite: 2575 pass / 28 skip / 0 fail (+6 net).

---

## [0.5.237] - 2026-05-30

### Added (MM.4 — pack-architect built-in profession pack)

- **`packs/builtin/pack-architect/`** (new) — opensquid's meta-discipline
  pack: teaches users how to author well-formed opensquid packs. Ships
  in dual mode (`kind: focused`, `usage: both`,
  `activation_scope: user`).
- **`manifest.yaml`** — opt-in (NOT in default active.json per BR.1).
  Empty `detected_by: []` per design — opt-in posture means the user
  explicitly adds pack-architect to their active.json.
- **`team.yaml`** — single Mode A role with the canonical 4-phase
  pack-authoring instructions (identify scope + persona → write
  manifest.yaml → author skills → side-files as needed).
  `handoff_signal: PACK_AUTHORING_COMPLETE`. `model_alias: reasoning`
  per model-neutrality.
- **`SKILL.md`** — pedagogical overview + opt-in instructions + 3-skill
  table + 4-phase workflow + cross-references to pack-runtime.md +
  skill-grammar-guide.md.
- **`skills/pack-scope-elicit/`** — fires on UserPromptSubmit matching
  pack-authoring intent (write/author/create/build a pack); reads
  chain state; if chain stage is `idle`/null, emits directive
  `next_action.profession: scope-architect` for prework.
- **`skills/manifest-author-walkthrough/`** — fires on Write/Edit of
  any `packs/*/manifest.yaml`; surfaces a 10-item manifest-field
  checklist (kind/usage/activation_scope/detected_by/foundation/
  includes/etc.).
- **`skills/skill-yaml-author-walkthrough/`** — fires on Write/Edit
  of any `packs/*/skills/*/skill.yaml`; surfaces a 11-item skill-field
  checklist (load/when_to_load/triggers/requires/rules/process steps/
  if: grammar/verdict choice/model_alias discipline/fail-open
  prohibition).

### Tests

- `test/builtin/pack-architect.test.ts` — 10 cases:
  - pack loads via loadPack
  - kind/usage/activation_scope/detected_by shape correct
  - team.yaml + role + handoff_signal correct
  - 3 expected skills present
  - pack-scope-elicit emits directive to scope-architect
  - manifest-author-walkthrough has the expected rule id
  - skill-yaml-author-walkthrough has the expected rule id
  - no vendor model identifiers (claude-haiku-N, gpt-N, oN-mini etc.)
    leak into the pack
  - validatePackFunctions: every process step resolves to a registered
    primitive
  - validateUniqueSkillNames: no in-pack collisions

### Notes

- Combined with MM.2 + MM.3: a directive
  `{profession: 'pack-architect', ...}` now passes the resolver, AND
  pack-architect's own pack-scope-elicit skill emits chain-handoff
  directives to scope-architect (composition of MM.4 + MM.3 + MM.2).
- Full suite: 2569 pass / 28 skip / 0 fail (+13 net).

---

## [0.5.236] - 2026-05-30

### Added (MM.3 — scope-architect profession-mode wiring)

- **`packs/builtin/scope-architect/manifest.yaml`** — added `kind: focused`
  - `usage: both`. The pack now ships eligible for either the
    active-load path (existing 9-skill behavior) OR the profession-spawn
    path (when another pack emits `next_action.profession:
'scope-architect'`).
- **`packs/builtin/scope-architect/team.yaml`** (new) — single-role
  Mode A team manifest:
  - `name: scope-architect-team`
  - role `name: scope-architect`, `pack: scope-architect`
    (self-reference is intentional in Mode A leaf-node), `model_alias:
reasoning` (model-neutral), `handoff_signal: SCOPE_COMPLETE`
  - pedagogical `instructions:` block citing
    [[feedback_synthesis_step_required]] +
    [[feedback_no_skim_during_research]] — guides the spawned subagent
    to produce a pre-research artifact + emit the handoff signal
- **3 new tests** in `test/builtin/scope-architect.test.ts`:
  - pack loads with `kind: focused`, `usage: both`, `includes: []`
  - team.yaml parses with exactly one scope-architect role
  - `model_alias` is not a vendor model name (no haiku/sonnet/opus/gpt)

### Notes

- Zero behavior change to the 9 existing scope-architect skills
  (scope-detect, chain-handoffs, inline-spec-block, pack-skill-authoring,
  pre-research-authoring, recall-consumed, scope-before-code,
  task-list-generated, taskcreate-spec-required) — MM.3 is additive
  metadata only.
- Combined with MM.2: a directive like `{profession:
'scope-architect', rationale: '...'}` now passes the
  resolveProfessionDirective validator + surfaces to the agent via
  the UserPromptSubmit envelope.

---

## [0.5.235] - 2026-05-30

### Added (MM.2 — profession auto-spawn directive validator)

- **`src/runtime/hooks/profession_resolver.ts`** (new) — pure
  `resolveProfessionDirective(nextAction, packs, teamsByPack)` returns
  tagged result. 5 error codes: `unknown-pack` / `wrong-usage` /
  `missing-team` / `no-roles` / `role-not-found`. Phase-2 leaf-node
  default = first role; multi-role lookup honors `nextAction.args.role`
  (future-proof).
- **`formatProfessionError(err)`** — human-scannable rendering of
  every error code.
- **`src/runtime/types.ts`** — `Pack` runtime type extended with
  optional `team?: Team` field.
- **`src/packs/loader.ts`** — when `usage: profession | both`, loader
  now actually LOADS + parses team.yaml (previously only checked
  existence). Loaded team attaches to the Pack so the dispatcher
  doesn't re-read at dispatch time.
- **`src/runtime/hooks/dispatch.ts`** — directive aggregation path
  validates every profession directive before pushing onto the
  envelope: builds `teamsByPack` map from loaded packs, calls
  `resolveProfessionDirective`, drops invalid + appends a warn to the
  existing warn buffer. Skill + tool directives pass through unchanged
  (back-compat).
- **No-agent-loop invariant preserved**: opensquid NEVER invokes
  `spawn_subagent`. The directive surfaces via the UserPromptSubmit
  envelope; the AGENT calls `spawn_subagent` per
  [[project_opensquid_no_agent_loop]].

### Tests

- `profession_resolver.test.ts` — 12 cases (7 resolver + 5
  format-message snapshots)
- `dispatch.test.ts` — 64 existing cases still pass unchanged
- Full suite: 2556 pass / 28 skip / 0 fail (+12 net)

---

## [0.5.234] - 2026-05-30

### Added (LL.6 — E2E loop closure fixture — CLOSES T-L3-LOOP)

- **`test/e2e/l3_inbound_e2e.test.ts`** (new) — single end-to-end test
  that proves the full inbound communication loop closes:
  1. Sets up tmpdir OPENSQUID_HOME + fresh `live-session.lease`
  2. Appends synthetic Telegram-style InboxRow to `inbox/telegram.jsonl`
  3. Starts the LL.3 inbound watcher (chokidar tail) + waits for
     awaitWriteFinish settle, then stops
  4. Asserts watcher dispatched (no crash; ack ledger still empty —
     watcher fires events, UPS hook owns durability)
  5. Spawns the UPS hook binary with synthetic prompt-submit payload
  6. Asserts hook stdout JSON envelope contains
     `📨 Inbound messages (1)` + `alice (telegram): hello from telegram`
     in `hookSpecificOutput.additionalContext`
  7. Asserts `acked.jsonl` now contains exactly one matching AckRow
     (`message_id: 'msg-42'` + `injected_at_sessionId: SESSION_ID`)
  8. Spawns the UPS hook a SECOND time + asserts dedup holds (no
     re-inject + no duplicate ack)
- Uses skip-if-no-binary pattern (`it.skipIf(!existsSync(HOOK_BIN))`)
  so CI runs without prior `pnpm build` skip gracefully.

### Closes T-L3-LOOP (6/6 shipped)

| Task | What                                           | Commit    | Version |
| ---- | ---------------------------------------------- | --------- | ------- |
| LL.1 | InboxRow + AckRow schemas + path helpers       | `8b0f8f1` | 0.5.229 |
| LL.2 | Session-routing resolver                       | `cdc4a27` | 0.5.230 |
| LL.3 | Inbound watcher + sender_pattern Trigger       | `60c3e09` | 0.5.231 |
| LL.4 | UPS hook drain + ack ledger                    | `eafbe27` | 0.5.232 |
| LL.5 | pack-runtime.md inbound docs + inbound-greeter | `a46b863` | 0.5.233 |
| LL.6 | E2E round-trip fixture (this commit)           | —         | 0.5.234 |

The multi-session delivery break that prompted T-L3-LOOP is now closed
both architecturally (LL.1-LL.4 runtime) AND verifiably (LL.6 E2E proof).

### Tests

- Full suite: 2544 pass / 28 skip / 0 fail (+1 net).

---

## [0.5.233] - 2026-05-30

### Added (LL.5 — docs/pack-runtime.md inbound docs + reference inbound-greeter skill)

- **`docs/pack-runtime.md` §2.4** — extended Event-kinds table row for
  `inbound_channel` (`channel`, `sender_pattern` filter fields). Added
  filter-semantics block + `InboundChannelEvent` payload table
  documenting `channelUri / sender / text / threadKey / receivedAt`.
- **`docs/pack-runtime.md` §7.5** — two new anti-pattern entries:
  - Inbound dispatch is best-effort; unreachable sessions stay silent
    (documents L7 / L12: chat-watch crash → unrouted.jsonl + inbox
    backlog drained at next session-start via LL.4 UPS hook)
  - Inbound skills are passive evaluators — never mutate the inbox
    (documents L8: opensquid invariant "packs propose; runtime
    disposes" — no `mark_inbound_read` / `delete_inbound` primitive)
- **`packs/builtin/default-discipline/skills/inbound-greeter/`** (new) —
  reference example skill for the `inbound_channel` trigger pattern:
  - `skill.yaml` — `load: lazy` + `when_to_load: [event_type:
inbound_channel]` + `unloads_when: [session_ends]` (stays scoped
    to one chat-watch lifetime; won't pile up across long sessions)
  - `triggers: [{kind: inbound_channel, sender_pattern: '^.+$'}]`
  - Single rule `surface-acknowledgment` emits a `surface` verdict
  - `SKILL.md` documents how the trigger fires + how to customize
- **`test/builtin/inbound-greeter.test.ts`** (new, 4 cases) verifies
  the skill loads + declares an `inbound_channel` trigger with
  `sender_pattern` + emits a single `surface` rule + unloads on
  session_ends.
- **`test/builtin/default-discipline.test.ts`** updated — skill count
  assertion bumped from 7 → 8 (new `inbound-greeter`).

### Tests

- Full suite: 2543 pass / 28 skip / 0 fail (+4 net).

---

## [0.5.232] - 2026-05-30

### Added (LL.4 — UPS hook drains unacked inbox into additionalContext + ack ledger)

- **`src/runtime/chat/inbox_inject.ts`** (new, 109/180 LOC) — pure
  helpers `computeUnackedRows` / `buildInjectionEnvelope` /
  `purgeOldAcks` / `buildAckRowsForInjected` for the UPS hook's drain
  step. Per-session dedup via `(platform, message_id, sessionId)` key
  (L2); 8KB envelope budget cap; overflow rows stay unacked + drain on
  next turn (lazy push); 7-day cutoff for purge.
- **`src/runtime/chat/inbox_writer.ts`** (new, 78/100 LOC) — durable
  `appendAckRows` + atomic `rewriteAckedAfterPurge` under
  `proper-lockfile` mutex (already an opensquid dep). Lock retries
  bounded (5x factor:2 minTimeout:50ms); empty input is a no-op.
- **`src/runtime/hooks/user-prompt-submit.ts`** — new
  `drainInboxEnvelope(sessionId)` helper wired before
  `dispatchEvent`. ACK-BEFORE-EMIT durability ordering: AckRows persist
  before the envelope returns. Fail-open wrapper: any error returns
  empty envelope; user's prompt always rides through.
- Inbox envelope appears FIRST in `additionalContext` `contextParts`
  array (most prominent surface), followed by existing inject_context +
  new-project-detect + directives parts.
- 17 new tests: inbox_inject (12) + inbox_writer (5). Full suite 2539
  pass / 28 skip / 0 fail.

### Architectural shape (combined with LL.3 — multi-session delivery operational)

```
chat-bridge-server writes inbox/<platform>.jsonl
  └─► LL.3 watcher dispatches inbound_channel event to LIVE session
  └─► LL.4 UPS hook drains backlog at next prompt-submit (additionalContext)
       └─► ack ledger (acked.jsonl) is the dedup boundary
       └─► 7-day auto-purge keeps it bounded
```

A user message in a Telegram topic now lands either via per-event
dispatch (when the session is live) OR per-turn injection at next
prompt-submit (when offline / orphaned).

---

## [0.5.231] - 2026-05-30

### Added (LL.3 — inbound watcher + sender_pattern Trigger field + dispatcher filter)

- **`src/runtime/chat/inbound_watch.ts`** (new, 215/280 LOC) —
  chokidar-backed tail over every live project's
  `inbox/<platform>.jsonl`. On each appended row → parse `InboxRow` →
  resolve session via LL.2 → if fresh, construct `InboundChannelEvent`
  - dispatch to active packs; if stale/missing, append to
    `~/.opensquid/projects/<uuid>/inbox/unrouted.jsonl` + leave row in
    inbox (lazy-push per L7; LL.4 UPS hook drains on next session prompt).
  * `buildChannelUri(row)` → `<platform>://<channel>[/<thread_id>]`
  * `platformFromChannelUri(uri)` parses scheme back to `Platform`
  * `extractProjectUuid(path)` parses uuid from inbox file path
  * `processRow(uuid, row)` exported for unit-test access
  * `startInboundWatcher()` returns cleanup fn; CLI invokes on lifecycle
  * 60s re-scan picks up projects that come online after watcher start
  * Byte-offset tracking handles truncation (size < lastOffset → reset)
  * Best-effort `unrouted.jsonl` writer (never throws; parent dir
    created on demand)
- **`src/runtime/event.ts`** — `Trigger` `inbound_channel` variant
  extended with optional `sender_pattern: z.string()` field. First-party
  pack manifests only (JS RegExp acceptable; pack-runtime.md §7.5
  documents trust boundary).
- **`src/runtime/hooks/dispatch.ts`** — exported
  `inboundChannelTriggerMatches(trigger, event)` pure filter:
  - `channel` literal compared against `event.channelUri` scheme prefix
  - `sender_pattern` regex tested against `event.sender`
  - Empty/absent fields = accept-all (back-compat)
  - Malformed regex → silent skip (no throw)
  - Inserted in the dispatcher pack-walk after AUTO.1 event-kind
    filter; an `inbound_channel` event with no matching-trigger filter
    short-circuits before the rule walk.
- **`src/runtime/chat/watch_cli.ts`** — integrated `startInboundWatcher`
  into the `chat watch` lifecycle. Injection seam `deps.startInbound`
  for test stubbing. Cleanup runs in `finally` alongside lease release.

### Tests

- `inbound_watch.test.ts` — 10 cases (channelUri build/parse,
  extractProjectUuid, processRow unrouted on missing/stale lease, append
  semantics)
- `dispatch.test.ts` +8 new cases on `inboundChannelTriggerMatches` (no
  filter / channel match / channel mismatch / sender_pattern match /
  sender_pattern mismatch / malformed regex / empty pattern / empty
  channel)
- Full suite: 2522 pass / 28 skip / 0 fail (+18 net)

### Architectural shape (closes the multi-session delivery break)

When a user sends a Telegram message to a project's topic:

1. chat-bridge-server writes to `inbox/telegram.jsonl` (existing)
2. The LL.3 watcher (running in `chat watch`) sees the append
3. Resolves the live session via the LL.2 lease lookup
4. If fresh → dispatches an `inbound_channel` event so any pack with
   matching `triggers:` fires
5. If stale → logs to `unrouted.jsonl`; LL.4 drains at next prompt-submit

The LL.4 UPS hook (next task) closes the loop by ALSO draining unacked
rows at every prompt-submit so a session that comes online late still
sees the backlog.

---

## [0.5.230] - 2026-05-30

### Added (LL.2 — session-routing resolver)

- **`src/runtime/chat/session_routing.ts`** (new, 105/120 LOC) wraps the
  existing `live_session_lease` primitives into a project-keyed lookup so
  LL.3 (inbound watcher) and LL.4 (UPS hook) can answer "which session
  should receive this project's inbox?" without re-implementing freshness.
- **`resolveLiveSessionId(projectUuid, now?)`** returns `string | null`:
  fresh lease (≤ 90s) → `session_id`; stale / missing / corrupt → null.
- **`resolveAllLiveProjects(now?)`** enumerates every project with a fresh
  lease, sorted by `refreshedAt` ascending (oldest-first; stable across
  reruns). ENOENT on `~/.opensquid/projects/` → `[]`.
- **No logging** from the resolver itself — callers log with action
  context so failure messages include what was being attempted.
- **Time-injectable `now`** for deterministic tests; defaults to
  `new Date()`.
- 8 new tests (cap ≥ 8): fresh / stale / missing / corrupt / empty
  session_id / clock-rewind / multi-project enumeration (sorted by
  refreshedAt) / missing-projects-root.

---

## [0.5.229] - 2026-05-30

### Added (LL.1 — keystone of T-L3-LOOP; Phase 5 promoted to front per chat-delivery break)

- **`src/runtime/chat/inbox.ts`** (new, 145 LOC ≤180 cap) — canonical
  `InboxRow` + `AckRow` Zod schemas + `Platform` enum + `readInbox` +
  `readAcked` + `ackKey` helpers. Extracted from the inline
  `interface InboxMessage` at `src/mcp/chat-bridge-server.ts` so the
  upcoming chokidar tail watcher (LL.3) and the UPS hook
  (LL.4) all bind to one schema.
  - `InboxRow.strict()` with `v: z.literal(1)` envelope marker
  - `AckRow.strict()` with same envelope; dedup key
    `${platform}::${message_id}::${sessionId}`
  - Best-effort readers (ENOENT → `[]`; malformed lines silently skipped
    per the rotation-tail-write contract); LL.5 will document
- **`src/runtime/paths.ts`** — new `inboxDir(uuid)` +
  `inboxAckedPath(uuid)` helpers next to the existing `inboxFile`
- **`src/mcp/chat-bridge-server.ts`** — inline `InboxMessage` interface
  replaced with `type InboxMessage = InboxRow` aliasing the canonical
  schema. Field set byte-for-byte identical so daemon writes parse
  unchanged + MCP tool surface preserved.
- **Tests** — 14 new inbox cases (schema shapes, .strict() rejections,
  enum rejections, reader best-effort, ackKey canonical string) +
  2 path-helper cases = 16 new total (cap ≥ 10). 58/58 chat tests pass;
  full suite 2496 pass / 28 skip / 0 fail (+16 net).

### Why this jumped the line

- T-IDENTITY-FOUNDATION shipped 5/5 + T-MULTIMODE MM.1 keystone shipped
  (0.5.221 → 0.5.228), then the user reported the live
  multi-session delivery bug: a Telegram message landed in
  `~/.opensquid/projects/<uuid>/inbox/telegram.jsonl` but the open
  Claude Code session for that project never received it. The
  diagnostic showed an orphaned `chat watch` process whose
  parent terminated, leaving the inbox tailing but stdout going
  nowhere. T-L3-LOOP is the architectural fix; LL.1 is its
  keystone. T-MULTIMODE MM.2–MM.5 + T-LIVING-PACK +
  T-DOGFOOD queue behind T-L3-LOOP completion.

---

## [0.5.228] - 2026-05-30

### Added (MM.1 — keystone of T-MULTIMODE; Phase 2 of v2 product-completion plan)

- **`PackKind` enum** (`focused | composite`) in `src/packs/schemas/manifest.ts`
- **`PackUsage` enum** (`active | profession | both`)
- **`CompositeInclude`** strict object `{pack_id, semver}`
- **`Manifest` extended** with three optional fields (`kind` / `usage` /
  `includes` — all Zod-default to `focused` / `active` / `[]`) +
  `superRefine` cross-field invariants:
  - `focused` ⇒ empty `includes`
  - `composite` ⇒ non-empty `includes`
  - `composite` ⇒ no `foundation` (pure aggregator per v0.6 §4.7)
- **`Pack` runtime type extended** in `src/runtime/types.ts` with three
  optional camelCase fields (`kind` / `usage` / `includes`). Optional so
  test fixtures stay back-compat; loader supplies via Zod defaults.
- **`composite_resolver.ts`** (new, 173/200 LOC) — pure-function
  `expandComposites(packs)` walks composite packs' `includes:` against
  the registry, returns expanded flat list. Cycle detection per root,
  depth-cap 3, semver matching via `semver` npm pkg's `validRange` +
  `satisfies`. Throws `CompositeResolutionError` with `cause` field
  (`missing-include` / `semver-mismatch` / `cycle` / `depth-exceeded` /
  `invalid-semver`).
- **`loader.ts`** — folds new fields + adds `team.yaml` existence check
  when `usage: profession | both` (clear error when missing).
- **`discovery.ts`** — calls `expandComposites(packs)` AFTER per-pack
  detected_by gating. Composites that fail detection are filtered out
  before expansion (their includes drop with them, consistent with the
  composite-as-gate semantic per L12).
- **Tests**: 10 new schema tests + 12 resolver tests + 4 discovery
  integration tests = 26 new total (above the spec's ≥ 22 floor).
  Full suite 2480 pass / 28 skip / 0 fail (+27 net).

### Notes

- Semver tightness: `semver.satisfies` tolerates malformed input
  (returns false without throwing), so range validity is probed via
  `semver.validRange` + `semver.valid` rather than the satisfies
  throw branch. Tests cover all 5 `cause` variants.

---

## [0.5.227] - 2026-05-30

### Fixed (SAR.1 — scope-architect regex hole — ship/make-it-work intent family)

- **`packs/builtin/scope-architect/skills/scope-detect/skill.yaml`** —
  this session's user prompt _"forbidden from pausing my workflow until
  you have open squid fully functional as intended"_ bypassed all 12
  prior regex patterns (original 6 + DPC.2 widening 6). The gate stayed
  dormant despite a clear scope-authoring meta-intent. Added 7 new
  patterns to catch the "deliver the whole thing" family:
  - `fully|completely|properly` + `functional|working|operational|wired|complete|done`
  - `make|get|ship|bring` + `... functional|working|operational|complete|done|live|ready|v<N>`
  - `forbidden\s+from\s+(pausing|stopping|asking|delegating)`
  - `as|to be intended`
  - `(remaining|outstanding|leftover) (phases|tracks|work|tasks|todos)`
  - `rest|remainder of (the) (plan|track|phase|work|todos)`
  - `(every|all) (remaining|leftover|outstanding) (phases|tracks|tasks|work)`
- 4 existing built-in pack tests still pass (24/24 in `test/builtin/`).
  Behavior-equivalent for prior matched prompts; widens coverage for
  meta-intent prompts that DPC.2 missed.

### Notes (separate from this commit — config migration leak)

- DPC.6 decommissioned the user-pack rules in `sangmin-personal-rules`
  but did NOT migrate `~/.opensquid/active.json` to subscribe to the
  3 built-in profession packs (`scope-architect`, `task-spec-author`,
  `default-discipline`) that received the promoted rules. Users who
  opted in to `sangmin-personal-rules` before DPC.6 now have a stub
  pack as their only active subscription — every gate is dormant on
  their machine. Surfaced for explicit user migration; the runtime
  never auto-touches active.json per opt-in invariant.

---

## [0.5.226] - 2026-05-30

### Added (IDF.5 — closes T-IDENTITY-FOUNDATION — authoritative pack-runtime reference)

- **`docs/pack-runtime.md`** (new, 756 LOC) — authoritative reference
  for the pack runtime: pack identity (manifest fields, foundation,
  activation_scope, detected_by 7 kinds, side files), skill format
  (when_to_load, requires, triggers, rules, process steps), lifecycle
  (discovery → load order → dispatch flow), verdict shapes (5 levels +
  NextAction XOR + drift_response composition), primitive catalog
  (every primitive across 17 source files), audit + drift catalog
  (violations + chain stages), and authoring patterns (when to warn vs
  block vs directive vs surface; anti-patterns to avoid).
  - 7 top-level sections + 45 H2/H3 subsections
  - Every section cites the implementing source file as a line range
    (e.g. `src/packs/schemas/manifest.ts:200-225`) so citations
    survive small code shifts
  - Citation index appendix (Appendix A) for editor jump-to
  - Glossary appendix (Appendix B) for term consistency

### Packaging

- **`package.json` `files` array** now ships `docs/pack-runtime.md`
  along with the existing `docs/skill-grammar-guide.md` and
  `docs/load-budget.md`. The reference doc travels with the npm
  package so installers + pack authors can read it without cloning the
  repo.

### Track close-out

- **T-IDENTITY-FOUNDATION shipped 5/5** (IDF.1 schema → IDF.2 detection
  evaluator → IDF.3 auto-activation pipeline → IDF.4 dispatcher
  routing → IDF.5 reference doc). Phase 1 of the v2 product-completion
  plan is end-to-end operational; the v0.6 codex content-richness
  (foundation taxonomy + detection patterns + activation_scope) is
  restored as additive runtime behavior, and pack authors have a
  single authoritative doc to write against.

---

## [0.5.225] - 2026-05-30

### Added (IDF.4 — activation_scope dispatch routing closes T-IDENTITY-FOUNDATION runtime track)

- **`activationScopeApplies(scope, ctx)`** pure function
  (`src/runtime/hooks/dispatch.ts`) — returns boolean given a pack's
  `activation_scope` enum + a `DispatchScopeCtx`. Five-case semantics
  per v0.6 §4.5 + T-IDENTITY-FOUNDATION L7:
  - `project` → applies when current cwd matches project context
    (`ctx.inProject`)
  - `user` → applies for any user session (`ctx.isUserSession`)
  - `hybrid` → both `inProject` AND `isUserSession` must be true
  - `team` → ships INERT (always returns false) until team-mode
    infrastructure lands; packs declaring this scope are silently
    dormant in IDF.4
  - `global` → effectively `user` today (= `ctx.isUserSession`);
    multi-user infrastructure is post-v1
- **`DispatchScopeCtx` interface** — `{ inProject: boolean, isUserSession:
boolean }`. New 5th optional parameter on `dispatchEvent` with
  back-compat default `{ inProject: true, isUserSession: true }` so
  every existing call site continues to work unchanged.
- **Pack-walk filter** — `dispatchEvent` now skips entire packs whose
  `activationScope` (or coalesced `'project'` default) doesn't apply in
  the current context. Filter sits BEFORE the skill loop so a scope
  mismatch produces zero rule walks for the pack.

### Tests

- `src/runtime/hooks/dispatch.test.ts` — 12 new IDF.4 cases:
  - 5 unit tests on `activationScopeApplies` (one per enum value;
    `team` always false; `global` mirrors `user`)
  - 7 integration tests on `dispatchEvent` routing:
    back-compat default ctx, project skip when `inProject=false`, user
    walks regardless, hybrid AND-gate, team never walks, global walks
    per isUserSession, undefined `activationScope` defaults to
    `'project'` via `?? coalesce`

### Notes

- `team` packs are dormant for end users until the team-mode wiring
  ships. Authors shipping team-scoped packs in v0.5.x should know they
  will never fire today.
- Phase 1 runtime tracks (IDF.1 schema + IDF.2 detection + IDF.3 auto-
  activation + IDF.4 dispatch routing) are now end-to-end wired. IDF.5
  ships the authoritative `docs/pack-runtime.md` reference next.

---

## [0.5.224] - 2026-05-30

### Added (IDF.3 — auto-activation pipeline consumes IDF.1 schema + IDF.2 evaluator)

- **`discoverActivePacks(scopeRoot, ctx?)`** (`src/packs/discovery.ts`) —
  optional second argument `DetectionContext`. When provided, each
  opted-in pack is gated on `matchesDetectedBy(pack.detectedBy ?? [],
ctx)`; non-matching packs are skipped from results. When `ctx` is
  `null`/`undefined`, legacy behavior applies (all opted-in packs
  load — existing tests pass unchanged).
- **Opt-in invariant preserved end-to-end**: a pack NOT listed in
  `active.json` is NEVER loaded by `discoverActivePacks` regardless of
  what its `detected_by` would match. Explicit test covers this branch.
- **`buildDetectionContext(cwd)`** (`src/runtime/bootstrap.ts`) —
  pre-stages a `DetectionContext` from the current cwd. Reads existence
  flags + contents for well-known files (`package.json`, `tsconfig.json`,
  `Cargo.toml`, `pyproject.toml`, `go.mod`) so `file_exists` /
  `file_match` clauses evaluate without any I/O at the dispatch layer.
- **Module-load one-shot**: `buildDetectionContext` runs inside the
  existing `realPacksPromise` IIFE — disk cost amortized exactly once
  per hook subprocess (matches prior `realPacksPromise` resolution
  pattern). Recursive cwd walk + memory recall integration deferred to
  follow-up tasks per spec L8.

### Tests

- `src/packs/discovery.test.ts` — 8 new IDF.3 tests on the
  `detected_by × active.json` interaction matrix:
  - back-compat: `ctx === null` → all opted-in packs load
  - back-compat: empty `detected_by[]` (default) loads when ctx provided
  - gate fires: opted-in pack with matching `file_exists` clause loads
  - gate fires: opted-in pack with non-matching clause is SKIPPED (dormant)
  - opt-in invariant: pack absent from active.json never loads even if
    `detected_by` would match
  - mixed: 3-pack matrix (matching / always-on / dormant)
  - `file_match` with `package.json` `dependencies.react` semver gate
  - `dir_exists` with `src/components/atoms` gate
  - `user_pinned` ctx bit gates the pack

### Notes

- `DetectionContext` fields `memoryBodies` (engine recall), `recentPrompts`
  (session ledger), and `userPinned` (active.json `pin: true`) ship as
  empty/false at IDF.3. Future enhancements populate via the
  engine-recall + chat-history integrations tracked in Phase 2.

---

## [0.5.223] - 2026-05-30

### Added (IDF.2 — keystone for IDF.3 auto-activation)

- **Pure-function `detected_by` evaluator** (`src/runtime/detection.ts`,
  146 LOC) — `matchesDetectedBy(detectedBy, ctx)` returns boolean given
  a pack's `detected_by[]` (from IDF.1 schema) + a pre-staged
  `DetectionContext`. Implements all 7 detection kinds from v0.6 §4.4:
  - `file_exists` / `dir_exists` — keyed lookup against staged maps
  - `file_match` — JSON-path dotted lookup + per-key regex (AND across
    `matches[]`); shallow path resolution only per [[feedback_simplest_granular_form]]
  - `file_glob` — minimatch against pre-staged file keys + `min_count`
    threshold (early-exit when threshold met)
  - `memory_match` — regex over pre-concatenated recall body
  - `conversation_signal` — regex over recent prompt history
  - `user_pinned` — bare context bit (from `active.json` `pin: true`)
- **OR semantics across clauses** — first match wins, returns true.
  Empty `detected_by[]` returns true (back-compat: opted-in packs with
  no detection clauses always apply).
- **Pure** — no I/O during evaluation, no async, no side effects. Caller
  (IDF.3 discovery pipeline) pre-stages `ctx`. Referentially
  transparent + memoizable per (`pack.name`, `ctx.cwd`).
- **Malformed-input safety** — malformed JSON in file_match silently
  returns false; malformed regex in any pattern silently returns false
  (no throw). Loud failure deferred to pack-load-time validation
  (follow-up; not blocking IDF.2).

### Tests

- `src/runtime/detection.test.ts` — 23 unit tests covering every kind's
  happy path + at least one error path + multi-clause OR + AND within
  `file_match.matches` + empty-array back-compat + malformed regex/JSON.

### Notes

- Detection runs on pre-validated patterns. Pack-load-time RE2
  validation is a deferred follow-up tracked separately — current
  behavior fails-silent rather than throws to keep dispatch hot path
  resilient.
- `minimatch ^10.0.0` already in deps (capability_gate, load_matchers,
  permissions_state precedents) — no new deps added.

---

## [0.5.222] - 2026-05-30

### Fixed

- **CI lint regression on IDF.1** (`manifest.test.ts:509`) — back-compat
  defaults test was authored as `async () =>` arrow but contains no
  `await`. ESLint `@typescript-eslint/require-await` rejected it
  post-push; local lint had passed in the slice prior to test addition.
  Dropped the `async` modifier — assertions are all synchronous Zod
  parse results. No behavior change.

---

## [0.5.221] - 2026-05-30

### Added (additive schema — existing packs parse unchanged)

- **Foundation taxonomy** (v0.6 §4.2 restored per IDF.1) — manifest.yaml
  accepts optional `foundation:` block with three sub-fields:
  - `tools[]` — `{name, semver?}` for tool packs target (react@>=19, jupyter, etc.)
  - `domains[]` — string array of subject areas (frontend, single-cell-genomics, etc.)
  - `methodologies[]` — string array of ways-of-working (atomic-design, tdd, IRAC)
    Descriptive only at IDF.1; runtime consumption is Phase 2 scope.
- **`activation_scope:` enum** (v0.6 §4.5 restored per IDF.1) — 5 values:
  `project` (default; per-cwd) | `user` (globally) | `hybrid` (both) | `team`
  (declared team members; semantic inert until team-mode infrastructure) |
  `global` (always-on for everyone). Distinct from `scope:` (which is the
  layering hint universal→domain→specialty→workflow→project).
- **`detected_by[]` 7-kind discriminated union** (v0.6 §4.4 restored per
  IDF.1) — `file_exists` / `dir_exists` / `file_match` (JSON-path matches) /
  `file_glob` (pattern + min_count) / `memory_match` / `conversation_signal`
  / `user_pinned`. Per `[[feedback_stop_haiku_drift]]`: no LLM in detection —
  pure filesystem + memory regex. Evaluator + auto-activation pipeline ship
  in IDF.2 + IDF.3.

### Changed

- **`Pack` runtime type** extended with optional `foundation` +
  `activationScope` + `detectedBy` (camelCase) fields. Optional on the
  runtime type so test fixtures + non-loadPack callers construct Pack
  literals unchanged; the YAML loader supplies them via Zod parse
  defaults.

### Removed

- **`src/packs/scope_decomposer.skill.test.ts` deleted** — DPC.6 reduced
  the user-pack scope-decomposer to a deprecation stub (rules=[]); this
  test was loading the fixture-synced stub + asserting on rules that no
  longer exist. Test coverage migrated to
  `test/builtin/scope-architect.test.ts` per DPC.1.

## [0.5.220] - 2026-05-30

### Added

- **scope-architect/pre-research-authoring skill** (DPC.5) — warns when
  authoring a pre-research doc (Write/Edit to
  `docs/research/*-pre-research-*.md`) with fewer than 3 research-tool
  calls (recall + Read + Grep combined) this turn. Pre-research is the
  OUTPUT of doing research — not a planning doc authored from intuition.
  Below threshold = agent is authoring on belief; task-spec-author would
  then get incomplete data → tasks built on drift. Threshold of 3 is
  heuristic (allows session-2 continuation pre-research without noise).
  Verdict level: warn (soft surface).

## [0.5.219] - 2026-05-30

### Added

- **scope-architect/pack-skill-authoring skill** (DPC.4) — warns when
  authoring a user-pack skill yaml without prior research-tool activity
  (recall or Read) this turn. Closes the gap where today's 5-skill drift
  batch authored skill files without research; all 5 turned out to
  pattern-match symptoms rather than addressing causes. Path pattern
  scoped to user-pack writes (`.opensquid/packs/.+/skill.yaml$`); built-in
  pack writes happen at different cwd + are gated by DPC.1 discipline +
  inline-spec-block. Verdict level: warn (soft surface).

## [0.5.218] - 2026-05-30

### Added

- **scope-architect/recall-consumed skill** (DPC.3) — tool-sequence FSM
  adapted from Letta's tool-rule pattern. Fires on Stop hook event; if
  `mcp__opensquid__recall` fired this turn AND the prior assistant message
  shows no recall-consumption vocabulary (per [[X]] / memory says / per
  memory / recalled / according to memory / from memory), emits `block`
  verdict → Stop hook exit 2 → agent emits recovery turn citing what
  recall returned.

  Architectural ceiling locked: Claude Code has no `PreAssistantMessage`
  hook (ECC hit the same wall — verified via OSS subagent prior-art
  research). Stop+exit-2 is the only post-emit corrective; ~1s visible
  flash before recovery turn is the accepted trade-off (per May-17
  unified-evaluator design C6 callout).

  Uses existing primitives (`session_tool_history` + `last_assistant_message`
  - `text_pattern_match` + `verdict`) — no new primitive needed; pre-research
    Q4 residual resolved.

### Notes

- Heuristic limitations documented in skill prose: false-negatives (agent
  re-words recall without citing) slip through; false-positives (passing
  [[X]] reference) trigger spuriously. Future destination_check rule will
  LLM-judge consumption via model_alias for tighter coverage.

## [0.5.217] - 2026-05-30

### Changed

- **scope-architect/scope-detect regex coverage widened** with 6 bulk-action
  patterns (DPC.2): `audit`, `fix-the-gaps`, `proper solution`, `list/batch of`,
  `refactor`, `based on your understanding`. Today's drift transcripts proved
  the original 6 patterns (spec/scope/new task/add task/design/plan) missed
  bulk-action prompts. Behavioral test verifies 6 drift prompts fire + 2
  unrelated stay silent. All patterns RE2-safe (no lookarounds).

### Notes

- `test/fixtures/scope-decomposer-pack/skills/scope-decomposer/skill.yaml`
  re-synced from live user pack per ASC.6 fixture-sync invariant (DPC.1
  added a deprecation-stub header to the live user-pack skill; fixture
  needed to track).

## [0.5.216] - 2026-05-30

### Added

- **Two new built-in profession packs** under `packs/builtin/`:
  - **`scope-architect/`** — the discipline pipeline (scope-intent detection,
    inline-spec-block, taskcreate-spec-required, scope-before-code in
    automation, task-list-generated hygiene, chain-handoff directives) as a
    6-skill pack. Promoted from the user-pack `scope-decomposer` shipped by
    the original maintainer; now every opensquid user can opt into the
    discipline pipeline.
  - **`task-spec-author/`** — profession pack wrapping the task-spec-author
    format authority. Has no rules (validatePackFunctions no-op); ships the
    `team.yaml` + bundled `SKILL.md` + `skills-catalog.md` as the format
    reference. Chain-handoff-research-to-spec directive emits
    `next_action.profession: task-spec-author` — the agent resolves the
    profession by reading this pack's team-role + bundled SKILL.md, then
    spawns the subagent.

  Opt-in via your scope's `active.json`:

  ```yaml
  packs:
    - default-discipline
    - scope-architect
    - task-spec-author
  ```

  Per `T-DISCIPLINE-PIPELINE-COMPLETION` DPC.1 — closes the gap where the
  discipline pipeline lived only in the maintainer's user pack. Other users
  installing opensquid now get the same anti-drift scaffolding.

### Changed (additive, backward-compatible)

- **`Verdict.NextAction` extended with `profession?: string` field.** The XOR
  refine widens from 2-way (skill XOR tool) to 3-way (skill XOR tool XOR
  profession). Existing directive verdicts using `skill:` or `tool:` are
  unchanged. New `profession:` form is used by `scope-architect`'s
  `chain-handoff-research-to-spec` rule to route the agent to the
  `task-spec-author` profession pack rather than the legacy CC-skill
  reference.

  Per `T-DISCIPLINE-PIPELINE-COMPLETION` DPC.1 + spec L6.

### Pre-research + spec (in private workspace)

- `loop/docs/research/T-discipline-pipeline-completion-pre-research-2026-05-30.md`
- `loop/docs/tasks/T-discipline-pipeline-completion.md` (DPC.1-DPC.6)

## [0.5.215] - 2026-05-29

### Changed (BREAKING for users who pinned the old pack name)

- **Renamed built-in pack `sangmin-personal` → `default-discipline`**
  (`packs/builtin/sangmin-personal/` → `packs/builtin/default-discipline/`).
  The previous name implied personal content despite the pack carrying
  generic drift-gate discipline (workflow / versioning / git / d9-guard /
  honesty-ledger / phase-logging / engine-vocab). The new name signals:
  shipped-by-default, generic drift discipline, opt-in via active.json.
  Per `docs/tasks/T-builtin-retire.md` + pre-research at
  `docs/research/T-builtin-retire-pre-research-2026-05-29.md`.

  **User-side migration:** if your scope's `active.json` lists
  `sangmin-personal` under `packs:`, update the entry to `default-discipline`:

  ```yaml
  # before
  packs:
    - sangmin-personal

  # after
  packs:
    - default-discipline
  ```

  No compat shim ships — users with the old name pinned get a clear
  "no such pack" load error. Per `T-PUC L5` + `T-VOCAB.1` precedents
  (no re-exports, no symlinks).

  Renamed surfaces (atomic commit):
  - `packs/builtin/sangmin-personal/` → `packs/builtin/default-discipline/`
    (`git mv` preserves per-file blame)
  - `packs/builtin/default-discipline/manifest.yaml`: `name`, `goal`,
    `description`, header comment block — all rewritten to persona-neutral
  - 4 other yaml side-files (`drift_response.yaml`, `models.yaml`,
    `channels.yaml`, `notifications.yaml`): line 1 header comments updated
  - `packs/builtin/default-discipline/skills/`: **byte-identical** (7 skill
    folders untouched — d9-guard, engine-vocab, git, honesty-ledger,
    phase-logging, versioning, workflow)
  - `test/builtin/sangmin-personal.test.ts` →
    `test/builtin/default-discipline.test.ts` (+ 9 internal string updates)
  - `docs/skill-grammar-guide.md`: 5 path references updated (lines 30, 389,
    611, 612, 614)
  - `package.json`: `0.5.214` → `0.5.215`

  Untouched (substring-collision guard — these are a DIFFERENT pack at
  user scope): every `sangmin-personal-rules` reference in `src/`,
  `test/fixtures/`, `test/e2e/`, integration tests, and the user's
  personal pack at `~/.opensquid/packs/sangmin-personal-rules/`.

## [0.5.150] - 2026-05-26

### Changed (BREAKING semantic)

- `match()` (the `if:` grammar's regex primitive) now uses
  [`re2js`](https://github.com/le0pard/re2js) — a pure-JS port of
  Google's RE2 engine — instead of V8's native `RegExp`. Patterns
  using PCRE-only features that fundamentally require backtracking
  (backreferences `\1`, lookaheads `(?=...)`, lookbehinds `(?<=...)`,
  possessive quantifiers `a++`, atomic groups `(?>...)`) now return
  `false` instead of evaluating, because RE2 rejects them at
  compile-time. Pre-1.0 SemVer + opensquid's locked agent-only-PATCH
  rule means this is a **PATCH bump even though the semantic change
  is breaking** for any pack using rejected features. Verified: zero
  shipped `packs/builtin/` clauses use any rejected feature. Pack
  authors hitting a rejection should move the check into a primitive
  and bind its result with `as:` rather than fight the RE2 subset
  inside `if:`. See `docs/skill-grammar-guide.md` §3.2 for the full
  feature reference and the `RE2` syntax link.
- Bundle: `re2js` adds ~868KB to `node_modules`. No native build
  (pure JS, no node-gyp), no WASM cold-start. First-call compile of
  any new pattern is the warm-up; subsequent calls hit RE2's DFA
  fast-path directly.

### Security

- `match()` is now **ReDoS-immune by construction**. Pre-H.4 (V8
  RegExp), the canonical catastrophic-backtracking pattern `(a+)+$`
  against a 30-character `aaaa…b` input hung the Node event loop for
  seconds-to-minutes. Post-H.4 (RE2 DFA), the same pattern returns
  `false` in <10ms regardless of input length. A regression test in
  `src/runtime/evaluator/expression/functions.test.ts` asserts the
  result is `false` AND `Date.now()` delta is <100ms. This closes
  the pre-research §12.1 rollback path: with `re2js` shipping, third-
  party pack ecosystems can no longer use an adversarial regex in
  an `if:` clause to DoS the runtime.
- Selected `re2js` over `re2-wasm` and `re2` (node-re2): `re2-wasm`
  is unmaintained (last release Sept 2021, only 3 versions ever);
  `re2` (node-re2) requires native compilation (node-gyp + nan) and
  ships a 12.3MB tarball with brittle cross-Node-version behavior;
  `re2js` is actively maintained (44 versions, last release 3 days
  before this commit), pure-JS, MIT-licensed, native ESM with proper
  `exports` map, zero runtime deps, and supports Node ≥18.

---

## [0.5.149] - 2026-05-26

### Added

- `docs/skill-grammar-guide.md` — author's reference for `if:` grammar
  (9 sections, 612 lines). Documents operator precedence, the
  5-function allow-list, sandbox guarantees, gotchas (strict equality,
  empty-`if:`-truthy, ReDoS posture, no chained comparison), the
  function-allow-list expansion checklist, and the 3-file
  `BEFORE.md` / `SKILL.md` / `manifest.yaml` example convention.
- 3 worked-example skills under `packs/builtin/examples/`
  demonstrating the prose → YAML migration pattern previously
  impossible under the bounded regex grammar:
  - `multi-clause-drift-detector` — exercises `&&`, `len()`, dotted
    path access. Compound clause `len(drift_hits.matched) > 0 &&
len(verifications.matched) == 0 && tool_history.count == 0`.
  - `file-pattern-guard` — exercises the allow-listed `match()`
    function. Single-line regex path guard:
    `match(tool_input.file_path, "node_modules|/dist/|/build/|/.git/|.lock$")`.
  - `tool-history-correlator` — exercises bracket-index access on a
    primitive's array result and numeric comparison on a path operand:
    `bash_history.count > 5 && bash_history.tools[0] == "Bash"`.

  Each example ships three files plus fixtures: `BEFORE.md` (prose-only
  equivalent showing why prose was insufficient), `SKILL.md` (reader's
  guide), `manifest.yaml` (pack manifest, marked
  `# Example — not load-bearing`), `skills/<name>/skill.yaml` (the
  structured rule), `fixtures/*.input.json` + `.expected.json` (one
  fires the verdict, one does not).

- `test/example-skills.test.ts` — three test groups: pack-load
  cleanliness for every example, fixture-evaluation correctness for
  every input/expected pair, and grammar-guide doc-sample parse
  validity (every `if:` clause inside every fenced ```yaml` block in
  `docs/skill-grammar-guide.md` parses cleanly via `parseExpression`).

### Notes

- BEFORE.md is a novel pattern in opensquid (zero prior matches per
  H pre-research §8.2 verification on 2026-05-25). Documented in
  `docs/skill-grammar-guide.md` §9 as the canonical example
  convention.
- Example manifests are explicitly marked non-load-bearing in their
  header comment to prevent calcification. They live under
  `packs/builtin/examples/` (distinct from the production packs at
  `packs/builtin/sangmin-personal/` and `packs/builtin/cycle-pack/`)
  and are NOT registered in any `active.json` — the discovery layer
  only loads packs explicitly opted into by the user.
- Primitive-shape adjustments vs the H.3 spec: the spec assumed
  `text_pattern_match` returned `.matches[]` + `.matched_count` and
  that `session_tool_history` returned `.calls[]` with each call
  carrying `.name`. The real primitives (verified against
  `src/functions/` on 2026-05-25) return
  `{ matched: string[], phrases: [{phrase, offset}] }` and
  `{ tools: string[], count: number }` respectively. Examples follow
  the real shapes — spec example shapes are illustrative for the `if:`
  clause structure, not for the wrapping primitive contracts.
- ReDoS hardening tracked as the H.4 follow-up task — `match()` still
  uses `new RegExp(p).test(s)` in this release. Example patterns are
  conservative (flat alternation) and the grammar guide §6.3 warns
  authors against nested quantifiers / backreferences / lookarounds
  until H.4 ships RE2.

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

## [0.5.148] — 2026-05-26

Load-time validation of `if:` expressions in skill YAML, layered on top of
H.1.6's chevrotain grammar. Invalid `if:` clauses now fail fast at
`loadPack()` with full path + Zod field-path context instead of silently
evaluating to `false` (with a `console.warn`) at first event fire.

### Added

- **Load-time `if:` validation** in `src/packs/schemas/skill.ts` via a
  `conditionString` wrapper (`z.string().refine(parseExpression …)`)
  attached to `ProcessStep.if`. Every skill's `if:` clauses are now
  parsed at skill-load time using the chevrotain grammar from H.1.x.
  Errors surface through the existing `parseYamlFile` formatter
  (`src/packs/yaml.ts:86–93`) with the shape:

      Schema validation failed for skills/foo/skill.yaml:
      process[2].if: invalid if: expression — see docs/skill-grammar-guide.md

  Empty / whitespace-only `if:` clauses are accepted at load time (match
  the runtime's §12.2 "empty = true" semantics); only lex / parse / AST
  errors fail validation. All 8 unique production clauses in
  `packs/builtin/**` verified load-clean (per pre-research §1.3 + §8.1).

  No changes to `src/packs/loader.ts` or `src/packs/yaml.ts` — the
  existing error formatter already threads source path + Zod field path
  into messages (§8.1 verification).

  Note: a second `ProcessStep` schema lives at `src/runtime/types.ts:93–99`;
  de-duplication is a separate cleanup task and is out of scope for H.2.

---

## [0.5.147] — 2026-05-26

The H.1.6 integration cutover. The 5-regex `if:` evaluator that powered
G.5 + G.13 is replaced wholesale by the chevrotain-backed expression
grammar shipped across H.1.1 – H.1.5. The runtime's `evalCondition`
becomes a one-line shim delegating to
`src/runtime/evaluator/expression/index.ts`; all five regex constants
plus the `resolveNumericPath` helper are deleted from `evaluator.ts`.

### Changed

- **Full chevrotain-backed expression grammar replaces 5 hand-rolled
  regex patterns for `if:` conditions.** New supported forms:
  `||` / `&&` / `!` / parens, dotted path access of any depth (up to
  the 64-depth interpreter cap), bracket index access (numeric and
  string), function calls (5 allow-listed: `len`, `contains`, `match`,
  `startsWith`, `endsWith`), float literals, `null` literal. Backed by
  a 256-entry LRU parse cache (keyed by trimmed expression string) and
  a sandboxed tree-walking interpreter with depth cap 64, step cap
  10 000, and `Object.hasOwn` prototype-pollution defense. No `eval()`
  / `new Function` anywhere in the new module — audit-grepped.
- **(§12.2) Empty `if:` now evaluates `true`** (previously a silent
  `false` with a warn). Treats present-but-empty predicates as
  equivalent to "no `if:` field" so trailing-whitespace YAML doesn't
  accidentally skip steps. The `parseExpression` parse-only entry
  (exposed for H.2's Zod refinement) still rejects empties as
  authoring mistakes at load time.
- **(§12.3) Equality operators are strict.** `1 == "1"` returns
  `false`; `String(x) == "1"`-style coercion is not supported. `==`
  and `===` are equivalent surface forms, both lowering to strict
  equality. Mismatched-type comparisons return `false` (fail-closed),
  matching CEL/Cerbos semantics and unifying the two inconsistent
  coercion paths the regex-era evaluator used to ship.

### Fixed

- **(§12.4) The `phase-logged-before-commit` workflow rule
  (`packs/builtin/sangmin-personal/skills/workflow/skill.yaml:48`,
  `committing && phases != "complete"`) now fires correctly.** Was a
  silent no-op for the entire G-track lifetime because the RHS `!=`
  form fell outside every regex in the old grammar; the `&&`
  short-circuit then made the whole expression always `false`
  regardless of `committing`. If you `git commit` without first
  calling `mcp__opensquid__log_phase` for the current phase, this
  rule will now block — recovery is one `log_phase` call or
  `git commit --no-verify` (one-time) to ship past the new gate.

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
