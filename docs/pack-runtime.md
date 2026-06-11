# Pack runtime — authoritative reference

Version: 0.5.293 · Last updated: 2026-06-03 · Spec: T-IDENTITY-FOUNDATION (IDF.1–IDF.5) + T-PACK-FSM-STANDARDIZATION (FSM engine, `fsm.yaml`, `guards:`, `read_fsm_state`/`advance_fsm`)

This document is the authoritative reference for the opensquid pack
runtime: how a pack is identified on disk, what it can declare, how
the dispatcher loads + walks it, what verdicts it can emit, and which
primitives its rules can call.

Pack authors should treat this document as the **contract for what's
shipped**. Source code is the canonical truth, but this doc collects
the schema + lifecycle + primitive catalog in one place so an author
doesn't have to spelunk through `src/packs/` and `src/functions/` to
understand what a pack can do.

> **File:line citations** use line _ranges_ rather than exact lines so
> they survive small code shifts. Always cross-check against the
> current source if you're chasing a specific symbol.

Cross-references:

- `docs/skill-grammar-guide.md` — companion doc for the `if:`
  expression grammar (loaded via the same evaluator that walks
  `process:` steps).
- `docs/load-budget.md` — companion doc for the load-side cost
  budget pack authors should respect.
- `docs/pack-fsm-architecture.md` — companion doc for the pack-FSM
  stack (`fsm.yaml` lifecycle, the generic total-transition engine, the
  `read_fsm_state`/`advance_fsm` primitives, and the `guards:` gate
  template). This doc documents the schema/loader/primitive surface;
  pack-fsm-architecture.md is the all-levels conceptual walkthrough.

---

## 1. Pack identity

A pack is a directory under `<scope-root>/packs/<name>/` containing:

```
packs/<name>/
  manifest.yaml           # required — pack identity + activation
  skills/                 # required — one folder per skill
    <skill-name>/
      skill.yaml          # required — skill rules
  fsm.yaml                # optional — pack-lifecycle FSM (auto-loaded by name; see 1.13)
  chat_agent.yaml         # optional — chat-bridge agent identity
  models.yaml             # optional — model aliases for LLM primitives
  channels.yaml           # optional — chat channel registry
  notifications.yaml      # optional — notification routing
  drift_response.yaml     # optional — per-rule drift policies
  team.yaml               # optional — marker file for profession packs
```

### 1.1 `manifest.yaml` fields

Schema: `src/packs/schemas/manifest.ts:1-360` · Loader fold:
`src/packs/loader.ts:80-130`. The loader applies Zod defaults at parse
time, so every field below has a deterministic value at runtime even
when omitted from disk.

| Field                | Type     | Default     | Purpose                                                        |
| -------------------- | -------- | ----------- | -------------------------------------------------------------- |
| `name`               | string   | required    | Pack name, must match folder name                              |
| `version`            | semver   | required    | Pack version (independent of opensquid version)                |
| `scope`              | enum     | required    | Layering precedence (see 1.6)                                  |
| `goal`               | string   | required    | One-line statement of what the pack does                       |
| `description`        | string   | `''`        | Longer description                                             |
| `requires`           | string[] | `[]`        | Other packs this depends on (by name)                          |
| `conflicts`          | string[] | `[]`        | Other packs this conflicts with (by name)                      |
| `evolves`            | bool     | `true`      | Whether lessons can mutate this pack's skills                  |
| `activation_scope`   | enum     | `'project'` | WHO the pack applies to (see 1.3)                              |
| `detected_by`        | array    | `[]`        | WHEN the pack auto-activates (see 1.4)                         |
| `foundation`         | object   | absent      | Taxonomy block — tools/domains/methodologies (see 1.2)         |
| `chat_agent_ref`     | string   | absent      | Reference to chat_agent.yaml (see 1.5)                         |
| `models_ref`         | string   | absent      | Reference to models.yaml (see 1.5)                             |
| `channels_ref`       | string   | absent      | Reference to channels.yaml (see 1.5)                           |
| `notifications_ref`  | string   | absent      | Reference to notifications.yaml (see 1.5)                      |
| `drift_response_ref` | string   | absent      | Reference to drift_response.yaml (see 1.5)                     |
| `team_ref`           | string   | absent      | Reference to team.yaml (profession marker)                     |
| `kind`               | enum     | `'focused'` | Pack type (see 1.7) — `'focused' \| 'composite'`               |
| `usage`              | enum     | `'active'`  | Load mode (see 1.7) — `'active' \| 'profession' \| 'both'`     |
| `includes`           | array    | `[]`        | Composite-only — `{pack_id, semver}` entries (see 1.7)         |
| `seed_lessons`       | array    | `[]`        | Pack-author knowledge ingest (see 1.10)                        |
| `verify_gates`       | array    | `[]`        | Declarative author gates → synthetic `<pack>/verify` (1.11)    |
| `guards`             | array    | `[]`        | Reusable detect→verdict gate template → `<pack>/guards` (1.13) |

(The `fsm.yaml` lifecycle is NOT a `manifest.yaml` field — it is a side file
auto-loaded by filename and folded onto the runtime `Pack` as `pack.fsm`; see
§1.5 + §1.13.)

The schema is `.strict()` — unknown keys at the top level are
rejected at load time so typos surface loudly rather than silently
no-op.

### 1.7 `kind` / `usage` / `includes` (MM.1 + MM.2 + MM.3 + MM.4)

Schema: `src/packs/schemas/manifest.ts:287-305` (enums + CompositeInclude)

- `:330-365` (Manifest superRefine). Loader: `src/packs/loader.ts:110-150`
  (team.yaml load + folds). Resolver: `src/packs/composite_resolver.ts`.

**Pack kind semantics (MM.1):**

- **focused** — own content + own foundation + own detected_by. The
  canonical pack shape. All pre-MM.1 packs default to focused.
- **composite** — pure aggregator with no own content. MUST have
  non-empty `includes:`; MUST NOT declare `foundation`. References
  focused packs via `{pack_id, semver}` entries; the loader expands
  these at discovery time (§3.1). Composite packs appear in the
  loaded-pack list alongside their expanded includes (for audit
  identity); when the dispatcher walks, it traverses the focused packs
  (composites have no own skills to walk).

**Pack usage semantics (MM.1 + MM.2):**

- **active** — pack loads into the parent agent's mind via discovery +
  dispatcher walks its skills on every event. Pre-MM.1 default.
- **profession** — pack does NOT load actively; SPAWNED as a subagent
  via the `spawn_subagent` primitive when a directive's
  `next_action.profession` references it. REQUIRES `team.yaml` with
  ≥ 1 role (loader enforces existence + parse).
- **both** — eligible for either path. Most shipped profession packs
  (scope-architect, pack-architect) use `both` so they fire actively
  when opted-in AND can be spawned on demand.

**`includes:` shape:**

```yaml
includes:
  - pack_id: scope-architect
    semver: '>=0.1.0'
  - pack_id: pack-architect
    semver: '^0.1.0'
```

Semver ranges follow the standard `semver` npm syntax. Load-time
resolution validates each include against the discovered pack registry
(see §3.1 for the 5 error codes).

**Profession spawn (MM.2 + MM.3 + MM.4):** when a rule emits a
`directive` verdict with `next_action.profession: <name>`, the
dispatcher validates the named pack exists, has `usage: profession|both`,
and has a loaded team.yaml (see §3.4 for the 5 error codes + the
no-agent-loop invariant — opensquid emits the directive, the agent
invokes `spawn_subagent`).

### 1.2 `foundation:` taxonomy (IDF.1)

Schema: `src/packs/schemas/manifest.ts:200-225`. Optional descriptive
block declaring what a pack knows about. Runtime treats it as
metadata in IDF.1 — Phase 2 multi-mode addressing will consume it
for taxonomic matching.

```yaml
foundation:
  tools:
    - { name: react, semver: ^19 }
    - { name: typescript, semver: ^5.4 }
  domains:
    - frontend
    - state-management
  methodologies:
    - atomic-design
    - test-driven-development
```

- `tools[]` — `{name, semver?}` entries. `semver` is freeform string
  (the runtime doesn't currently parse it; Phase 2 will).
- `domains[]` — free-text strings; pack-architect's discovery uses
  these.
- `methodologies[]` — free-text strings.

All three sub-fields default to `[]`. Omitting the whole `foundation:`
block is fine — the field is `Foundation.optional()` at the schema
layer.

### 1.3 `activation_scope:` (IDF.1 + IDF.4)

Schema: `src/packs/schemas/manifest.ts:227-235`. Dispatcher routing:
`src/runtime/hooks/dispatch.ts:168-210` (`activationScopeApplies`).

Distinct axis from `scope:` — `scope:` is **layering precedence**
(universal → domain → specialty → workflow → project for sort
ordering), `activation_scope:` is **WHO the pack applies to** for
dispatch routing.

| Value     | When applies                                                       | Notes                                                                                                                |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `project` | When `ctx.inProject` (default — matches today's implicit behavior) | Pack only fires in projects where it's been opted in                                                                 |
| `user`    | When `ctx.isUserSession` (always true today)                       | Per-user, regardless of cwd                                                                                          |
| `hybrid`  | When BOTH `inProject` AND `isUserSession`                          | Project + user signals must coincide                                                                                 |
| `team`    | Always **inert**                                                   | Ships semantic; will fire when team-mode infrastructure lands. Packs declaring `team` are silently dormant in v0.5.x |
| `global`  | When `ctx.isUserSession` (today, equivalent to `user`)             | Distinguishable from `user` only when multi-user infrastructure lands (post-v1)                                      |

Default: `'project'` (Zod default — packs that omit `activation_scope:`
behave identically to today's per-cwd loading).

### 1.4 `detected_by[]` (IDF.1 + IDF.2 + IDF.3)

Schema: `src/packs/schemas/manifest.ts:237-310` (7-kind discriminated
union). Evaluator: `src/runtime/detection.ts:50-145`
(`matchesDetectedBy`). Auto-activation: `src/packs/discovery.ts:50-100`
(per-pack gate).

A pack lists detection clauses that the runtime evaluates against the
current cwd + memory + prompts. **OR semantics across clauses**: first
clause that matches wins. **Empty array** (or omitted block) → always
matches (back-compat).

**Opt-in invariant**: a pack must STILL be listed in `active.json` to
load. `detected_by` gates WHEN among opted-in packs; it never causes
silent installs.

The 7 kinds:

| Kind                  | Required fields                       | Semantic                                                                                                           |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `file_exists`         | `path`                                | True iff `ctx.files[path] === true`                                                                                |
| `dir_exists`          | `path`                                | True iff `ctx.dirs[path] === true`                                                                                 |
| `file_match`          | `path`, `matches: {jsonPath → regex}` | Parse JSON at `path`; for each `matches[]` entry, resolve dotted JSON path + regex-test the value. AND across keys |
| `file_glob`           | `pattern`, `min_count` (default 1)    | Count files in `ctx.files` matching the minimatch pattern; true iff ≥ `min_count`                                  |
| `memory_match`        | `pattern`                             | RegExp test against `ctx.memoryBodies`                                                                             |
| `conversation_signal` | `pattern`                             | RegExp test against `ctx.recentPrompts`                                                                            |
| `user_pinned`         | (none)                                | True iff `ctx.userPinned`. **⚠ CURRENTLY INERT** — see caveat below                                                |

```yaml
detected_by:
  - kind: file_exists
    path: package.json
  - kind: file_match
    path: package.json
    matches:
      'dependencies.react': "\\^19"
  - kind: dir_exists
    path: src/components/atoms
  - kind: file_glob
    pattern: '**/*.tsx'
    min_count: 3
```

**⚠ `user_pinned` is currently inert — never gate a pack solely on it.**
`ctx.userPinned` is not yet populated (`bootstrap.ts` `buildDetectionContext`
leaves it `false`, deferred to a later phase). Because the real loader passes a
non-`null` `ctx`, a pack whose ONLY `detected_by` clause is `user_pinned` fails
its detection gate and is **silently excluded even when listed in `active.json`**
(this is exactly the EWG.3.1 bug that disabled `scope-fsm`/`workflow-fsm`). For a
pack that should load purely on opt-in, declare NO `detected_by` block — an empty
array always matches (`discovery.ts:194`). Opt-in via `active.json` IS the pin.

**No LLM in detection.** All 7 kinds are pure regex / filesystem /
prompt-substring matches. Per `feedback_stop_haiku_drift` L4 — LLM
calls in the hot path break determinism + cost predictability.

**Malformed-input safety**: malformed JSON in `file_match` silently
returns false; malformed regex returns false. Pack-load-time RE2
validation is a deferred follow-up.

### 1.5 Side files

Most side files are referenced from `manifest.yaml` via a `*_ref:`
field naming a file in the same pack directory. The loader reads +
validates each via its own Zod schema; failures throw with a
path-bearing error so authors can fix the config.

| Side file             | Schema                                | Purpose                                                                         |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `chat_agent.yaml`     | `src/packs/schemas/chat_agent.ts`     | Chat-bridge identity (display name + persona)                                   |
| `models.yaml`         | `src/packs/schemas/models.ts`         | Model aliases (e.g. `reasoning` → vendor model id) — keeps source model-neutral |
| `channels.yaml`       | `src/packs/schemas/channels.ts`       | Chat channel registry (project-bridge mapping)                                  |
| `notifications.yaml`  | `src/packs/schemas/notifications.ts`  | Notification routing rules                                                      |
| `drift_response.yaml` | `src/packs/schemas/drift_response.ts` | Per-rule drift policy + corrective_skills (see §4.3)                            |
| `team.yaml`           | `src/packs/schemas/team.ts`           | Profession-pack marker (`role:` + `skills_catalog:`)                            |
| `fsm.yaml`            | `Fsm` in `src/runtime/fsm.ts`         | Pack-lifecycle FSM (see §1.13). **Auto-loaded by filename — NO `*_ref`.**       |

**`fsm.yaml` is the exception to the `*_ref:` rule.** It is read by
fixed filename (`loader.ts:199` `loadOptionalFsm`), validated for totality
(`validateFsm`), and folded onto the runtime `Pack` as `pack.fsm`
(`types.ts:415`). Absent file → `pack.fsm` is `undefined`; the FSM primitives
then return `null` (no machine to walk).

### 1.6 `scope:` (layering precedence)

Schema: `src/packs/schemas/manifest.ts` (Scope enum). Distinct from
`activation_scope:` (§1.3). Five layers, descending precedence:

1. `universal` — discipline that applies to every domain
2. `domain` — domain-specific knowledge (e.g. all frontend work)
3. `specialty` — narrower domain (e.g. atomic-design within frontend)
4. `workflow` — process discipline (e.g. test-driven workflow)
5. `project` — project-local rules

`sortPacksByScope` (`src/packs/load_order.ts`) orders the loaded pack
list by `scope` precedence (universal first), then alphabetically by
name within a scope. First-match short-circuit in the dispatcher means
higher-precedence packs' verdicts win.

### 1.8 `base_version` + `personal_revision` — living-pack state (LP.1 + LP.3)

A **living pack** consists of two layers:

- **`base_version`** (immutable semver) — set once at install from the
  vanilla source's `manifest.yaml#version`. NEVER mutated by the engine
  after install. The anchor point for 3-way merges on subsequent vanilla
  upgrades (see §3.5).
- **`personal_revision`** — monotonic counter + per-lesson YAML files at
  `~/.opensquid/packs/<id>/personal_revision/`. Grown by the
  wedge-promote pipeline (LP.3) on each Stage 2 lesson promotion. Each
  lesson is stored as `lesson_<n>.yaml` with `n` monotonic from 1.

State file: `version.json` at `<state-dir>/personal_revision/version.json`:

```json
{
  "base_version": "1.2.3",
  "personal_revision_id": 5,
  "last_merged_vanilla": "1.2.3"
}
```

`last_merged_vanilla` records the most recent vanilla version
successfully 3-way-merged against (or `null` if never upgraded). The
upgrade gate (`checkAndMergeUpgrades`) compares this against the
current vanilla `manifest.version` to decide whether to fire LP.2's
merger.

Helpers: `readVersionJson` / `writeVersionJson` / `readLessonFiles` /
`appendLessonFile` / `initPersonalRevision` /
`persistPromotedLesson` in `src/packs/personal_revision.ts:1-220`.
All writes go through atomic `<file>.tmp.<pid>.<rand>` + `fs.rename`.

### 1.9 Pack export modes (LP.4)

`opensquid pack export <name> --mode <m>` ships a pack as a directory
(or `.tgz` in v1.5+) with one of these stripping policies:

| Mode                     | Memory citations           | Memory bodies   | Use case                  | Status          |
| ------------------------ | -------------------------- | --------------- | ------------------------- | --------------- |
| `lessons-only` (DEFAULT) | Stripped (regex)           | Dropped         | Safe peer-sharing path    | v1              |
| `raw`                    | Preserved verbatim         | Preserved       | Local self-backup only    | v1              |
| `with-evidence`          | Re-mapped `mem-export-<n>` | Included inline | Trusted team/org transfer | v1.5 (deferred) |

Stripping is regex-based, deterministic, no LLM calls per
[[feedback_stop_haiku_drift]]. See `src/cli/pack.ts:buildExportCommand`.

### 1.10 `seed_lessons:[]` — pack-author knowledge ingest (DOG.3 + DOG.4)

Optional array on `manifest.yaml`. Each entry is ingested into the
engine's lessons table at load time via `engine.lessonCreate({
authored_by: 'pack', pack_id, external_id, seed_as_promoted: true })`.

```yaml
seed_lessons:
  - title: 'Server Components by default; "use client" only at the leaf'
    body: |
      In React 19, every component defaults to server-render. Add
      "use client" at the leaf where interactivity is genuinely required.
    scope: user # or 'global'
    tags: [react-19, server-components, performance]
    source: 'https://react.dev/reference/rsc/server-components'
```

Contract:

- **Idempotent re-ingest** — `external_id = pack-seed:<sha256(<pack>@<version>|<title>).slice(0,24)>`.
  Engine returns `updated: true` for an UPSERT hit; `false` for a new
  row. Re-running `loadPack` after a manifest edit re-ingests only the
  delta (entries with new title text or new pack version).
- **Eviction-immune** — `authored_by: 'pack'` mirrors the user-authored
  immunity contract per [[feedback_user_authored_lessons_immune]].
  The engine refuses `delete(force)` on these rows.
- **Promoted-on-ingest** — `seed_as_promoted: true` bypasses the
  pending → promoted gate so seed knowledge is recall-eligible from the
  first session.
- **Fire-and-forget failure handling** — per-seed RPC errors are
  COLLECTED, never thrown. A missing or down engine does NOT block pack
  load; seeds are simply absent from recall until the next loadPack
  with an engine present.

Schema: `SeedLesson` in `src/packs/schemas/manifest.ts`. Ingest
implementation: `src/packs/seed_lessons_ingest.ts`. The runtime Pack
type hoists `seedLessons?: SeedLesson[]` so downstream consumers
(audit-trail, future fixture sync) can read without re-parsing YAML.

### 1.11 `verify_gates:[]` — declarative author gates (DOG.3 + DOG.4)

Optional array on `manifest.yaml`. Each entry compiles at load time
into one `TrackCheckRule` whose process is a single `verdict` primitive
call gated by the gate's `check` if-expression. The compiled rules are
grouped under a synthetic skill named `<pack>/verify` with triggers
derived from each gate's `when.event_kind`.

```yaml
verify_gates:
  - name: no-rm-rf
    when:
      event_kind: tool_call
    check: 'contains(tool_args.command, "rm -rf")'
    on_fail:
      level: block
      message: |
        BLOCKED: `rm -rf` is too destructive.
```

Contract:

- **Pre-parse validation** — every `check` expression is run through
  `parseExpression` at load time. A malformed expression throws at
  `loadPack` with the offending gate name (no silent skipping).
- **5-fn allow-list** — `check` uses `len` / `contains` / `startsWith`
  / `endsWith` / `match`. Identifiers reference bindings the dispatcher
  populates from the event (e.g. `tool_args.command`, `prompt`).
- **Synthetic skill provenance** — compiled rule ids follow the
  `gate:<gate-name>` pattern so drift-catalog greps can attribute the
  verdict to its source gate.
- **Trigger dedup** — multiple gates on the same `event_kind` produce
  ONE trigger entry on the synthetic skill.
- **Tool-name filtering belongs in the check expression** — the
  `tool_call` `Trigger` variant in `event.ts` carries no per-trigger
  `tool_match` field; use `match(tool, "^Bash$") && ...` inside the
  `check` instead.

Schema: `VerifyGate` + `VerifyGateWhen` in `src/packs/schemas/manifest.ts`.
Compiler: `src/packs/verify_gates_compiler.ts`.

### 1.12 `livingVersion` runtime field (DOG.5)

The loader folds the per-pack `personal_revision/version.json` shape
(LP.1) into a single convenience triple on the runtime `Pack`:

```ts
pack.livingVersion; // {base: string, revision: number} | undefined
```

- `base` — semver string the pack was installed at (immutable per LP.1).
- `revision` — monotonic count of promoted lessons; 0 for a fresh install.
- `undefined` — pack isn't user-installed (built-in pack with no
  `~/.opensquid/packs/<id>/` state dir).

Read API: `getLivingPackVersion(packId): Promise<LivingPackVersion |
null>` in `src/packs/living_pack.ts`. Honors `OPENSQUID_HOME` env
override (test seam wired through LP.3's `resolvePackStateDir`).

### 1.13 `guards:[]` — reusable detect→verdict gate template (T-PACK-FSM-STANDARDIZATION slice B)

Optional array on `manifest.yaml`. A guard is the compressed form of the
recurring "inspect the event, then emit a verdict if a condition holds" pattern —
the generalization of §1.11's `verify_gates`. Each guard compiles at load time
into a `TrackCheckRule` (a `detect` step when present, then a gated `verdict`
step) under a synthetic skill named `<pack>/guards`, triggered on the guard's
`on:` event kind.

```yaml
guards:
  - name: no-rm-rf
    on: tool_call # tool_call | prompt_submit | stop | session_end (default tool_call)
    detect: # optional — a primitive call whose result binds to `as`
      call: tool_args
    as: targs # binding name for the detect result (default `hit`)
    when: 'contains(targs.command, "rm -rf")' # if-expression; the verdict condition
    level: block # warn | block
    message: |
      BLOCKED: `rm -rf` is too destructive.
```

Schema: `Guard` + `GuardDetect` in `src/packs/schemas/manifest.ts:452-479`.
Compiler: `src/packs/guards_compiler.ts` (`compileGuards`). Loader fold:
`src/packs/loader.ts:130`.

Contract:

- **`detect` is optional.** With `detect`, the named primitive runs first and its
  result binds to `as` (default `hit`); `when` typically references that binding.
  Without `detect`, `when` is a standalone check (the `verify_gates` case) — the
  two features share the same compile target.
- **Pre-parse validation** — every `when` expression runs through the compiler's
  `parseExpression` at load time; a malformed expression throws at `loadPack` with
  the offending guard name (fail-loud, same as `verify_gates`).
- **`guards:` vs `verify_gates:`** — `verify_gates` is the `when`-only special
  case (no `detect` step, `event_kind` nested under `when:`); `guards` adds the
  optional `detect` step + a flat `on:` field. New packs should prefer `guards:`;
  `verify_gates:` stays for back-compat.
- **`guards:` vs hand-written skills** — a guard is for the common
  single-detect-then-verdict shape. A rule needing multiple primitive calls,
  branching, or state reads still warrants a hand-written `skill.yaml`.

---

## 2. Skill format

A skill lives at `packs/<name>/skills/<skill-name>/skill.yaml`.

### 2.1 `skill.yaml` fields

Schema: `src/packs/schemas/skill.ts:285-330`.

| Field          | Type              | Default                 | Purpose                                                             |
| -------------- | ----------------- | ----------------------- | ------------------------------------------------------------------- |
| `name`         | string            | required                | Skill name (must be unique within the pack)                         |
| `load`         | enum              | `'lazy'`                | `'preload'` keeps skill resident; `'lazy'` loads per `when_to_load` |
| `when_to_load` | Matcher[]         | `[]`                    | When a `lazy` skill loads (see 2.2)                                 |
| `requires`     | SkillRequires[]   | `[]`                    | AND-preconditions evaluated at dispatcher (see 2.3)                 |
| `unloads_when` | UnloadCondition[] | `[]`                    | When a dynamic skill unloads (idle ticks, etc.)                     |
| `triggers`     | Trigger[]         | `[{kind: 'tool_call'}]` | Which Event kinds wake this skill (see 2.4)                         |
| `rules`        | Rule[]            | required                | The skill's actual logic (see 2.5)                                  |

### 2.2 `when_to_load:` matchers

Schema: `src/runtime/load_matchers.ts:50-180`. Each matcher is a
discriminated-union variant; the skill loads when ANY matcher
matches the current event/context.

Common matcher kinds (full list in `load_matchers.ts`):

- `event_type` — `{event_type: 'prompt_submit'}` matches any
  prompt-submit event
- `tool_used` — `{tool_used: 'Write'}` matches Write tool calls
- `cwd_match` — regex against cwd
- `command_match` — regex against bash command
- `path_match` — regex against file_path arg
- `prompt_match` — regex against prompt text

### 2.3 `Skill.requires:` AND-preconditions (T-ASC ASC.2)

Schema: `src/runtime/skill_requires.ts`. Each `requires:` entry is a
precondition the dispatcher evaluates BEFORE walking any rule. If any
precondition is false, the entire skill is skipped (no rules
evaluate, no `inject_context` fires).

```yaml
requires:
  - kind: automation_mode_on
  - kind: active_task_present
```

Schema: each entry is `{kind: <variant>}`. Two variants ship today
(`skill_requires.ts:48-49`): `automation_mode_on` (stat the session
`automation.flag`) and `active_task_present` (stat the session
`active-task.json`). The former `chain_stage:` precondition was REMOVED with
chain_state (`skill_requires.ts:11`) — gate on FSM state via the `read_fsm_state`
primitive inside a rule's `process:` instead (see §2.6 + §5.2).

Preconditions are AND-composed. An empty `requires:[]` trivially
holds (back-compat).

A `RequiresCache` (`src/runtime/skill_requires.ts:RequiresCache`)
amortizes precondition reads across N skills that share the same
precondition within a single `dispatchEvent` call.

### 2.4 `triggers:` (Event kinds)

Schema: `src/packs/schemas/skill.ts:286-329` (the
`triggers:` field). Each trigger is a discriminated-union object.

Event kinds (`src/runtime/event.ts:1-200`):

| Kind              | Source                       | Common matchers              |
| ----------------- | ---------------------------- | ---------------------------- |
| `tool_call`       | Claude Code PreToolUse hook  | `tool_used`, `command_match` |
| `post_tool_call`  | Claude Code PostToolUse hook | `tool_used`                  |
| `prompt_submit`   | UserPromptSubmit hook        | `prompt_match`               |
| `session_end`     | SessionEnd hook              | —                            |
| `stop`            | Stop hook                    | —                            |
| `schedule`        | scheduler tick (SCHED.1)     | `cron:` literal in trigger   |
| `webhook`         | webhook intake (SCHED.2)     | route literal in trigger     |
| `inbound_channel` | chat inbound (LL.3 watcher)  | `channel`, `sender_pattern`  |
| `file_changed`    | file-watcher (SCHED.3)       | path glob in trigger         |

Omitting `triggers:` defaults to `[{kind: 'tool_call'}]` —
preserves Phase 1+ behavior verbatim.

**`inbound_channel` filter semantics** (T-L3-LOOP LL.3 / LL.4):

- `channel: 'telegram' | 'slack' | 'discord'` (optional). When set, the
  trigger fires only if the parsed scheme of `event.channelUri` matches
  (e.g. `'telegram'` matches `telegram://...`). Omit to accept all
  platforms.
- `sender_pattern: string` (optional). JS RegExp (first-party trust
  boundary — packs are vendored; pack authors are trusted to write
  non-pathological patterns). Matched against `event.sender`. Empty
  string OR omitted = accept all senders. Malformed pattern → trigger
  silently skipped at dispatch.
- `cost_tier:` (optional, inherits the general trigger field).

**`InboundChannelEvent` payload** (defined at `src/runtime/event.ts:136-144`):

| Field        | Type    | Description                                      |
| ------------ | ------- | ------------------------------------------------ |
| `channelUri` | string  | `<platform>://<channel>[/<thread_id>]` per LL.3  |
| `sender`     | string  | platform display name (e.g. Telegram first_name) |
| `text`       | string  | message body                                     |
| `threadKey`  | string? | thread/topic id (Telegram `message_thread_id`)   |
| `receivedAt` | string  | ISO-8601, platform-stamped                       |

Multi-platform within one skill: declare two `triggers:` entries (one
per platform). Skill-rule composition is layered — not OR-ed at the
trigger schema.

Reference example: `packs/builtin/default-discipline/skills/inbound-greeter/`
demonstrates the trigger pattern (surface-verdict acknowledgment of any
inbound message).

### 2.5 `rules:` (Rule discriminated union)

Schema: `src/packs/schemas/skill.ts:135-200`. Two kinds:

- `track_check` — per-event rule walked at dispatch time. The
  default. Evaluates `process:` steps, may emit a verdict.
- `destination_check` — periodic rule walked by the destination
  scheduler (every N tool calls). Does NOT fire through the
  per-event dispatcher.

```yaml
rules:
  - id: warn-on-amend
    kind: track_check
    requires: [] # rule-local preconditions (peer to Skill.requires)
    process:
      - call: tool_name
        as: tool
      - call: match_command
        as: m
      - call: verdict
        if: 'tool == "Bash" && m.matched == true'
        args:
          level: warn
          message: 'avoid git commit --amend in shared branches'
```

### 2.6 `process:` step grammar

Schema: `src/packs/schemas/skill.ts:101-130`. Each step is one of:

- `call:` a primitive name (see §5 for catalog) + `as:` binding
  name + optional `args:` + optional `if:` predicate + optional
  `on_empty:` for empty-result short-circuits
- `set:` literal binding (no primitive call)

The `if:` expression grammar is documented in `docs/skill-grammar-guide.md`
— it supports `==`/`!=`, `&&`/`||`/`!`, dotted path access into
bound bindings (e.g. `tool.value`), the `contains(haystack, needle)`
helper, and a few well-known booleans (`true`/`false`/`null`).

Evaluation is strictly sequential: each step's `as:` binding is
visible to all subsequent steps via dotted access.

---

## 3. Lifecycle

### 3.1 Discovery (`active.json` + `detected_by`)

Module: `src/packs/discovery.ts:1-130`.

1. **Scope resolution** — `resolveUserScopeRoot()` returns
   `~/.opensquid/`; `resolveProjectScopeRoot(cwd)` walks up from cwd
   looking for `.opensquid/` (returns `null` if none above cwd).
2. **active.json read** — `<scope>/active.json` is JSON with shape
   `{packs: string[]}`. ENOENT → empty pack list (no opt-in). Malformed
   JSON / missing `packs:` → throws path-bearing error (fail-LOUD per
   `project_opensquid_runtime_failure_handling`).
3. **Per-pack load** — `loadPack(<scope>/packs/<name>/)` parses
   `manifest.yaml` + every `skills/*/skill.yaml` + side files.
4. **Detection gate (IDF.3)** — if the caller passed a
   `DetectionContext`, each opted-in pack is gated on
   `matchesDetectedBy(pack.detectedBy ?? [], ctx)`. Mismatched packs
   are skipped from results. `null` ctx → legacy behavior (all
   opted-in packs load).
5. **Opt-in invariant** — a pack NOT in `active.json` is NEVER
   loaded regardless of `detected_by`. No silent installs.
6. **Composite expansion (MM.1)** — after per-pack discovery + detected_by
   filtering, `discoverActivePacks` calls `expandComposites`
   (`src/packs/composite_resolver.ts`) to walk every composite pack's
   `includes:` against the discovered focused-pack registry. The
   expanded list contains:
   - Every original focused pack (deduped)
   - Every composite pack (preserved for audit identity — composites have
     no skills to walk, but stay in the list for diagnostics)
   - Every focused pack referenced by any composite's includes (deduped;
     first-occurrence-wins; scope-precedence preserved)

   Composite resolution errors throw `CompositeResolutionError` with a
   `cause` field:

   | Cause code        | Trigger                                                                   |
   | ----------------- | ------------------------------------------------------------------------- |
   | `unknown-pack`    | composite references a `pack_id` not in the registry                      |
   | `semver-mismatch` | registry version doesn't satisfy the include's range                      |
   | `cycle`           | composite A → B → A (or longer chain) detected within one resolution walk |
   | `depth-exceeded`  | > 3 levels of nested composite expansion                                  |
   | `invalid-semver`  | malformed range string                                                    |

### 3.2 Load order

Module: `src/packs/load_order.ts` (`sortPacksByScope`).

After discovery returns user + project packs, the loader concatenates
them and sorts by `scope:` precedence (universal first, project last)
then alphabetically within a scope. First-match short-circuit means
higher-precedence packs win.

### 3.3 `extends:` inheritance (planned)

Not shipped in v0.5.x. Skill-level `extends:` will let a pack inherit
another pack's skill + selectively override fields. Tracked
separately.

### 3.5 Vanilla upgrade lifecycle (LP.2 + LP.5)

When a user runs `opensquid pack install <newer-source>` for an
already-installed pack OR when session-load discovery sees
`manifest.version > base_version` AND personal_revision has lessons
(id > 0) AND `last_merged_vanilla !== current vanilla`, the lazy 3-way
merge resolver triggers:

1. Read base snapshot (immutable installed version) from
   `<state-dir>/base/`
2. Read personal lesson files from
   `<state-dir>/personal_revision/lesson_*.yaml`
3. Read vanilla snapshot from the install source / extracted directory
4. For each file in the union (.yaml/.yml/.md only; node_modules/.git/
   skipped):
   - Both base & vanilla unchanged → `unchanged`
   - Only personal touched → `auto-merged-personal` (preserve personal)
   - Only vanilla touched → `auto-merged-vanilla` (adopt vanilla)
   - Both touched → `conflict`: emit `lesson_<n>.conflict.yaml` sidecar
     with YAML-comment-safe git-style markers (`# <<<<<<< base`, `#
=======`, `# >>>>>>> vanilla <semver>`)
5. Update `last_merged_vanilla` in version.json on success

User resolves conflicts manually by editing the `.conflict.yaml`
sidecar + renaming back to `.yaml`. On next discovery the resolved
file is picked up as the canonical lesson.

**Lazy by design (per L10):** no background poller; the merge fires on
next discovery only. **Idempotent (per L11):** same vanillaVersion →
returns `noop: true` without file writes. **base_version immutable:**
only `last_merged_vanilla` mutates; `base_version` stays the
install-time value.

Per-session cache: `(packId, base, vanilla, revisionId)` tuple
short-circuits redundant calls. Cleared via `clearMergeCache()` (called
by bootstrap on SessionStart).

Helpers: `checkAndMergeUpgrades` + `clearMergeCache` in
`src/packs/discovery.ts`. Underlying merger: `runThreeWayMerge` in
`src/runtime/versioning.ts:1-250`.

### 3.4 Dispatch flow

Module: `src/runtime/hooks/dispatch.ts:205-380` (`dispatchEvent`).

```
event (ToolCallEvent | …)
  ↓
for each pack in packs (already scope-sorted):
  ↓
  IDF.4 filter: activationScopeApplies(pack.activationScope ?? 'project', scopeCtx)
                                 │
                                 ↓ true (else skip pack)
  ↓
  for each skill in pack.skills:
    ↓
    unload check: dynamicSkillNames has skill AND unloadSkip has skill → skip
    AUTO.1 filter: skill.triggers some kind == event.kind → walk, else skip
    ASC.2 gate: every skill.requires precondition holds → walk, else skip
    ↓
    for each rule in skill.rules:
      ↓
      destination_check kind → skip (handled by scheduler)
      ↓
      evaluateProcess(rule.process, …) → RuleResult
        ↓
        verdict (pass | block | warn | surface | directive)
        OR inject_context (string aggregated)
        OR no_verdict (continue)
      ↓
      verdict resolved → consult pack.driftResponse?.per_rule[rule.id] ?? .default ?? 'block_tool'
      ↓
      applyDriftResponse → {exitCode, stderr, …}
      ↓
      FIRST verdict short-circuits the walk (within the dispatchEvent call)

      Special case — verdict.level === 'directive' (ASC.3 + MM.2):
        ↓
        Aggregate onto the per-event directives[] list (peer to contextInjections).
        ↓
        MM.2 — if next_action.profession is set:
          1. Look up profession pack in loaded registry
          2. Validate pack.usage in {'profession', 'both'}
          3. Validate pack.team is set + has >= 1 role
          4. On success: aggregate; UserPromptSubmit surfaces via envelope.
          5. On failure: DROP the directive + emit a stderr warning naming
             the ProfessionResolutionError cause; the agent never sees a
             malformed directive (fail-safe — no misleading the agent into
             spawning an invalid profession).
        ↓
        The AGENT reads the surfaced directive + invokes spawn_subagent(...).
        opensquid NEVER invokes spawn_subagent itself per
        [[project_opensquid_no_agent_loop]] — the invariant is preserved.
```

Profession-directive validation error codes (`ProfessionResolutionError`):

| Code             | Trigger                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `unknown-pack`   | `next_action.profession` names a pack not in the loaded registry  |
| `wrong-usage`    | named pack exists but `usage === 'active'`                        |
| `missing-team`   | named pack has `usage: profession\|both` but no loaded team.yaml  |
| `no-roles`       | team.yaml declares zero roles (defensive — schema enforces ≥ 1)   |
| `role-not-found` | (multi-role) directive's `args.role` names a role not in the team |

Exit-code mapping (`src/runtime/hooks/dispatch.ts:45-60`):

| Policy               | exitCode | stderr                                  |
| -------------------- | -------- | --------------------------------------- |
| `block_tool`         | 2        | message                                 |
| `warn`               | 0        | message                                 |
| `full_stop_and_redo` | 2        | message                                 |
| `notify_and_pause`   | 0        | '' (Phase 4 wires channels)             |
| `auto_correct`       | 0        | '' (invokes corrective skill)           |
| `escalate`           | 2        | message (severity bumped to 'critical') |

Note `notify_and_pause` + `auto_correct` exit 0 in v0.5.x — their
real behavior lands as their wiring (channels, corrective dispatch)
ships in later phases. A misconfigured pack-declared policy won't
silently block tools today.

---

## 4. Verdict shapes

### 4.1 Five levels

Schema: `src/runtime/types.ts:54-130` (`VerdictLevel` enum +
`Verdict` discriminated union).

| Level       | Effect at dispatcher                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| `pass`      | Continue rule walk; no exit-code change                                                  |
| `block`     | Resolve via drift_response → typically exit 2                                            |
| `warn`      | Resolve via drift_response → typically exit 0 + stderr                                   |
| `surface`   | Aggregate to `contextInjections` (UserPromptSubmit hook surfaces)                        |
| `directive` | Aggregate to `directives[]` (UserPromptSubmit hook surfaces under `⛔ DIRECTIVE` marker) |

`surface` and `directive` COEXIST with `block` — a `block` verdict
sets the exit code, but earlier `surface`/`directive` aggregations
still surface via the hook envelope.

### 4.2 `NextAction` shape (ASC.3 + DPC.1)

Schema: `src/runtime/types.ts:NextAction`. Used in `directive` verdicts.

```typescript
{
  skill?: string,        // exactly one of skill / tool / profession (XOR)
  tool?: string,
  profession?: string,
  args?: Record<string, unknown>,
  rationale: string,
}
```

The XOR is enforced via a Zod `.refine` — exactly one of `skill`,
`tool`, or `profession` must be set. The agent reading the directive
chooses what to do next based on the populated field.

`profession:` (DPC.1) routes the agent to a profession pack rather
than a single skill — useful when the next-action requires loading
a whole persona (e.g. `task-spec-author` / `scope-architect`).

### 4.3 `drift_response.yaml` composition

Schema: `src/packs/schemas/drift_response.ts`. Six policies in the
`DriftPolicyEnum`:

| Policy               | Semantic                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `block_tool`         | Exit 2 with the verdict message — the default Phase-1 fallback             |
| `warn`               | Exit 0 + stderr message                                                    |
| `full_stop_and_redo` | Same exit-code shape as `block_tool`; corrective intent encoded in message |
| `notify_and_pause`   | Exit 0 today; will route to channels (Phase 4)                             |
| `auto_correct`       | Invokes a corrective sub-skill named via `corrective_skills:` (AUTO.4)     |
| `escalate`           | Bumps severity to `critical` + reroutes (AUTO.4)                           |

Per-rule overrides:

```yaml
default: block_tool
per_rule:
  warn-on-amend: warn
  no-pre-emit-gate: notify_and_pause
corrective_skills:
  no-pre-emit-gate: corrective-pre-emit-redo
```

Resolution order at dispatch: `pack.driftResponse?.per_rule[rule.id]
?? pack.driftResponse?.default ?? 'block_tool'`. The fallback
`'block_tool'` is the "no drift_response.yaml at all" branch — when
the file IS present but omits `default:`, the schema default
applies.

---

## 5. Primitive catalog

Primitives live in `src/functions/*.ts` and register against
`FunctionRegistry` at bootstrap. Pack rules invoke them via
`call: <name>` in `process:` steps. The catalog below lists every
shipped primitive by category.

### 5.1 Event inspection (`src/functions/event.ts`)

| Primitive                | Returns                       | Use                                             |
| ------------------------ | ----------------------------- | ----------------------------------------------- |
| `tool_name`              | `{value: string}`             | The tool being called (`Bash`, `Write`, etc.)   |
| `tool_args`              | object                        | The tool's parsed args                          |
| `cwd`                    | `{value: string}`             | Current working directory                       |
| `last_assistant_message` | `{value: string}`             | Most recent assistant output                    |
| `match_command`          | `{matched: bool, groups?: …}` | Regex-match against bash command (args.pattern) |

### 5.2 State + FSM (`src/functions/state.ts`, `fsm.ts`, `session_tool_history.ts`)

| Primitive              | Returns              | Use                                                                        |
| ---------------------- | -------------------- | -------------------------------------------------------------------------- |
| `read_state`           | bound value          | Read a session-scoped state key                                            |
| `write_state`          | `{ok: true}`         | Write a session-scoped state key                                           |
| `append_log`           | `{ok: true}`         | Append to a session-scoped log file                                        |
| `read_fsm_state`       | state string\|`null` | Read a pack-FSM's current state (own pack, or another via `pack:` arg)     |
| `advance_fsm`          | next-state string    | Fire an `event:` against the own pack's FSM; persists + returns next state |
| `session_tool_history` | `{tools: string[]}`  | Last N tool names this session                                             |

`read_chain_state` was REMOVED with chain_state. The 7-phase workflow is now the
`coding-flow` pack's lifecycle; gate on it via `read_fsm_state` (`pack:
coding-flow` for a cross-pack read) — see §6.3. Both FSM primitives live in
`src/functions/fsm.ts:37,52`; `read_fsm_state` returns `null` when the pack has no
`fsm.yaml` or the machine is unstarted (`advance_fsm` then defaults to `initial`).

### 5.3 Active-task (`src/functions/active_task.ts`)

| Primitive                  | Returns             | Use                                              |
| -------------------------- | ------------------- | ------------------------------------------------ |
| `has_active_task`          | `{value: bool}`     | Is there an active task at all?                  |
| `has_generated_spec`       | `{generated: bool}` | Does active task have a metadata.spec disk file? |
| `task_list_generated`      | `{value: bool}`     | Has a task list been generated?                  |
| `workflow_phases_complete` | `{value: bool}`     | Are all phases of active task logged?            |

### 5.4 Memory + recall (`src/functions/rag.ts` + `lessons.ts` + `recall_pre_inject.ts`)

| Primitive           | Returns              | Use                                     |
| ------------------- | -------------------- | --------------------------------------- |
| `recall`            | `{hits: [...]}`      | Query the engine RAG for memory matches |
| `embed`             | `{vector: number[]}` | Compute embedding                       |
| `store_lesson`      | `{ok: true}`         | Store a verified lesson                 |
| `propose_lesson`    | `{ok: true}`         | Propose a lesson (awaits promotion)     |
| `promote_lesson`    | `{ok: true}`         | Promote a proposed lesson               |
| `recall_lesson`     | `{lesson?}`          | Read a specific lesson by id            |
| `recall_pre_inject` | `{value: string}`    | Pre-inject recall hits at prompt submit |

### 5.5 Pattern matching (`text_pattern_match.ts` + `path_exists.ts`)

| Primitive            | Returns           | Use                           |
| -------------------- | ----------------- | ----------------------------- |
| `text_pattern_match` | `{matched: bool}` | Regex match on a bound string |
| `path_exists`        | `{exists: bool}`  | Filesystem existence check    |

### 5.6 LLM + model-aliased (`src/functions/llm.ts` + `subagent.ts` + `destination_check.ts`)

All LLM-calling primitives route via `model_alias:` (no vendor model
names in source per `feedback_stop_haiku_drift`).

| Primitive           | Returns                               | Use                              |
| ------------------- | ------------------------------------- | -------------------------------- |
| `llm_classify`      | `{label: string, confidence: number}` | Classify input via aliased model |
| `subagent_call`     | `{response: string}`                  | One-shot subagent invocation     |
| `spawn_subagent`    | `{id: string}`                        | Long-running subagent spawn      |
| `check_destination` | `{state: …}`                          | Destination_check rule body      |

**Reviewer subagents are hook-silenced (`OPENSQUID_SUBAGENT`).** Every
`subscription`/`cli` spawn marks its child tree with `OPENSQUID_SUBAGENT=1`;
the opensquid hook bins exit 0 immediately inside a marked tree
(`src/runtime/hooks/subagent_guard.ts`). A reviewer one-shot therefore mints
no session state, writes no handoff dump, and can never spawn a nested
audit of its own (the recursion class observed in wg-627effbb2c38). The
agent-bridge's working agents are deliberately NOT marked — they act on the
user's behalf and stay fully gated. Optionally, users can also restrict the
reviewer's tool surface at the alias level via `models.yaml` `args` (e.g.
the host CLI's own tool-allowlist flags) — that knob is user-owned config;
opensquid never hardcodes vendor flags in source.

### 5.7 Verdict + control (`src/functions/verdict.ts`)

| Primitive               | Returns            | Use                                            |
| ----------------------- | ------------------ | ---------------------------------------------- |
| `verdict`               | RuleResult.verdict | Emit a verdict (level + message ± next_action) |
| `halt_task`             | RuleResult         | Halt the current task                          |
| `restart_workflow`      | RuleResult         | Restart the workflow chain                     |
| `set_active_task_state` | `{ok: true}`       | Write to active-task state                     |

### 5.8 Capability-gated (`src/functions/file_write.ts`, `shell_exec.ts`, `http_request.ts`)

These primitives MUST pass the `CapabilityGate`
(`src/runtime/capability_gate.ts`) at runtime. The built-in denylist
(`src/runtime/builtin_denylist.ts`) sealed via `Object.freeze` covers
the worst shell/path patterns (rm -rf /, fork bombs, dd to /dev/sd\*,
curl|sh, etc.).

| Primitive      | Returns                      | Use                           |
| -------------- | ---------------------------- | ----------------------------- |
| `file_write`   | `{ok: bool}`                 | Write to a permitted path     |
| `shell_exec`   | `{stdout, stderr, exitCode}` | Run a permitted shell command |
| `http_request` | `{status, body}`             | Make a permitted HTTP request |

### 5.9 Session signals (`src/functions/is_automation_mode.ts`)

| Primitive            | Returns         | Use                                          |
| -------------------- | --------------- | -------------------------------------------- |
| `is_automation_mode` | `{value: bool}` | Is the automation flag set for this session? |

---

## 6. Audit + drift catalog

### 6.1 Files written

| File                           | Writer                | Purpose                                       |
| ------------------------------ | --------------------- | --------------------------------------------- |
| `<sess>/violations.log`        | `applyDriftResponse`  | Append-only log of every fired drift policy   |
| `<sess>/drift-catalog.jsonl`   | drift_response writer | One JSONL row per violation with full context |
| `<sess>/state/fsm-<pack>.json` | `advanceFsmState`     | A pack-FSM's `{state, history[]}` (per pack)  |
| `<sess>/active-task.json`      | `writeActiveTask`     | Current active task + metadata.spec           |
| `<sess>/workflow-phases.jsonl` | `log_phase` MCP tool  | Per-task phase log (7-phase machine)          |
| `<sess>/skill-ticks.json`      | `advanceSkillTicks`   | Dynamic-skill unload tick counters            |

### 6.2 Audit-trail provenance

Each violation row carries:

- `ruleId` — which rule fired
- `packName` — which pack owned the rule
- `skillName` — which skill the rule belonged to
- `subagentId` (when set) — which subagent emitted the input that
  triggered the verdict
- `professionPack` (when set) — which profession pack the subagent
  was running under

This provenance lets the user trace any drift back to the pack + rule
that fired, and (when enabled) to the subagent + profession that
caused the input.

### 6.3 The workflow as a pack FSM (replaces chain_state)

The 7-phase workflow used to live in a bespoke `src/runtime/chain_state.ts`
machine driven by 5 scattered hook-bin transition sites. It is now the
**`coding-flow` pack's lifecycle** (`packs/builtin/coding-flow/fsm.yaml`), driven by
the generic total-transition engine (`src/runtime/fsm.ts`) — the unified replacement
that absorbed the earlier `scope-fsm` + `workflow-fsm` split (T-FSM-UNIFY). ONE
behavior-pattern FSM with three gated stages, each enforced by a CONTENT gate (not a
presence marker):

```
idle → scoping ⇄ researching → researched            SCOPE   (gate: guess-audit loop-back)
     → spec_authored → spec_complete → tasks_loaded   AUTHOR  (gate: spec-audit, 11-field + real code)
     → phases_in_flight → phases_complete             CODE    (gate: phase-log before commit)
```

State persists per session per pack at `<sess>/state/fsm-coding-flow.json` as
`{state, history[]}` (`advanceFsmState`, `src/runtime/fsm_state.ts`); the FSM is
TOTAL — a non-matching event is an explicit stay, not a crash. The `scope-lifecycle`
skill advances it on the canonical signals (the prompt, and the pre-research / spec /
task writes) via `advance_fsm` and runs each stage's content audit; any gate reads
the stage via `read_fsm_state` (the research-before-code gate blocks code before
`researched`; the task-authoring gate blocks TaskCreate before `spec_complete`).
Cross-pack reads pass `pack: coding-flow`. "Coding" is the gate profile — the FSM
lifecycle itself is domain-general. Full walkthrough: `docs/pack-fsm-architecture.md`.

---

## 7. Authoring patterns

### 7.1 Soft warn vs hard block vs directive vs surface

- **Hard `block`** — coding errors with a clear correct path. The
  user must redo before the tool fires. Reserved for things that
  break invariants (e.g. coding before scope spec exists).
- **Soft `warn`** — practices the user might want to deviate from
  (e.g. `git commit --amend` on a shared branch). Surface the
  context, don't block.
- **`directive`** — a structured next-action handoff. The agent
  reads `next_action.skill` / `next_action.tool` /
  `next_action.profession` and executes. Use for chain handoffs
  between pipeline stages.
- **`surface`** — context that should ride along on the next prompt
  but isn't a verdict per se (e.g. recall hits pre-injected at
  prompt submit).

### 7.2 `destination_check` vs `track_check`

`track_check` fires per event. `destination_check` fires on a
periodic scheduler tick (every N tool calls). Use
`destination_check` for "is the agent heading toward the right
destination" questions where per-event evaluation would be too
expensive.

### 7.3 Composing AND-preconditions via `Skill.requires:`

Move shared preconditions UP from rule-local `requires:` to
skill-level when 2+ rules share them. Saves dispatcher walks (the
skill is skipped entirely when any precondition fails) and the
`RequiresCache` amortizes the precondition reads across rules.

### 7.4 Lifecycle-handoff directives + FSM transitions

When a rule's purpose is "the lifecycle has moved to the next stage,
load the appropriate profession", emit a `directive` verdict with
`next_action.profession:` set. Couple with an `advance_fsm` call (event →
next state) so subsequent rules — in this pack or another, via
`read_fsm_state` with `pack:` — see the new state. Declare the legal
transitions in the pack's `fsm.yaml`; the engine keeps the machine total, so an
unexpected event is a no-op stay rather than a crash. (This replaces the old
`transition_chain_stage` + `read_chain_state` pair.)

### 7.5 Anti-patterns to avoid

- **No LLM in detection.** All `detected_by[]` evaluation is pure
  regex / filesystem / prompt-substring. Adding LLM calls to
  detection breaks the cost + determinism budget.
- **No vendor model names in source.** Route via `model_alias:` in
  `models.yaml`. Per `feedback_stop_haiku_drift` — the project is
  model-neutral.
- **No pre-emit gate.** Claude Code has no pre-emit hook surface;
  PreToolUse is the closest, but it fires AFTER the model's
  decision. The corrective pattern is post-emit redo (Stop + exit 2),
  not pre-emit prevention. Trying to enforce "the model shouldn't
  have done X" via PreToolUse is structurally wrong.
- **No silent fail-open at user-authored config.** When a pack
  configuration is malformed (active.json, manifest.yaml, side files),
  fail LOUD with a path-bearing error. The two test seams
  (`OPENSQUID_TEST_PACK`, `OPENSQUID_TEST_PACK_DIR`) deliberately
  fail-open because their fixtures are opensquid-authored; real
  user-authored config never gets this treatment.
- **No back-channel writes outside session-scoped paths.** All
  on-disk state goes under `<OPENSQUID_HOME>/sessions/<sess>/` —
  never spread state across the user's home directory or arbitrary
  paths.
- **Inbound dispatch is best-effort; unreachable sessions stay silent**
  (T-L3-LOOP L7 / L12). When an inbound row arrives via the chat-daemon
  but no `live-session.lease` is fresh (`chat watch` not running or
  crashed), the LL.3 inbound watcher appends an `unrouted.jsonl` row to
  `~/.opensquid/projects/<uuid>/inbox/` and LEAVES the inbox row
  intact. The next session-start drains the backlog via the LL.4 UPS
  hook — "lazy push", not "eager wake". Pack-author implication: never
  assume your `inbound_channel` skill will fire at message-arrival
  latency. The latency floor is `min(time_until_next_user_prompt,
time_until_chat_watch_resume)`. Designs that depend on real-time
  inbound reaction (e.g. on-call alert triage) belong in the
  agent-bridge daemon path (`src/runtime/agent_bridge/`), not the
  interactive `chat watch` path.
- **Inbound skills are passive evaluators — never mutate the inbox**
  (T-L3-LOOP L8). A skill triggered by `inbound_channel` can emit any
  Verdict shape (pass / block / warn / surface / directive) but the
  inbox + ack state are runtime-managed. There is no
  `mark_inbound_read` or `delete_inbound` primitive at LL scope —
  opensquid's invariant: **packs propose; runtime disposes**. Adding a
  mutation primitive for inbound would re-introduce the cross-pack
  race condition the ack ledger exists to prevent. If a pack needs
  richer inbound auditing (which messages were injected this turn, in
  what order), inspect the prompt-history `additionalContext` directly
  via `recall`. A first-class `recall_injected_inbound` primitive is
  deferred to post-v1.

---

## Appendix A — Citation index

The doc above cites these source files; this list is a quick-jump
index for editors:

| Topic                                | File                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest schema                      | `src/packs/schemas/manifest.ts`                                                                                                                                                                                                 |
| Skill schema                         | `src/packs/schemas/skill.ts`                                                                                                                                                                                                    |
| Side-file schemas                    | `src/packs/schemas/{chat_agent,models,channels,notifications,drift_response,team}.ts`                                                                                                                                           |
| Pack runtime type                    | `src/runtime/types.ts`                                                                                                                                                                                                          |
| Detection evaluator                  | `src/runtime/detection.ts`                                                                                                                                                                                                      |
| Discovery + opt-in                   | `src/packs/discovery.ts`                                                                                                                                                                                                        |
| Pack loader                          | `src/packs/loader.ts`                                                                                                                                                                                                           |
| Bootstrap + DetectionContext staging | `src/runtime/bootstrap.ts`                                                                                                                                                                                                      |
| Dispatcher                           | `src/runtime/hooks/dispatch.ts`                                                                                                                                                                                                 |
| Evaluator                            | `src/runtime/evaluator.ts`                                                                                                                                                                                                      |
| Drift response                       | `src/runtime/drift_response.ts`                                                                                                                                                                                                 |
| Skill requires                       | `src/runtime/skill_requires.ts`                                                                                                                                                                                                 |
| FSM engine + state                   | `src/runtime/fsm.ts` (total-transition engine), `src/runtime/fsm_state.ts` (per-session state)                                                                                                                                  |
| Guards template                      | `src/packs/guards_compiler.ts`                                                                                                                                                                                                  |
| Capability gate                      | `src/runtime/capability_gate.ts`                                                                                                                                                                                                |
| Built-in denylist                    | `src/runtime/builtin_denylist.ts`                                                                                                                                                                                               |
| Primitive registry                   | `src/functions/registry.ts`                                                                                                                                                                                                     |
| Primitives                           | `src/functions/{event,state,fsm,active_task,rag,lessons,llm,verdict,path_exists,text_pattern_match,session_tool_history,destination_check,file_write,shell_exec,http_request,recall_pre_inject,subagent,is_automation_mode}.ts` |

---

## Appendix B — Glossary

| Term             | Meaning                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pack             | A directory under `<scope-root>/packs/<name>/` containing a manifest + skills + side files                                                            |
| Skill            | A YAML file declaring `rules:` + `triggers:` + lifecycle metadata                                                                                     |
| Rule             | A `process:` chain of primitive calls producing a verdict / inject_context / no_verdict                                                               |
| Primitive        | A registered function (`src/functions/*.ts`) callable from rule `process:` steps                                                                      |
| Verdict          | A typed runtime result: `pass` / `block` / `warn` / `surface` / `directive`                                                                           |
| Drift policy     | What the dispatcher does with a verdict (6 enum values)                                                                                               |
| Activation scope | WHO the pack applies to (`project`/`user`/`hybrid`/`team`/`global`)                                                                                   |
| Scope            | Layering precedence for pack ordering (`universal` → `project`)                                                                                       |
| Detection        | The 7-kind clause set the runtime evaluates to decide WHEN among opted-in packs                                                                       |
| Pack FSM         | A pack's lifecycle declared in `fsm.yaml` (states + total transitions), walked by the generic engine; state persists per session as `fsm-<pack>.json` |
| FSM state        | The current state string of a pack FSM; read via `read_fsm_state`, advanced via `advance_fsm`                                                         |
| Guard            | A `manifest.guards[]` entry compiled to a synthetic `<pack>/guards` detect→verdict rule                                                               |
| Profession pack  | A pack whose `team.yaml` marker declares a `role:` for next-action `profession:` directives                                                           |
