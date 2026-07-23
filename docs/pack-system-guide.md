<!-- GENERATED-ASSIST: drafted by the pack-system-guide workflow (per-subsystem map→adversarial-verify→synthesize, all sections code-verified). Drift-proofed by docs-vs-code parity tests (see pack-system-guide drift guards). Edit the CODE + this doc together. -->

# The Open Squid Pack System: An Author's Guide

> Single source of truth for writing a pack. Every claim in this guide cites `file:line` in the repo and is drift-guarded by CI parity tests (see the consolidated drift-guard table at the end of this section). If the code and this guide disagree, the code wins — and a parity test should have caught it.

## What a pack is

Open Squid is a **behavior runtime**: an orchestrator that loads packs and dispatches runtime events through them. A **pack is the total, descriptive definition of an agent's behavior** — its discipline, its lifecycle, the models it reasons with, the subagents it can become, and how it responds when behavior drifts. The product equation the whole system serves:

> **experience = orchestrator( loaded packs )**

Swap the loaded packs and you swap the agent. A pack does not _suggest_ behavior; loaded and engaged, it _is_ the behavior the orchestrator enforces on every tool call, prompt, and session boundary.

A pack is a directory. Its mandatory heart is `manifest.yaml`, validated by the `.strict()` Zod `Manifest` schema (`src/packs/schemas/manifest.ts`) — only **four** fields are required (`name`, `version`, `scope`, `goal`); everything else has a documented default, and a typo'd key fails loudly at load. Around the manifest, a pack optionally ships a fixed set of **side-files** that the loader folds into the in-memory `Pack` object: `models.yaml`, `fsm.yaml`, `drift_response.yaml`, `chat_agent.yaml`, `procedure.md`, `team.yaml`, `version.json` (`src/packs/loader.ts:141-242`). Skills live as their own units (`skill.yaml`, schema `src/packs/schemas/skill.ts`) and the audit rubric ships package-wide under `docs/rubric/`.

**Author's mental model:** `manifest.yaml` carries only author-declared keys. The runtime `Pack` type (`src/runtime/types.ts:351`) is a _superset_ — it adds loader-folded fields (`models`, `fsm`, `driftResponse`, `procedure`, `team`, …) and camelCases the snake_case manifest keys. You never hand-write a loader-populated field into `manifest.yaml`.

## Who this guide is for

- **Humans** authoring or reviewing a pack: read top-to-bottom once to become an expert, then use the per-field reference tables as you write.
- **Agents** authoring a pack (the intended primary author): the lifecycle and seam-chain narrative below tells you exactly which gate controls which behavior, so you can reason from "I want effect X" to "the field/file/primitive that produces X."

Both audiences share one constraint: **the builtin packs under `packs/builtin/` are the only ground-truth worked examples.** This guide quotes them, never invents YAML. `coding-flow` is the reference full-lifecycle pack (FSM + flows + skills + rubric + procedure + drift-response).

## The pack lifecycle (end to end)

Becoming an expert means holding the whole chain from "a pack exists on disk" to "an exit code is returned to the harness." It runs in two phases.

**Phase 1 — BOOTSTRAP (once per hook subprocess).** The runtime builds the function registry (every primitive a pack's YAML may `call:`, wired in `src/runtime/bootstrap.ts:130-266`), then discovers and loads packs. **The only load gate is `active.json`** — a pack must be opted in by name (`{packs: string[]}`, `src/packs/discovery.ts:180-183`) or it does not load at all. Loaded packs are sorted into a fixed evaluation order by `scope:` (`SCOPE_ORDER`, `src/packs/load_order.ts:36-42`: universal → domain → specialty → workflow → project). `scope:` _only_ sorts; it never gates.

**Phase 2 — DISPATCH (once per event).** The dispatcher walks `packs × skills × rules`. Before any rule's process runs, a skill passes through **four sequential skip-gates in this load-bearing order** (`src/runtime/hooks/dispatch.ts:336-387`):

1. **`activation_scope`** — does this pack apply in this context at all? (`activationScopeApplies`, `dispatch.ts:233-246`)
2. **unload state** — was this dynamic skill unloaded by a prior event?
3. **trigger kind** — does any of the skill's triggers subscribe to this `event.kind`? (`EventKind`, `src/runtime/event.ts:229-241`)
4. **inbound-channel filter** — for `inbound_channel` events, does the sender/channel match?
5. **`requires` preconditions** — `automation_mode_on` / `active_task_present` (`src/runtime/skill_requires.ts:47-51`)

Order matters: reordering changes which gate short-circuits first. A skill that survives all gates has each rule's `process` walked; each `call:` step invokes a registry primitive that returns a `Result`, and the process terminates in one of **five** `RuleResult` kinds (`verdict | directive | no_verdict | error | inject_context`, `src/runtime/types.ts:450-454`), handled by the terminal switch at `dispatch.ts:409-465`. A message-bearing verdict is then resolved against the pack's drift policy (`per_rule[ruleId] ?? default ?? level-derived fallback`) into a process action and finally an **exit code** the harness obeys.

**The seam chain, in one line:** `active.json` decides _whether_ a pack loads → `detected_by:` decides _when_ it engages among opted-in packs (pure filesystem/memory/prompt checks, OR-semantics, empty = always; `src/runtime/detection.ts:66-83`) → `activation_scope:` decides _where_ it applies → the four dispatch gates decide _which skill walks this event_ → the rule `process` produces a verdict → `drift_response.yaml` decides _what happens_.

## How the pieces compose into behavior

```
manifest.yaml ── scope: ─────────────► evaluation ORDER (sort only)
              ── activation_scope: ──► WHERE it applies   ┐
              ── detected_by: ───────► WHEN it engages     │ engagement
   active.json ─────────────────────► WHETHER it loads     ┘ (3-gate AND + dispatch)

   skill.yaml ── triggers/requires ──► which EVENTS reach the rules
              └─ rules → process → call: primitives ──► VERDICT
                                          │
   fsm.yaml + flows: ──────────────────► advance the pack's LIFECYCLE state
   models.yaml ───────────────────────► resolve the alias the audit primitive calls
   drift_response.yaml ───────────────► map the VERDICT → action → EXIT CODE
   team.yaml ─────────────────────────► the subagent roles this pack can spawn into
   procedure.md / docs/rubric ────────► the METHOD + the BAR, injected to the author-agent
```

Three composition facts an expert keeps front of mind:

- **The FSM and the gates are coupled through models.** The coding-flow audit gates advance the FSM only if an LLM alias resolves; a missing `models.yaml` alias makes the FSM _uncompletable_ (`src/models/load_config.ts`). Models are not a side concern — they are on the critical path of the gate.
- **`detected_by: [user_pinned]` is a known footgun.** `bootstrap` hardcodes `userPinned: false` (and `memoryBodies`/`recentPrompts` empty), so `user_pinned`, `memory_match`, and `conversation_signal` clauses currently always evaluate false and _silently disable_ an opted-in pack. Use filesystem checks until those signals are staged.
- **Gate criteria == agent guidance, single-sourced.** `read_rubric` (`src/functions/read_rubric.ts`) feeds the SAME `docs/rubric/{scope,author}.md` text into both the audit prompt (the bar the gate enforces) and the pre-author context injection (the guidance the agent reads). There is no second copy to drift.

## How to read this guide

Read the sections in this order — it builds the model lifecycle-first, then fills in each authorable surface:

1. **Pack lifecycle (discovery → verdict)** — the spine; read this first so every later section has a place to hang.
2. **manifest.yaml (every-field reference)** — the required-vs-default field tables and the manifest-vs-runtime-`Pack` distinction.
3. **Scopes, Detection & Activation** — the two axes (`scope:` vs `activation_scope:`/`detected_by:`) and the three-gate engagement AND, including the `user_pinned` footgun.
4. **FSM & flows (`fsm.yaml`, `flows:`)** — declaring a total-transition lifecycle and reusing loopback edges via flow templates.
5. **Skills (`skill.yaml`)** — triggers, requires, unloads_when, rules, and the verdict levels.
6. **Primitives / function library** — the `~44` registered `call:` primitives; the `command_invokes`-not-`match_command` rule for any command gate.
7. **Teams / Professions / Roles (`team.yaml`)** — subagent roles for `usage: profession | both` packs.
8. **Models (`models.yaml`)** — the abstract-alias system and the 3-layer precedence merge.
9. **Drift-response config (`drift_response.yaml`)** — the six policies (four wired, two stubbed) mapping verdicts to actions.
10. **Authoring surfaces (`procedure.md` + audit rubric)** — the METHOD and the BAR, and how they single-source.

Each section ships its own field tables and at least one REAL builtin example. Sections 9 and 10 carry explicit "not-yet-wired" flags (auto_correct/escalate policies; per-pack custom rubrics) — heed them so you do not author against behavior that no-ops today.

---

## The Pack Lifecycle (discovery → verdict)

This is the path every pack travels from disk to a hook decision. An author must hold all seven seams in their head; each one can silently drop a pack/skill/rule, and the order is load-bearing.

### Phase 0 — Disk layout (what `loadPack` reads)

A pack folder (`src/packs/loader.ts:7-17` shows the manifest/models/channels/notifications/drift_response/chat_agent/skills layout; `fsm.yaml`/`procedure.md`/`team.yaml` are read in the loader body at `loader.ts:141-200`):

```
my-pack/
  manifest.yaml          ← required (the ONLY required file)
  models.yaml            ← optional → Pack.models
  drift_response.yaml    ← optional → Pack.driftResponse
  chat_agent.yaml        ← optional → Pack.chatAgent
  fsm.yaml               ← optional → Pack.fsm (lifecycle FSM)
  procedure.md           ← optional → Pack.procedure (re-injected per prompt)
  team.yaml              ← REQUIRED iff usage: profession|both
  channels.yaml / notifications.yaml   ← orthogonal config consumers (NOT folded into Pack)
  skills/
    <skill-name>/skill.yaml
```

`manifest.yaml` is the only `.strict()` schema — a typo like `versoin:` fails loudly at load (`src/packs/schemas/manifest.ts:15-20,571`). Four fields are required: `name`, `version`, `scope`, `goal` (`manifest.ts:508-516`); everything else defaults. `skill.yaml` is intentionally NOT strict — extra keys pass (`src/packs/schemas/skill.ts:13-17`).

### Phase 1 — `loadPack(dir)` (folder → typed `Pack`)

The single read path (`src/packs/loader.ts:92-243`), in order:

1. Parse `manifest.yaml` through `parseYamlFile` + the `Manifest` Zod schema (`loader.ts:93-96`).
2. Scan `skills/` for sub-dirs with a `skill.yaml`; **entries are `.sort()`ed alphabetically** for deterministic cross-OS load order (`loader.ts:398-422`, sort at `:408`). Non-dirs are silently skipped; symlinks are followed by design (`stat` follows symlinks, `loader.ts:413` + header `:392-395`).
3. **Compile sugar into synthetic skills**: `verify_gates[]` → a synthetic skill `<pack>/verify` (`loader.ts:103-112`, name at `verify_gates_compiler.ts:89`); `guards[]` → `<pack>/guards` (`loader.ts:118-127`, name at `guards_compiler.ts:91`). Empty-rule results are filtered out (`loader.ts:109,124`); a bad gate/guard expression throws with the offending name (`loader.ts:107,122`).
4. Load the optional side-files via the `loadOptional*` family — **all share one contract: ENOENT → `undefined`; any other error (YAML/Zod/EACCES) propagates verbatim** (`loader.ts:255-379`). `procedure.md` additionally returns `undefined` when over the 64 KB cap (`MAX_PROCEDURE = 64_000`, `loader.ts:254-263`).
5. `flows[]` are compiled (`compileFlows`) and merged into the `fsm.yaml` machine **before** `validateFsm` so totality is checked on the expanded FSM; a `flows:` block with no `fsm.yaml` to merge into is a loud error (`loader.ts:165-169`, merge+validate in `loadOptionalFsm` at `loader.ts:344-379`, the no-fsm error at `:359-364`).
6. `usage: profession|both` REQUIRES `team.yaml`; absence throws (`loader.ts:181-200`).

The returned `Pack` carries `activationScope` and `detectedBy` always-present via Zod defaults (`loader.ts:216-217`); `foundation`/`team`/`fsm`/`procedure`/etc. are conditionally spread to satisfy `exactOptionalPropertyTypes` (`loader.ts:202-242`).

### Phase 2 — Discovery + opt-in (`active.json` is the gate)

`discoverActivePacks(scopeRoot, ctx, builtinRoot)` (`src/packs/discovery.ts:199-251`):

- Reads `<scopeRoot>/active.json`, schema `{ packs: string[] }` (`discovery.ts:180-183`). This repo's file at `.opensquid/active.json`:

```json
{
  "packs": []
}
```

- **Contract** (`discovery.ts:13-18`): `scopeRoot===null` → `[]` (`discovery.ts:204`); `active.json` ENOENT → `[]` (scope present, no opt-in) (`discovery.ts:218`); malformed JSON or missing `packs:` → **throws** (fail-loud, never silent-fail-open per the runtime-failure-handling memory) (`discovery.ts:213-214,222-223`).
- For each name, load `<scopeRoot>/packs/<name>/`, falling back to `<builtinRoot>/<name>/` **only on ENOENT** — user-installed wins over built-in on name collision (`loadPackWithBuiltinFallback`, `discovery.ts:264-287`).
- **`detected_by` gates WHEN, not WHETHER**: a pack is loaded into the candidate list iff it is in `active.json`; then it is KEPT iff `matchesDetectedBy(pack.detectedBy, ctx)` (`discovery.ts:241-243`). Empty `detected_by[]` → always matches (`detection.ts:55-64`). The 7 check kinds (`file_exists`, `dir_exists`, `file_match`, `file_glob`, `memory_match`, `conversation_signal`, `user_pinned`) are pure filesystem/memory/regex — **no LLM in detection** (`manifest.ts:276-285`, `detection.ts:66-83`).
- **The `user_pinned` trap**: `detected_by: [user_pinned]` silently DISABLES an opted-in pack because the `userPinned` signal is never populated by the discovery context (`bootstrap.ts:408` sets `userPinned: false` inside `buildDetectionContext`; the real coding-flow manifest documents this exact gotcha and deliberately ships NO `detected_by`).
- Finally `expandComposites` appends a composite pack's `includes` (`discovery.ts:245-250`).

### Phase 3 — Bootstrap composition + scope sort

`loadActivePacks(sessionId)` (`src/runtime/bootstrap.ts:427-430`) composes `[...activePacks, ...disk, ...real]`, documented order: in-process `setActivePacks` override → `OPENSQUID_TEST_PACK` env seam → `OPENSQUID_TEST_PACK_DIR` disk seam → **real loader** (user-scope `~/.opensquid/` + project-scope walked up from cwd) (`bootstrap.ts:283-290`). Note the in-process slot and the env seam share one variable: `activePacks` is initialized to `envPacks` (`bootstrap.ts:309,412`) and `setActivePacks` overwrites it (`bootstrap.ts:414-416`). Only the real-loader output is run through `sortPacksByScope` (`bootstrap.ts:356`). The two test seams fail-OPEN (malformed → `[]`, `bootstrap.ts:303-305,321-323`); the real loader fails-LOUD (`bootstrap.ts:357-364`, rationale `:280-281`).

Scope ordering is fixed `universal→domain→specialty→workflow→project`, ties broken alphabetically by name (`src/packs/load_order.ts:36-53`; enum at `manifest.ts:44`). **Order matters because later packs see earlier packs' state in the same evaluation window** (`load_order.ts:7-9`), and the dispatcher's first-block-wins short-circuit means a high-precedence pack's block can't be overridden by a later warn.

The registry is built once per subprocess by `buildRegistry()`, which registers every primitive family the rule processes call (`event`/`state`/`verdict`/`llm`/`fsm`/RAG/etc., `bootstrap.ts:128-268`). A `call:` naming a primitive not registered here will error at evaluation time.

### Phase 4 — Dispatch (`dispatchEvent`) — the per-event walk

`dispatchEvent(event, packs, registry, sessionId, scopeCtx)` (`src/runtime/hooks/dispatch.ts:284-558`) walks `packs → skills → rules`. **Five sequential gates can skip a unit before a rule's process runs** — an author must know the exact order:

1. **`activation_scope`** (per-pack): `activationScopeApplies(pack.activationScope ?? 'project', scopeCtx)` — mismatch skips the whole pack's skills (`dispatch.ts:233-246,336`). `team` ships INERT (always `false`, `dispatch.ts:241-242`); `global` resolves identically to `user` (both → `ctx.isUserSession`, `dispatch.ts:238,244`).
2. **unload state** (per dynamic skill): a `lazy` skill whose `unloads_when` fired this event is skipped — rules AND `inject_context` prose both dropped (`dispatch.ts:309-324,338-341`). Pinned skills (`load: preload` + universal) are exempt.
3. **trigger kind**: `skill.triggers.some(t => t.kind === event.kind)` — schema-guaranteed non-empty (`.min(1)`), omitted block defaults to `[{kind:'tool_call'}]` (`dispatch.ts:342-347`, `skill.ts:315-318`).
4. **inbound_channel filter**: optional `channel:`/`sender_pattern` regex match (`dispatch.ts:356-362`).
5. **`requires` preconditions** (skill-level then per-rule): AND-semantic `SkillRequires` gates (`automation_mode_on`, `active_task_present`, `chain_stage`); empty trivially holds; one `RequiresCache` per fire (`dispatch.ts:363-387`).

For each surviving rule, `evaluateProcess(rule.process, ctx, registry)` returns a `RuleResult` of kind `verdict | directive | no_verdict | error | inject_context` (`src/runtime/types.ts:449-454`). The `EvalCtx` is where **`packModels`, `packFsm`, `packProcedure` are threaded** into the eval context, spread-conditionally so LLM primitives resolve pack aliases, FSM primitives read/advance the pack's lifecycle, and procedure injection works without re-loading (`dispatch.ts:389-406`).

Terminal result handling (`dispatch.ts:409-552`):

- `inject_context` → aggregated; only surfaced by the `prompt_submit` and `session_start` hook bins (other kinds warn+drop) (`dispatch.ts:412-428`).
- `directive` → aggregated; only `prompt_submit` surfaces it; profession directives are validated against loaded `team.yaml` and dropped if invalid (`dispatch.ts:430-463`).
- `verdict` → resolve a `DriftPolicy` with precedence **per-rule override → pack default → `defaultPolicyForLevel(level)`** (`dispatch.ts:476-480`). The level-derived fallback honors the authored `level:` (`block`→`block_tool`, else→`warn`, `drift_response.ts:66-68`), so a `drift_response.yaml` is an OVERRIDE, not a prerequisite.

Exit-code mapping (`dispatch.ts:489-552`): `block_tool`/`halt` → `exitCode 2` + short-circuit return (`dispatch.ts:490-497,520-526`); `warn`/`notify_pause` → buffer message, **continue the walk** (so a later pack's FSM-advance side-effect still runs — FU.8) (`dispatch.ts:498-508,527-541`). `auto_correct`/`escalate` are exit-0 stubs (`dispatch.ts:542-551`).

### Worked example — a real skill end-to-end

`packs/builtin/default-discipline/skills/d9-guard/skill.yaml` shows the full skill shape (`load`, `when_to_load`, `triggers`, `rules[].process` with `as:`/`if:` bindings and a terminal `verdict`):

```yaml
name: d9-guard
load: preload
when_to_load:
  - kind: event_type
    type: prompt_submit
triggers:
  - kind: prompt_submit
rules:
  - id: d9-blocking-question-check
    kind: track_check
    process:
      - call: is_automation_mode
        as: automation
      - call: last_assistant_message
        as: msg
      - call: llm_classify
        if: automation.value == true
        as: classification
        args: { model: fast_classifier, prompt: '...{{msg}}...', allowed_labels: [ALLOW, BLOCK] }
      - call: verdict
        if: automation.value == true && classification == "BLOCK"
        args:
          level: warn
          message: 'D9-guard: politeness reflex detected ...'
```

The `if:` on the `verdict` short-circuits to a no-op outside automation — the canonical conditional-execution pattern. The `coding-flow` pack's `manifest.yaml` shows `flows:` template usage and documents the `user_pinned` anti-pattern:

```yaml
name: coding-flow
scope: workflow
flows:
  - template: loopback_gate
    params: { state: researched, trigger: guess_found, back_to: researching }
```

### Authoring mental model (the chain to hold)

`active.json` opt-in → (`detected_by` gates among opted-in) → `loadPack` parses + compiles sugar/flows → scope-sort → per event: `activation_scope` → unload → trigger kind → inbound filter → `requires` → walk `process` → `RuleResult` → drift policy → exit code. Any "my rule didn't fire" debug starts at the top of that chain, not at the rule.

---

## manifest.yaml — every field

`manifest.yaml` is the pack's identity file. It is parsed and validated by the Zod `Manifest` object at `src/packs/schemas/manifest.ts:508-600`. The schema is `.strict()` (`src/packs/schemas/manifest.ts:571`) — an unknown key (e.g. `versoin: 0.1.0`) is a hard load-time error, not a silent default.

Two distinct schemas are in play and you must not conflate them:

- **`Manifest`** (`src/packs/schemas/manifest.ts:508`) validates the **raw `manifest.yaml` document only**. This is what a pack author writes.
- **`Pack`** (`src/runtime/types.ts:351`) is the **parsed-and-merged runtime shape**: manifest + skills + folded-in side-files. The loader (`src/packs/loader.ts`) reads side-files and hoists them onto `Pack`, and camelCases the snake_case manifest keys (`activation_scope`→`activationScope`, `detected_by`→`detectedBy`, `base_version`→`baseVersion`). Fields like `models`, `driftResponse`, `fsm`, `procedure`, `team`, `lastMergedVanilla` are **NOT authored in manifest.yaml** — they come from sibling files (see "Side-file-sourced runtime fields" below).

### The 4 required fields

| Field     | Type                                                                                                | Semantics                                                                                                                      | Schema line                                                         | Real value                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `name`    | `string`, regex `^[a-z0-9][a-z0-9-]*$` (lowercase alphanum + hyphens, no leading hyphen/digit-only) | Pack identity; keys conflict resolution.                                                                                       | `manifest.ts:510-513` (runtime `Pack.name` `types.ts:352`)          | `name: coding-flow` (`packs/builtin/coding-flow/manifest.yaml`)                                                 |
| `version` | `string`, regex `^\d+\.\d+\.\d+` (semver MAJOR.MINOR.PATCH prefix; loose on purpose)                | Pack semver; composite `includes` semver ranges resolve against it.                                                            | `manifest.ts:514` (`types.ts:353`)                                  | `version: 0.2.0` (`packs/builtin/seo-aeo-expert/manifest.yaml`)                                                 |
| `scope`   | enum `universal \| domain \| specialty \| workflow \| project`                                      | LAYERING precedence (universal→…→project), NOT activation location. Ordering enforced by pack-resolution code, not the schema. | enum `manifest.ts:44`, field `manifest.ts:515` (`types.ts:321,354`) | `scope: workflow` (coding-flow); `scope: domain` (seo-aeo-expert)                                               |
| `goal`    | `string`, min length 1                                                                              | One-line purpose; feeds destination-check / matching.                                                                          | `manifest.ts:516` (`types.ts:355`)                                  | `goal: ship verified work with locked drift-gate discipline` (`packs/builtin/default-discipline/manifest.yaml`) |

### Optional manifest fields (author-declared, all have defaults)

| Field               | Type                                                                                                                               | Default                                                                                                       | Semantics                                                                                                                                                                                                                                                                                                                                             | Schema line                                                                    | Real value                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`       | `string`                                                                                                                           | `''`                                                                                                          | Longer prose description.                                                                                                                                                                                                                                                                                                                             | `manifest.ts:517` (`types.ts:356`)                                             | the multi-line `description: \|` block in `packs/builtin/general/manifest.yaml`                                                                                                                                                                                                 |
| `requires`          | `string[]` (pack names)                                                                                                            | `[]`                                                                                                          | Packs that must be co-present.                                                                                                                                                                                                                                                                                                                        | `manifest.ts:518` (`types.ts:357`)                                             | (no builtin uses it; default `[]`)                                                                                                                                                                                                                                              |
| `conflicts`         | `string[]` (pack names)                                                                                                            | `[]`                                                                                                          | Packs that must NOT co-load.                                                                                                                                                                                                                                                                                                                          | `manifest.ts:519` (`types.ts:358`)                                             | (no builtin uses it; default `[]`)                                                                                                                                                                                                                                              |
| `extends`           | `string`                                                                                                                           | — (genuinely optional, **no default** — most packs don't extend)                                              | Parent pack to inherit from.                                                                                                                                                                                                                                                                                                                          | `manifest.ts:520` (`types.ts:359`)                                             | (no builtin uses it)                                                                                                                                                                                                                                                            |
| `evolves`           | `boolean`                                                                                                                          | `true`                                                                                                        | When `true`, the wedge gate MAY mutate the pack's skills; `false` opts out (locked content).                                                                                                                                                                                                                                                          | `manifest.ts:521` (`types.ts:360`)                                             | `evolves: false` (`packs/builtin/task-spec-author/manifest.yaml` — its 11-field format authority is locked)                                                                                                                                                                     |
| `rate_limits`       | `RateLimits` object                                                                                                                | absent → unlimited per trigger                                                                                | Per-trigger caps (`tool_call`/`prompt_submit`/`session_end`/`stop`/`schedule`/`webhook`/`inbound_channel`/`file_changed`), each `{max:int+, per: minute\|hour\|day, concurrent?:int+}`, `.strict()`.                                                                                                                                                  | `manifest.ts:65-89,522-525`                                                    | (schema `packs/.../manifest.ts:68-88`)                                                                                                                                                                                                                                          |
| `permissions`       | `Permissions` object                                                                                                               | absent → **deny-all** for every capability (NOT back-compat — a pack exercising a capability MUST declare it) | Per-capability allowlists: `shell_exec.commands`, `http_request.{domains,methods,deny}`, `file_write.paths`, `send_message.channels`, `subprocess_call.binaries`, `subagent_call.targets`; each block has its own `deny:`. Built-in denylist always wins unless `OPENSQUID_TRUST_BUILTIN_DENY=0`. `.strict()`.                                        | capabilities `manifest.ts:114-124`, blocks `127-187`, field `526-532`          | (schema-defined)                                                                                                                                                                                                                                                                |
| `foundation`        | `Foundation` `{tools:[{name,semver?}], domains:[], methodologies:[]}`, `.strict()`                                                 | absent (`undefined`)                                                                                          | Descriptive taxonomy of what the pack KNOWS. Composites MUST NOT declare it.                                                                                                                                                                                                                                                                          | `manifest.ts:214-220,539` (`types.ts:373`)                                     | the `foundation: {domains:[seo,aeo-geo,…], methodologies:[evidence-gated-recommendations,…]}` block in `packs/builtin/seo-aeo-expert/manifest.yaml`                                                                                                                             |
| `activation_scope`  | enum `project \| user \| hybrid \| team \| global`                                                                                 | `'project'`                                                                                                   | WHERE the pack applies (distinct from `scope:` layering).                                                                                                                                                                                                                                                                                             | enum `manifest.ts:226`, field `540` (runtime `activationScope` `types.ts:374`) | `activation_scope: project` (`packs/builtin/focused-typescript-strict/manifest.yaml`)                                                                                                                                                                                           |
| `detected_by`       | `DetectedByCheck[]` (7-kind discriminated union on `kind`)                                                                         | `[]` (empty = "applies always" per IDF.2)                                                                     | Pure filesystem/memory/prompt-substring auto-activation checks; **no LLM**. Kinds: `file_exists{path}`, `dir_exists{path}`, `file_match{path,matches:{regex}}`, `file_glob{pattern,min_count=1}`, `memory_match{pattern}`, `conversation_signal{pattern}`, `user_pinned`. OR semantics across entries.                                                | union `manifest.ts:232-285`, field `541` (`types.ts:375`)                      | `detected_by:` with `- {kind: file_exists, path: tsconfig.json}` and `- {kind: file_match, path: tsconfig.json, matches: {'compilerOptions.strict': '^true$'}}` (`packs/builtin/focused-typescript-strict/manifest.yaml:30-37`)                                                 |
| `kind`              | enum `focused \| composite`                                                                                                        | `'focused'`                                                                                                   | `focused` = owns content/skills; `composite` = pure aggregator (references via `includes`, MUST NOT declare `foundation`, MUST have non-empty `includes`). Cross-field rules in the `superRefine`.                                                                                                                                                    | enum `manifest.ts:297`, field `545`, refine `572-599` (`types.ts:381`)         | `kind: composite` (`packs/builtin/frontend-react-19-atomic/manifest.yaml`); `kind: focused` (scope-architect)                                                                                                                                                                   |
| `usage`             | enum `active \| profession \| both`                                                                                                | `'active'`                                                                                                    | `active` = loads into parent agent's mind; `profession` = spawned as a subagent (REQUIRES `team.yaml`); `both` = either.                                                                                                                                                                                                                              | enum `manifest.ts:314`, field `546` (`types.ts:382`)                           | `usage: profession` (`packs/builtin/task-spec-author/manifest.yaml`); `usage: both` (scope-architect)                                                                                                                                                                           |
| `includes`          | `CompositeInclude[]` `{pack_id, semver}`, `.strict()`                                                                              | `[]`                                                                                                          | Composite's child packs, pinned by name + semver range; resolved against the focused-pack registry. focused⇒must be empty; composite⇒must be non-empty.                                                                                                                                                                                               | `manifest.ts:324-329,547` (`types.ts:383`)                                     | `includes:` with `- {pack_id: focused-react-19, semver: '>=0.1.0'}` … (`packs/builtin/frontend-react-19-atomic/manifest.yaml`)                                                                                                                                                  |
| `base_version`      | semver string `^\d+\.\d+\.\d+(-…)?`                                                                                                | absent                                                                                                        | **Loader-populated, NOT author-declared.** Immutable vanilla baseline written at install into `~/.opensquid/packs/<name>/personal_revision/version.json`; schema accepts it only for in-memory consistency.                                                                                                                                           | `manifest.ts:347-349,554` (runtime `baseVersion` `types.ts:396`)               | (install-written, not in builtins)                                                                                                                                                                                                                                              |
| `personal_revision` | `PersonalRevision` `{base_version, personal_revision_id=0, last_merged_vanilla=null}`                                              | absent                                                                                                        | **Loader-populated.** Living-pack mutation state (promoted-lesson count, last vanilla merge). Maps to runtime `personalRevisionId` + `lastMergedVanilla`.                                                                                                                                                                                             | `manifest.ts:352-358,555` (runtime `types.ts:397-398`)                         | (install-written)                                                                                                                                                                                                                                                               |
| `seed_lessons`      | `SeedLesson[]` `{title, body XOR body_path, scope=user, tags:[], source?}`, `.strict()` + refine (exactly one of body/body_path)   | `[]`                                                                                                          | Pack-author knowledge ingested into the lessons table at load (eviction-immune; idempotent via `external_id = sha256(pack@version\|title)`). Note: the live `loadPack` no longer ingests at load (the engine-ingest was removed in retire-Rust RES-1, `loader.ts:133-135`); the data still rides on `Pack.seedLessons` for the bootstrap/ingest path. | `manifest.ts:378-396,560` (runtime `seedLessons` `types.ts:416`)               | `seed_lessons:` with `- {title:'AI Mode is the default…', body_path: lessons/ai-mode-default-fanout/lesson.md, tags:[…], source:'https://…'}` (`packs/builtin/seo-aeo-expert/manifest.yaml`); inline `body:` example in `packs/builtin/focused-typescript-strict/manifest.yaml` |
| `verify_gates`      | `VerifyGate[]` `{name (lowercase regex), when:{event_kind}, check (expr str), on_fail:{level: warn\|block, message}}`, `.strict()` | `[]`                                                                                                          | Detect-less "when X then warn/block" check; compiled to a synthetic `verdict` rule. The check-only special case of a guard.                                                                                                                                                                                                                           | `manifest.ts:399-423,561` (runtime `verifyGates` `types.ts:417`)               | the 3 `verify_gates:` entries (e.g. `- {name: no-any-annotation, when:{event_kind: tool_call}, check: 'contains(tool_args.content, ": any")', on_fail:{level: warn, message: …}}`) in `packs/builtin/focused-typescript-strict/manifest.yaml`                                   |
| `guards`            | `Guard[]` `{name, on=tool_call, detect?:{call,args?}, as=hit, when (expr), level: warn\|block, message}`, `.strict()`              | `[]`                                                                                                          | Reusable detect→verdict gate template; compiled by `guards_compiler` into a `TrackCheckRule` under a synthetic `<pack>/guards` skill.                                                                                                                                                                                                                 | `manifest.ts:460-478,565` (runtime `guards` `types.ts:418`)                    | the 21 `guards:` entries (e.g. `- {name: never-amend, on: tool_call, detect:{call: command_invokes, args:{program: git, subcommand: commit, flag_any:['--amend']}}, when: hit, level: block, message: …}`) in `packs/builtin/default-discipline/manifest.yaml`                  |
| `flows`             | `Flow[]` `{template, params={}}`, `.strict()`                                                                                      | `[]`                                                                                                          | Reusable FSM-fragment template; expanded by `flows_compiler` and merged into `fsm.yaml` BEFORE `validateFsm`.                                                                                                                                                                                                                                         | `manifest.ts:491-497,569` (no runtime `Pack` field — merged into `fsm`)        | `flows:` with `- {template: loopback_gate, params: {state: researched, trigger: guess_found, back_to: researching}}` (`packs/builtin/coding-flow/manifest.yaml`)                                                                                                                |

### Side-file-sourced runtime fields (NOT in manifest.yaml)

These appear on the runtime `Pack` type but are read from **sibling files** by the loader, never authored in `manifest.yaml`:

| Runtime field (`types.ts`)                                                                        | Source file                                                | Loader read                            | Semantics                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models` (`types.ts:363`)                                                                         | `models.yaml`                                              | `loader.ts:148`                        | Pack-declared model aliases (e.g. `fast_classifier`, `reasoning`); resolved AFTER env vars + user `~/.opensquid/models.yaml`. Absent → no pack contribution. |
| `driftResponse` (`types.ts:364`)                                                                  | `drift_response.yaml`                                      | `loader.ts:154`                        | Per-rule drift policy: `per_rule[rule.id] ?? default`. Absent → dispatcher default `block_tool`.                                                             |
| `chatAgent` (`types.ts:362`)                                                                      | `chat_agent.yaml`                                          | `loader.ts:141`                        | WAB.6 chat-agent binding. Absent → built-in chat defaults.                                                                                                   |
| `fsm` (`types.ts:420`)                                                                            | `fsm.yaml` (+ merged `flows`)                              | `loader.ts:169`                        | Pack lifecycle FSM, validated total.                                                                                                                         |
| `procedure` (`types.ts:423`)                                                                      | `procedure.md`                                             | `loader.ts:174`                        | Agent-facing operating procedure, injected when the pack engages.                                                                                            |
| `team` (`types.ts:389`)                                                                           | `team.yaml`                                                | `loader.ts:181-200`                    | Subagent roles; loaded iff `usage` is `profession`/`both` (loader ERRORS if missing for those).                                                              |
| `baseVersion` / `personalRevisionId` / `lastMergedVanilla` / `livingVersion` (`types.ts:396-409`) | `~/.opensquid/packs/<name>/personal_revision/version.json` | `loader.ts:131` (read), `:235` (hoist) | Living-pack version triple; only on per-user installed packs, never builtins.                                                                                |

Worked `team.yaml` example (real, `packs/builtin/scope-architect/team.yaml`): a single-role team `{name: scope-architect-team, roles: [{name: scope-architect, pack: scope-architect, model_alias: reasoning, handoff_signal: SCOPE_COMPLETE, instructions: \|…}]}`.

### Minimum-viable pack

The 4 required fields alone are a valid pack (`packs/builtin/cycle-pack/manifest.yaml` adds only `description` + `evolves`):

```yaml
name: cycle-pack
version: 0.1.0
scope: universal
goal: free up context by offloading lessons to RAG via the wedge gate
```

---

## Scopes, Detection & Activation — how a pack engages

A pack author controls engagement with **two orthogonal axes** plus an **opt-in registry**. Confusing them is the single most common authoring error, so internalize the split first:

| Axis                 | Field                                   | Question it answers                                                   | Where it's read                             |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| **Layering scope**   | `scope:` (required)                     | In what _order_ does this pack's rules evaluate relative to others?   | `src/packs/load_order.ts:44-53` (sort only) |
| **Activation scope** | `activation_scope:` (default `project`) | _Where_ does this pack apply (this repo / this user / team / global)? | `src/runtime/hooks/dispatch.ts:233-246`     |
| **Detection**        | `detected_by:` (default `[]`)           | _When_ does this pack auto-engage among the opted-in set?             | `src/runtime/detection.ts:55-83`            |

These are **distinct from each other** and explicitly documented as such: the `activation_scope` schema comment notes it answers "WHERE the pack applies. Distinct from `scope:` (which is LAYERING precedence universal→domain→specialty→workflow→project)" (`src/packs/schemas/manifest.ts:223-224`).

### 1. `scope:` — the 5-level layering hint (does NOT control engagement)

`scope:` is a required enum with exactly five values (`src/packs/schemas/manifest.ts:44`, mirrored in the runtime at `src/runtime/types.ts:321`):

```
universal | domain | specialty | workflow | project
```

Its ONLY runtime effect is **sort order**. `sortPacksByScope` (`src/packs/load_order.ts:44-53`) orders packs `universal(0) → domain(1) → specialty(2) → workflow(3) → project(4)`, breaking ties alphabetically by name. Later packs see earlier packs' state in the same evaluation window (`src/packs/load_order.ts:6-9`). The order is fixed, not author-tunable — "pack authors declare scope, not priority" (`src/packs/load_order.ts:11-15`). Adding a scope value fails the typechecker via the keyed `Record<Scope, number>` map (`src/packs/load_order.ts:33-42`).

Author guidance on the semantics (`src/packs/schemas/manifest.ts:37-40`): `universal`=applies everywhere; `domain`=a class of work (coding, research); `specialty`=a sub-discipline (Rust, frontend); `workflow`=a process pattern (ship-verified-work); `project`=one repo/tenant. Real examples: `coding-flow` is `scope: workflow` (`packs/builtin/coding-flow/manifest.yaml:3`); `focused-react-19` is `scope: domain` (`packs/builtin/focused-react-19/manifest.yaml:15`).

**`scope:` never decides whether a pack engages — only the next two axes do.**

### 2. `activation_scope:` — WHERE the pack applies

A 5-value enum, default `'project'` (`src/packs/schemas/manifest.ts:226`, default set at `:540`). At dispatch the pack is skipped entirely (its whole skill walk via `continue`) if its activation scope doesn't apply (`src/runtime/hooks/dispatch.ts:336`). The total semantics (`src/runtime/hooks/dispatch.ts:233-246`):

- `project` → applies when `ctx.inProject` (cwd matches the project context) — `:235-236`
- `user` → applies when `ctx.isUserSession` (per-user globally) — `:237-238`
- `hybrid` → requires BOTH `inProject && isUserSession` — `:239-240`
- `team` → **ships INERT — `return false` always**; team-mode packs are silently dormant until team infrastructure lands (`dispatch.ts:187-189, 241-242`)
- `global` → today equivalent to `user` (`dispatch.ts:190-191, 243-244`)

**Current-reality caveat (important for authors):** the dispatch context defaults to `{ inProject: true, isUserSession: true }` (`src/runtime/hooks/dispatch.ts:289`), and discovery only loads a pack when cwd already matched. So today `activation_scope` effectively gates out only `team`. Treat `project` vs `user` vs `global` as forward-declared intent (post-v1 multi-user infra), not as a live differentiator. `focused-react-19` declares `activation_scope: project` (`packs/builtin/focused-react-19/manifest.yaml:25`).

### 3. The opt-in gate: `active.json`

A pack engages ONLY if it is listed in an `active.json` at user scope (`~/.opensquid/active.json`) or project scope (`<repo>/.opensquid/active.json`). Schema is `{ packs: string[] }` (`src/packs/discovery.ts:180-183`). The discovery contract (`src/packs/discovery.ts:1-32, 199-251`):

- `scopeRoot === null` or `active.json` ENOENT → `[]` (no packs) — `:204, :218`
- malformed JSON → **throws a path-bearing error** (`:214`); missing/non-array `packs:` → throws (`:222-223`); non-string entry → throws (`:228-232`) — all fail-loud, not fail-open
- a listed name is loaded from `<scope>/packs/<name>/`, falling back to the built-in pack root (`<builtinRoot>/<name>/`) on ENOENT only (`src/packs/discovery.ts:240, 264-287`)

**The opt-in invariant is absolute and end-to-end:** a pack NOT in `active.json` is never loaded "regardless of what its `detectedBy` would say" (`src/packs/discovery.ts:195-197`). `detected_by` filters _within_ the opted-in set; it can never opt a pack in.

### 4. `detected_by:` — WHEN the pack auto-engages (among opted-in)

A discriminated union of **7 check kinds**, all pure (no LLM, no network — "pure filesystem + memory + prompt-substring regex", `src/runtime/detection.ts:15-16`). Schema: `src/packs/schemas/manifest.ts:229-285`. Default `[]` (`:541`).

| kind                  | fields                                  | matches when                                                                                           | evaluator                     |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `file_exists`         | `path`                                  | file present in cwd                                                                                    | `detection.ts:68-69`          |
| `dir_exists`          | `path`                                  | dir present in cwd                                                                                     | `detection.ts:70-71`          |
| `file_match`          | `path`, `matches: {jsonPath: regexStr}` | file is valid JSON AND **every** dotted-path value is a string matching its regex (AND across entries) | `detection.ts:72-73, 85-104`  |
| `file_glob`           | `pattern`, `min_count` (default 1)      | ≥ min_count cwd files match the minimatch glob                                                         | `detection.ts:74-75, 106-116` |
| `memory_match`        | `pattern`                               | regex hits the staged memory bodies                                                                    | `detection.ts:76-77`          |
| `conversation_signal` | `pattern`                               | regex hits recent prompts                                                                              | `detection.ts:78-79`          |
| `user_pinned`         | (none)                                  | `ctx.userPinned` is true                                                                               | `detection.ts:80-81`          |

**Evaluation semantics (`src/runtime/detection.ts:55-64`):**

- **OR across clauses** — `matchesDetectedBy` returns true on the FIRST matching clause (`:60-62`).
- **Empty array → ALWAYS true** ("a pack with no detected_by always applies among opted-in packs", `detection.ts:7-8, 59`).
- Malformed regex silently fails its clause (`safeRegexTest`, `detection.ts:136-142`) — it does not throw.
- `file_match` requires the file to exist with non-empty content and parse as JSON, else the clause is false (`detection.ts:90-97`); JSON paths are shallow dotted lookups only — no `[index]`, no quoted segments (`detection.ts:118-126`).

The staging is eager and one-shot per hook subprocess: `buildDetectionContext` reads existence + contents of well-known files (`package.json`, `tsconfig.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`) at `src/runtime/bootstrap.ts:380-410` (the list is at `:384-390`). **`dirs`, `memoryBodies`, `recentPrompts`, and `userPinned` are NOT yet populated** — they are hardcoded empty/`{}`/`false` (`bootstrap.ts:404-408`).

#### Worked example — auto-activate on React 19 (real, OR-semantics)

From `packs/builtin/focused-react-19/manifest.yaml:40-50`:

```yaml
detected_by:
  # OR semantics — react in either dependencies or devDependencies triggers.
  - kind: file_match
    path: package.json
    matches:
      'dependencies.react': '^(\^|~|>=|=)?\s*19'
  - kind: file_match
    path: package.json
    matches:
      'devDependencies.react': '^(\^|~|>=|=)?\s*19'
```

`focused-atomic-design` mixes `dir_exists` + `file_glob` (`packs/builtin/focused-atomic-design/manifest.yaml:28-38`); `focused-typescript-strict` mixes `file_exists` + nested `file_match` on `compilerOptions.strict` (`packs/builtin/focused-typescript-strict/manifest.yaml:30-37`).

### 5. The EWG.3.1 trap — `detected_by: [user_pinned]` SILENTLY DISABLES a pack

This is the highest-value gotcha for authors and it is code-confirmed. The chain:

1. `user_pinned` evaluates `ctx.userPinned` (`src/runtime/detection.ts:80-81`).
2. `buildDetectionContext` **hardcodes `userPinned: false`** (`src/runtime/bootstrap.ts:408`) — the signal is never populated.
3. Therefore a clause-list `detected_by: [user_pinned]` is a non-empty array that always returns false → `matchesDetectedBy` returns false → the opted-in pack is filtered out at `discovery.ts:241` and **never engages**.

The `coding-flow` manifest documents exactly this and deliberately ships NO `detected_by` so opt-in via `active.json` is the pin (`packs/builtin/coding-flow/manifest.yaml:18-21`):

```yaml
# No detected_by gate: opt-in via active.json IS the pin. A `detected_by:
# [user_pinned]` clause would silently DISABLE an opted-in pack (the user_pinned
# DetectionContext signal is never populated — the EWG.3.1 lesson, see
# docs/pack-runtime.md §1.4).
```

**Authoring rule:** if you want a pack to engage purely on user opt-in, leave `detected_by` ABSENT (defaults to `[]` = always-on among opted-in). Do NOT write `detected_by: [user_pinned]`.

### 6. How an author scopes a pack and controls engagement — decision recipe

1. **Pick `scope:`** by what kind of discipline it is (sort/layering only): `universal`/`domain`/`specialty`/`workflow`/`project`. This is about evaluation order, not engagement.
2. **Decide opt-in surface:** the pack only ever engages once its name is in an `active.json` (user-scope `~/.opensquid/active.json` for personal-everywhere; project-scope `<repo>/.opensquid/active.json` for repo-specific).
3. **Decide auto-activation:**
   - Always-on once opted-in → **omit `detected_by`** (NOT `[user_pinned]`).
   - Conditional on project signals → add `file_exists`/`dir_exists`/`file_match`/`file_glob` clauses (OR-semantics; each `file_match` is internally AND across its `matches`). Only the well-known files listed in `bootstrap.ts:384-390` are currently staged for `file_*` content checks.
4. **Set `activation_scope:`** = `project` (default; current de-facto behavior), or forward-declare `user`/`global` intent. Avoid `team` (ships inert).
5. **Composite packs** (`kind: composite`) gate WHEN to expand their `includes:` via `detected_by` too — that is explicitly allowed (`src/packs/schemas/manifest.ts:598`); expansion runs after per-pack detection filtering (`src/packs/discovery.ts:245-250`).

---

## Pack Lifecycle FSMs + Flow Templates

A pack can declare its behavior lifecycle as a **total-transition FSM** in a `fsm.yaml` side-file, plus reusable re-do edges as `flows:` template invocations in `manifest.yaml`. This is the capstone "a PACK is the total definition of an agent's behavior" thesis made concrete: the machine is _total by construction_ — every `(state, event)` pair has a defined outcome (a matching transition, else an explicit stay), and every declared transition is proven to land on a real state at load time.

### 1. The FSM schema (what you author in `fsm.yaml`)

The schema lives in `src/runtime/fsm.ts`. The `Fsm` zod object is `fsm.ts:48-55` and is `.strict()` (no extra keys) — exactly three fields:

| Field         | Type                          | Rule                                                             |
| ------------- | ----------------------------- | ---------------------------------------------------------------- |
| `initial`     | string (min 1)                | MUST be one of `states` (enforced by `validateFsm`, `fsm.ts:67`) |
| `states`      | string[] (min 1)              | the complete state set (`fsm.ts:51`)                             |
| `transitions` | `Transition[]` (default `[]`) | edges (`fsm.ts:52`)                                              |

A `Transition` (`src/runtime/fsm.ts:34-46`, also `.strict()`):

| Field  | Type                     | Meaning                                                                        |
| ------ | ------------------------ | ------------------------------------------------------------------------------ |
| `from` | string (min 1)           | source state, or `*` to match **any** current state (`ANY_STATE`, `fsm.ts:32`) |
| `on`   | string (min 1)           | event name that fires the edge                                                 |
| `to`   | string (min 1)           | target — MUST be a declared state (`validateFsm` enforces, `fsm.ts:74`)        |
| `when` | string (min 1), optional | guard expression, evaluated via an injected `evalWhen` (`fsm.ts:42-43`)        |

### 2. What makes it TOTAL (the two pure functions)

`validateFsm(fsm)` (`src/runtime/fsm.ts:63-79`) runs at load and returns a list of human-readable errors (empty = valid). It checks: (a) `initial` is a declared state (`fsm.ts:67`); (b) for every transition, `from` is either `*` or a declared state (`fsm.ts:71`); (c) `to` is a declared state (`fsm.ts:74`). A non-empty result throws at load (`loader.ts:374-377`), so a typo'd endpoint is a loud config bug, never a silently-dead edge.

`step(fsm, current, event, evalWhen?)` (`src/runtime/fsm.ts:98-113`) is the transition function. It is **total**: it scans transitions in order and returns the FIRST one whose `from` matches (`current` or `*`) AND `on === event` AND `when` holds (`when === undefined || evalWhen === undefined || evalWhen(when)`, `fsm.ts:107`). No match → it **stays** in `current` with `{transitioned:false, via:null}` (`fsm.ts:112`). There is no undefined/implicit state — this is the no-implicit-state principle in code. Authoring implications:

- **Order matters.** First match wins (`fsm.ts:104-110`). Put more-specific `from: <state>` edges before broad `from: '*'` edges if they share an `on`.
- **Loop-backs are first-class.** `from` and `to` may be the same region (e.g. `researched --guess_found--> researching`) — the engine explicitly supports redo edges (module doc, `fsm.ts:23-24`).
- **`when` is the only place a guard can suppress an otherwise-matching edge.** The caller wires the expression engine; with no `evalWhen` supplied, guards are treated as satisfied (`fsm.ts:107`).

`StepResult` (`fsm.ts:81-88`) returns `next`, `transitioned` (true iff state actually changed), and `via` (the transition index taken, or `null` for the stay default).

### 3. Where the FSM attaches to the Pack

The optional `fsm` field is on the runtime `Pack` type (`src/runtime/types.ts:419-420`: `fsm: Fsm.optional()` — "Pack-declared lifecycle FSM (slice A2; from `fsm.yaml`). Validated total."). The loader reads `fsm.yaml` if present; ENOENT → `undefined` (a pack with no lifecycle FSM is valid). See `loadOptionalFsm` (`src/packs/loader.ts:344-379`).

### 4. Flow templates — `flows:` in `manifest.yaml`

A reusable re-do/quality-gate edge is not hand-written into `fsm.yaml`; it is declared as a `{template, params}` invocation under `flows:` in the manifest. The schema is `Flow` (`src/packs/schemas/manifest.ts:491-497`, `.strict()`):

```
flows:                                # array, default [] (manifest.ts:569)
  - template: <string, min 1>         # registry key
    params: { ... }                   # record, default {}
```

`flows_compiler.ts` (`src/packs/flows_compiler.ts`) holds a **flat template registry** (`FLOW_TEMPLATES`, `flows_compiler.ts:32`) of pure `params → {states, transitions}` expanders. The only registered template today is **`loopback_gate`** (`flows_compiler.ts:37-49`):

- Params: `{ state, trigger, back_to }` — all three must be strings, else fail-loud (`flows_compiler.ts:39-43`).
- Expansion: contributes **no states** and **one transition** `{ from: state, on: trigger, to: back_to }` (`flows_compiler.ts:47`). A loop-back connects two _existing_ spine states, so both endpoints must already be declared in `fsm.yaml`; `validateFsm` on the merged machine catches a typo'd endpoint (`flows_compiler.ts:34-36`).

`compileFlows(packName, flows)` (`flows_compiler.ts:62-86`) dedups states, concatenates transitions, and is **fail-loud**: an unknown template lists the known set (`flows_compiler.ts:70-72`) and bad params are prefixed with the pack name (`flows_compiler.ts:77`) — never silently dropped (mirrors `compileGuards`).

### 5. How flows MERGE into the machine (the load pipeline)

In `loader.ts` the order is exact and load-bearing (`src/packs/loader.ts:165-169`):

1. `compileFlows(manifest.name, manifest.flows)` → fragment; `!ok` throws (`loader.ts:165-168`).
2. `loadOptionalFsm(join(dir,'fsm.yaml'), flowsResult.expansion)` (`loader.ts:169`) parses `fsm.yaml` via the `Fsm` zod schema (`loader.ts:350-351`), then **merges the fragment** — dedup states, append transitions — and only THEN runs `validateFsm` (`loader.ts:369-377`). So totality is verified on the **expanded** machine, not the hand-authored one.
3. Edge case: a `flows:` block with no `fsm.yaml` to merge into is a loud bug — `flows: declared but no fsm.yaml to merge into` (`loader.ts:359-364`).

### 6. Runtime driver (how events advance state)

`advanceFsmState(sessionId, packName, fsm, event, now, evalWhen?)` (`src/runtime/fsm_state.ts:79-109`) reads the persisted state for `(session, pack)`, runs the pure `step` (`fsm_state.ts:88`), and persists + appends history **only when `transitioned` is true** (`fsm_state.ts:89-107`). A non-matching event leaves the file untouched. The current state is read from the FSM state file, falling back to `fsm.initial` (`readFsmState`, `fsm_state.ts:56-67`). The dispatcher threads `pack.fsm` through as `packFsm` (`src/runtime/hooks/dispatch.ts:402`).

### 7. Worked example — the built-in `coding-flow` pack

`packs/builtin/coding-flow/fsm.yaml` declares a 9-state, three-region lifecycle (`fsm.yaml:12-22`): `idle → scoping → researching → researched` (SCOPE) → `spec_authored → spec_complete → tasks_loaded` (TASK AUTHORING) → `phases_in_flight → phases_complete` (CODE).

Two patterns worth copying verbatim:

**(a) `from: '*'` task-start reset** (`fsm.yaml:44`):

```
- { from: '*', on: task_unscoped, to: scoping }
```

The FSM is session-level, so a new unscoped task must re-arm the scope gate from ANY state — `step()` matches `*` (`fsm.ts:106`).

**(b) Terminal re-arm, deliberately narrow** (`fsm.yaml:52`):

```
- { from: phases_complete, on: scope_start, to: scoping }
```

`scope_start` is valid only from `idle` (`fsm.yaml:25`) and `phases_complete` (`fsm.yaml:52`); from mid-run states it is a silent no-op (the stay default), so a stray scope keyword cannot reset an in-flight authoring run.

**(c) The loop-back declared as a FLOW, NOT a hand-written edge.** `fsm.yaml:29-30` documents that `researched --guess_found--> researching` is intentionally absent from `transitions:` — it is declared in `manifest.yaml:27-30`:

```
flows:
  - template: loopback_gate
    params: { state: researched, trigger: guess_found, back_to: researching }
```

At load, `compileFlows` expands this to `{ from: researched, on: guess_found, to: researching }`, the loader appends it, and `validateFsm` passes because both `researched` and `researching` are declared spine states. The parity test proves the merged edge is live: `step(pack.fsm!, 'researched', 'guess_found')` yields `{ next: 'researching', transitioned: true }` (`test/builtin/coding-flow.test.ts:130-133`), and the totality assertion `validateFsm(pack.fsm!)` returns `[]` (`coding-flow.test.ts:125`, in the load/totality test `coding-flow.test.ts:110-126`).

Note also (`manifest.yaml:18-21`): `coding-flow` ships NO `detected_by` clause on purpose — opt-in via `active.json` IS the pin; a `detected_by: [user_pinned]` clause would silently DISABLE the pack because the `user_pinned` signal is never populated.

### 8. Authoring checklist (a perfect lifecycle FSM)

1. List every lifecycle state and pick `initial` — all states declared up front (`fsm.ts:51`).
2. Write `transitions` as `{from, on, to}` (+ optional `when`). Order specific-before-wildcard when they share an `on`.
3. For redo/quality-gate edges between two existing states, prefer a `flows:` `loopback_gate` in `manifest.yaml` over a hand-written transition — it self-documents intent and is the reusable pattern.
4. Use `from: '*'` only for genuine any-state resets (task-start re-arm); keep terminal re-arms pinned to the specific terminal state.
5. Rely on `validateFsm` to catch undeclared endpoints; rely on `step`'s explicit-stay to handle every non-matching event — never add a "catch-all" state.
6. Remember the merge order: flows expand → merge into fsm.yaml → THEN validate. A `flows:` block requires a `fsm.yaml`.

---

## Skills (`skill.yaml`)

A **skill** is the unit of work-discipline inside a pack — it declares _when_ it is in scope and _what_ it checks. One pack ships many skills (`packs/builtin/coding-flow/skills/<name>/skill.yaml`). The authoritative load-time schema is `src/packs/schemas/skill.ts:292-323`; a deliberately-mirrored runtime schema (`src/runtime/types.ts:291-312`) is the cross-process contract the dispatcher/evaluator/MCP-tool seam validate against. The runtime schema's header comment (`src/runtime/types.ts:238-242`) records _why_ the two are duplicated and states the two must stay aligned — alignment is asserted by `validatePackFunctions` (`src/packs/validate_functions.ts`, exported at `src/packs/index.ts:25`) plus the runtime type-checks against `Rule`; there is no single dedicated "schema parity" test file.

> Note on the two `ProcessStep`/`Skill`/`Rule` schemas: the **YAML path goes through `src/packs/schemas/skill.ts`** (load-time, stricter — `if:` grammar-checked via `conditionString`, `track_check.process` is `.min(1)`); `src/runtime/types.ts` is the looser runtime mirror (e.g. `ProcessStep.if` is `z.string().optional()` at `src/runtime/types.ts:215`, and `TrackCheckRule.process` has no `.min(1)` at `src/runtime/types.ts:250`) for the env-var test seam. The two-schema relationship is called out in the skill.ts header comment (`src/packs/schemas/skill.ts:95-98`).

### Top-level skill fields

| Field          | Schema                                         | Default                                                        | Meaning                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | `z.string().min(1)` (`skill.ts:293`)           | — (required)                                                   | Skill id (also its human-facing display label).                                                                                                                                                                                             |
| `load`         | `'preload' \| 'lazy'` (`skill.ts:282-283,294`) | `lazy`                                                         | `preload` = loaded at session start, stays loaded (always-active discipline). `lazy` = activated when `when_to_load` fires, removed per `unloads_when`. Default is `lazy` per the reduced-context-first principle (`skill.ts:278-279`).     |
| `when_to_load` | `z.array(Matcher)` (`skill.ts:295`)            | `[]`                                                           | OR-list of activation matchers for `lazy` skills (see below). Empty list never self-activates (`load_matchers.ts:21-23`).                                                                                                                   |
| `requires`     | `z.array(SkillRequires)` (`skill.ts:303`)      | `[]`                                                           | AND-semantic preconditions evaluated at the dispatcher boundary **before** any rule runs. Empty = trivially holds (`skill_requires.ts:84-85`).                                                                                              |
| `unloads_when` | `z.array(UnloadCondition)` (`skill.ts:304`)    | `[]`                                                           | OR-list of exit conditions (`unload_conditions.ts:45-50`). Empty = stays loaded until session end.                                                                                                                                          |
| `triggers`     | `z.array(Trigger).min(1)` (`skill.ts:315-318`) | `[{kind:'tool_call'}]` (`defaultTriggers`, `event.ts:335-337`) | Which `Event` kinds the dispatcher even evaluates this skill against. **Empty `[]` is REJECTED** (`.min(1)` — `skill.ts:317`); omit the block to default — the loader never silently disables or silently all-enables (`skill.ts:310-318`). |
| `rules`        | `z.array(Rule)` (`skill.ts:319`)               | `[]`                                                           | The processes (see Rules below).                                                                                                                                                                                                            |
| `tools`        | `z.array(z.string())` (`skill.ts:320`)         | `[]`                                                           | Bundled skill-internal scripts — **NOT** MCP tools (`skill.ts:288`).                                                                                                                                                                        |
| `prose`        | `z.string().optional()` (`skill.ts:321`)       | —                                                              | LLM-facing guidance, loaded only when the skill is active; also the **selection signal** (see below).                                                                                                                                       |

### `triggers` (kind) — the event-kind gate

`triggers` is a discriminated union on `kind` over the **ten** `EventKind` literals (`src/runtime/event.ts:229-241` for the `EventKind` enum; the `Trigger` union itself is `src/runtime/event.ts:284-320`): `tool_call`, `post_tool_call`, `prompt_submit`, `session_end`, `stop`, `session_start`, `schedule`, `webhook`, `inbound_channel`, `file_changed`. (Several in-tree comments still say "eight kinds" — that prose predates AUTO.1/POSTPUSH.1/HH6.1; the `z.enum` list is the source of truth.) The dispatcher skips the entire skill unless `event.kind ∈ skill.triggers.map(t=>t.kind)` (`hooks/dispatch.ts:347`). The four host-hook kinds (`tool_call` / `prompt_submit` / `session_end` / `stop`) carry **no filter args** — in-rule primitives (`tool_name`, `tool_args`, `match_command`) do per-event filtering (`event.ts:252-256`). The non-tool-call kinds carry optional filter args read by their trigger source: `schedule.cron`, `webhook.path`, `inbound_channel.channel`/`sender_pattern`, `file_changed.paths`/`ignored`, all with optional `cost_tier` (`event.ts:282-318`). For `inbound_channel`, the dispatcher additionally enforces `sender_pattern`/`channel` scheme matching (`hooks/dispatch.ts:356-362`).

### `when_to_load` matchers (for `lazy` skills)

OR-list, four kinds (`load_matchers.ts:60-65`), with author shorthand normalized to canonical form (`load_matchers.ts:86-105`):

| Matcher           | Canonical                                | Shorthand                     |
| ----------------- | ---------------------------------------- | ----------------------------- |
| `tool_match`      | `{kind:tool_match, tool: Bash}`          | `- tool_match: Bash`          |
| `command_pattern` | `{kind:command_pattern, pattern:'^git'}` | `- command_pattern: '^git'`   |
| `file_glob`       | `{kind:file_glob, glob:'src/**/*.ts'}`   | `- file_glob: 'src/**/*.ts'`  |
| `event_type`      | `{kind:event_type, type:prompt_submit}`  | `- event_type: prompt_submit` |

`matchesEvent` (`load_matchers.ts:170-195`) is pure: the first three only fire on `tool_call` events (`load_matchers.ts:176`); `event_type` matches any kind (`load_matchers.ts:172-174`). `file_glob` reads `file_path`→`path`→`notebook_path` in that precedence (`load_matchers.ts:153-160`).

### `unloads_when` (for `lazy` skills)

OR-list, three kinds (`unload_conditions.ts:45-50`; evaluated in `shouldUnload`, `unload_conditions.ts:113-123`): `active_task_completes` (Stop event), `session_ends`, `idle_n_turns: <n>` (n UserPromptSubmit cycles without activation — a "turn" is a UPS cycle, not a tool call). Shorthand: bare strings for the no-arg kinds, `{idle_n_turns: 5}` for the arg form (`unload_conditions.ts:69-83`).

### `requires` (preconditions)

AND-semantic discriminated union (`skill_requires.ts:47-51`), two kinds: `automation_mode_on` (stats `sessions/<id>/automation.flag`) and `active_task_present` (stats `sessions/<id>/active-task.json`). Evaluated at the dispatcher _before_ the rule walk (`hooks/dispatch.ts:370-373`); empty array short-circuits true (`skill_requires.ts:84-85`). **Fail-open in the engaged direction**: any stat error other than `ENOENT` returns `true` so a `chmod 000` blip never silently disables a skill (`skill_requires.ts:115-131`). A per-fire `RequiresCache` stats each file once per dispatch across all skills (`skill_requires.ts:61-80`). Rules can ALSO carry their own `requires` (`skill.ts:148-157`), evaluated after the skill-level ones (`hooks/dispatch.ts:384-387`).

### `prose` — its role

`prose` is the skill's human-facing description. It is **not** a selection signal: the V1 two-tier prose-based selection funnel — an embedding `prefilter` plus an LLM `router` that ranked skills by prose similarity — was **removed at the V1→V2 cutover**. The FSM STATE is the router now: a pack's FSM binds its skills on state entry and unloads them on leave (`runtime/skill/state_skills.ts`), gated by the dispatcher's trigger-kind + `requires`, and — for lens disciplines — by the `serves` taxonomy match (`packs/schemas/pack_v2.ts`, `packs/skill_serves.ts`). So `prose` documents the skill (and is available for context injection); it no longer drives whether the skill loads.

### Rules and the process model

Each rule is a discriminated union on `kind` (`skill.ts:207-222`), default `track_check` (filled by the preprocess shim at `skill.ts:207-219`):

- **`track_check`** (`skill.ts:145-157`): `id` (`.min(1)`), optional per-rule `requires` (default `[]`), and `process: ProcessStep[]` (`.min(1)` — a stepless rule is a YAML mistake, `skill.ts:156`). This is the deterministic workflow rule walked per event.
- **`destination_check`** (`skill.ts:180-187`): `id`, `interval.every_n_tool_calls`, `model_alias` (default `reasoning`), `prompt_template`. It fires on the scheduler tick (via the dedicated `check_destination` path) — the dispatcher explicitly **skips** it in the per-event walk (`hooks/dispatch.ts:374-379`).

A **`ProcessStep`** (`skill.ts:101-113`) has:

- `call` — the primitive function name (`verdict`, `advance_fsm`, `read_fsm_state`, `write_state`, `tool_name`, `cached_audit`, …).
- `args` — opaque key-value bag (`z.record(z.unknown()).optional()`; per-primitive Zod refinement lives in the function registry, not here).
- `as` — binds the call's result to a variable for later steps (`as: tool` then `if: tool == "Write"`).
- `if` — a conditional expression, **grammar-validated at load time** via `conditionString`/`parseExpression` (`skill.ts:70-81`); an unparseable `if:` fails `loadPack()` with the source path and field position (`skill.ts:54-61`). Empty/whitespace `if:` ≡ no `if:` (`skill.ts:72`, mirroring runtime `evalCondition` at `src/runtime/evaluator/expression/index.ts:82`).
- `on_empty` — `pass`/`block`/`continue` when the call yields no output (`skill.ts:106`).
- `on_error` — `abort` (default → step error aborts the process) or `continue` (bind the error message to `as` and proceed, so a rule can branch on a failed step — the F0c audit-spawn-failure pattern: `skill.ts:107-112`, used at `scope-lifecycle/skill.yaml:116`).

**Side-effects of the key primitives** (registered in `src/functions/`):

- `verdict` (`src/functions/verdict.ts:77-88`) — the primitive itself just re-emits its parsed args (`ok(args)`, `src/functions/verdict.ts:87`); the **evaluator** special-cases the call (`src/runtime/evaluator.ts:232`): `if (step.call === 'verdict' && isVerdict(result.value))`, and `level: 'directive'` becomes a `kind:'directive'` RuleResult while every other level becomes `kind:'verdict'` (`src/runtime/evaluator.ts:233`; RuleResult variants at `src/runtime/types.ts:449-454`). Levels: `pass|block|warn|surface|directive` (`VerdictLevel` enum at `src/runtime/types.ts:67`; the `Verdict` discriminated union at `src/runtime/types.ts:113-139` — `directive` carries `next_action` instead of `message`).
- `advance_fsm` (`src/functions/fsm.ts:51-70`) — fires a named `event` against the pack's threaded `fsm.yaml`, **persists** the new state (atomic write via `atomicWriteFile`, `src/runtime/fsm_state.ts:103`) and returns the next state; no-op `ok(null)` if the pack ships no FSM (`fsm.ts:58`).
- `read_fsm_state` (`src/functions/fsm.ts:36-49`) — reads the persisted lifecycle state (own pack via threaded FSM, or another pack's raw state string via the optional `pack` arg).
- `write_state` (`src/functions/state.ts:119`) / `read_state` (`src/functions/state.ts:95`) — persist/read arbitrary session key-values (used to thread design content, paths, track-type across turns).

The dispatcher walks each rule's `process` via `evaluateProcess` (`hooks/dispatch.ts:407`); `inject_context` results aggregate across skills and surface only on `prompt_submit`/`session_start` (`hooks/dispatch.ts:412-419`).

### One fully annotated rule (real, from `scope-lifecycle/skill.yaml`)

The SCOPE re-arm rule (`packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml:25-41`) — placed FIRST so the FSM re-arms before later advances fire:

```yaml
- id: rearm-on-pre-research-write # rule id (track_check by default)
  process:
    - call: tool_name # read the pending tool's name…
      as: tool #   …bind it to `tool`
    - call: tool_args # read the tool's args…
      as: targs #   …bind to `targs`
    - call: read_fsm_state # read this pack's persisted FSM state…
      as: st #   …bind to `st`
    - call: advance_fsm # SIDE-EFFECT: fire an FSM transition…
      if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/research/") && contains(targs.file_path, "-pre-research-") && (st == "phases_complete" || st == "idle")'
      args: #   …only when the guard holds:
        event: scope_start #   a pre-research write from a terminal state
    - call: write_state # SIDE-EFFECT: persist the track type…
      if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/research/") && contains(targs.file_path, "-pre-research-") && (st == "phases_complete" || st == "idle")'
      args:
        key: coding-flow-track
        value: feature
```

What it demonstrates: `as`-bindings feed later `if:` guards; `advance_fsm` is the FSM side-effect (no-op from non-terminal states because `scope_start` has edges only from `idle`/`phases_complete` per the pack's `fsm.yaml`, as the skill's own comment notes at `skill.yaml:21-22`); `write_state` records cross-turn context. The audit-bearing sibling rule `scope-advance` (`skill.yaml:49-187`) shows the full pattern: `cached_audit` with `on_error: continue` (`skill.yaml:114-130`, the `on_error: continue` line is `skill.yaml:116`), then a clean partition of `verdict`/`advance_fsm` steps over the audit string (GUESS_FREE → advance, `skill.yaml:158-161`; UNRESOLVED → loop-back + warn, `skill.yaml:164-176`; no-VERDICT → block, no advance — the fail-closed audit-unavailable branch at `skill.yaml:179-187`).

---

## The Primitive / Function Library

Primitives are the atomic operations a pack composes — via YAML `process:` steps (`- call: <name>` with `args:` and an optional `as:`/`bind:` to name the result) or a rule's `detect:` block — into rule logic. The runtime ships them; packs never `import` them. Authors compose, the registry dispatches.

### How the registry works (the contract every primitive obeys)

- **Single dispatch path.** A `call:`/`function:` ref resolves through `FunctionRegistry.call(name, rawArgs, ctx)` (`src/functions/registry.ts:208-229`). There is no global `import { add }` shortcut — the registry is the only door (`registry.ts:1-8`).
- **Typed args, validated before execute.** Every `FunctionDef` carries its own Zod `argSchema` (`registry.ts:121-131`); `call()` `safeParse`s the args and returns `err({kind:'arg_invalid'})` on mismatch (`registry.ts:220-227`) so the primitive only ever sees well-typed input. Most schemas use `.strict()` so a YAML typo becomes `arg_invalid` rather than a silently-dropped field (e.g. `event.ts:48`, `verdict.ts:59-65`).
- **Result, not throw.** Primitives MUST NOT throw inside `execute`; runtime failures travel as `Result<T,FunctionError>` with `kind: 'arg_invalid' | 'runtime' | 'timeout' | 'not_found'` (`registry.ts:78-82`). Wrong-kind events return a benign value (`ok(null)` / `ok(false)`), NOT an error — wrong-kind is normal control flow (`event.ts:17-21`).
- **Durability metadata (DURABLE.2).** Every `FunctionDef` declares `durable`, `memoizable`, `costEstimateMs` (`registry.ts:121-131`). `durable:true` checkpoints after each call so a crash resumes mid-rule (used for expensive/side-effecting primitives). `memoizable:true` caches identical `(fn,args)` within a run — the memo key EXCLUDES `ctx`, so a memoizable primitive must be transitively ctx-pure (`registry.ts:99-110`; `memo_purity.test.ts`/FAC.1). Omitting `durable` triggers a registration-time `console.warn` (`registry.ts:168-174`). **Authoring takeaway:** any primitive that reads `ctx.event` or `ctx.packModels` is `memoizable:false` (see `text_pattern_match.ts:67-70`, `llm.ts:129-132`).
- **EvalCtx** handed to every primitive carries `event`, `bindings` (the rule's local var scope), `sessionId`, `packId`, and the threaded pack assets `packModels` / `packFsm` / `packProcedure` (`registry.ts:40-66`). Primitives mutate only via documented side effects (state I/O), never via `bindings`.

### Matchers (gate on what the event is)

| Primitive                | Args                                                                                                | Returns                                                                                                                                                                                       | When to use                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`command_invokes`**    | `{ program, subcommand?, flag_any?: string[], arg_any?: string[] }` (`event.ts:55-63`)              | `ok(bool)`; `ok(false)` if not a `tool_call` (`event.ts:205-218`)                                                                                                                             | **PREFER for ALL command gates.** Parses the command into real shell segments and matches a genuine `program` invocation (basename) with optional subcommand/flag/positional. Compounds like `cd … && git commit` still match; prose/grep/echo do NOT false-fire. Delegates to `shell_parse.commandInvokes` (`event.ts:38,215`).                                                                                                                                 |
| **`match_command`**      | `{ pattern: string, target?: string }` (`event.ts:49-52`)                                           | `ok(bool)`; `ok(false)` off-`tool_call`; `err(arg_invalid)` on bad regex (`event.ts:175-196`)                                                                                                 | **EVADABLE — raw regex against the command string. RESERVE FOR NON-COMMAND STRING MATCHING ONLY.** `target` is a shallow `tool_args.<field>` lookup (default `command`, one level deep — `event.ts:75-82`). It false-fires on `git commit` appearing inside a grep pattern / echo arg / quoted prompt, which is exactly why every git/version gate was migrated off it (see callout below).                                                                      |
| **`text_pattern_match`** | `{ text_field: string, patterns: string[], case_sensitive?=false }` (`text_pattern_match.ts:40-46`) | `ok({ matched: string[], phrases: {phrase,offset}[] })`; graceful `{matched:[],phrases:[]}` if the dotted field path misses; `err(arg_invalid)` on bad regex (`text_pattern_match.ts:60-106`) | Scan any event text field (dot-notation, e.g. `assistantText`) for drift-prone phrases. Per-pattern 10ms wall-clock cap (`text_pattern_match.ts:38,94-99`). Backs `verify-before-citing-memory`.                                                                                                                                                                                                                                                                 |
| **`path_exists`**        | `{ dir: string, pattern: string, base_file?: string }` (`path_exists.ts:39-55`)                     | `ok({ exists: bool, matches: string[] })`; `err(arg_invalid)` if `dir` is absolute or escapes the subtree (`path_exists.ts:99-121`)                                                           | Read-only single-dir (non-recursive) basename-glob (`*`,`?`) scan, resolved against the event cwd — or, with `base_file` set, against that file's GIT REPO ROOT (fixes the cross-repo false-block where a planning-repo spec is edited from a code-repo cwd, `path_exists.ts:45-53,105-113`). Backs the scope-decomposer "no pre-research artifact on disk" gate. `memoizable:false` so it sees an artifact the moment it's created (`path_exists.ts:21-25,96`). |
| **`staged_docs_only`**   | `{}` (`staged_docs_only.ts:33`)                                                                     | `ok(bool)`; fails toward `false` on any error / non-tool_call / absent cwd (`staged_docs_only.ts:44-57`)                                                                                      | True iff the staged diff is docs-only, by the same `isDocsOnly` predicate the hard EXECUTE gate uses (predicate parity). Uses FIXED-argv git (`git diff --cached --name-only`, no shell) so it does NOT reopen the shell_exec capability decision (`staged_docs_only.ts:9-13,48`). Lets an in-session nudge mirror the git-owned boundary.                                                                                                                       |

> **GM migration / command_boundary regression guard — the #1 authoring rule.** The default-discipline command gates were once `^`-anchored `match_command` regexes. FU.14 swapped the anchor for a command-boundary prefix; GM.3 (`wg-52e57e2ed252`) migrated the git-commit-class gates onto `command_invokes`; GMP.1 (`wg-320845a92b65`) migrated the last two (`no-force-push-main`, `versioning-pre1-patch-only`) by adding `arg_any` positional/refspec matching. **ALL git/version gates are now structural `command_invokes`, not evadable substring regex.** This is enforced against regression by `src/packs/command_boundary.skill.test.ts` (header `:1-15`; the regression assertions are `:47-68`). When authoring a command gate: reach for `command_invokes`; only use `match_command` for genuinely non-command text.

### Tool-context readers (pure reads off `ctx.event`)

All are `durable:false, memoizable:false, costEstimateMs≈0.1` and return `ok(null)` on wrong-kind (`event.ts:90-173`).

| Primitive                | Args                                                                                                                                           | Returns                                                                                                                      | When to use                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `tool_name`              | `{}`                                                                                                                                           | tool string on `tool_call`/`post_tool_call`, else `null` (`event.ts:90-104`)                                                 | Branch on which tool fired.                                                                                          |
| `tool_args`              | `{}`                                                                                                                                           | the raw args object on `tool_call`, else `null` (`event.ts:106-116`)                                                         | Read tool input fields.                                                                                              |
| `cwd`                    | `{}`                                                                                                                                           | event cwd on `tool_call`, else `null` (`event.ts:118-128`)                                                                   | Path/repo-scoped gating.                                                                                             |
| `effective_content`      | `{}`                                                                                                                                           | post-write file content (`Write`→content; `Edit`/`MultiEdit`→reconstructed result; else `''`) (`effective_content.ts:43-77`) | Feed the SCOPE/AUTHOR content audits the REAL resulting file — Edit-safe, unlike the Edit-empty `tool_args.content`. |
| `current_prompt`         | `{}`                                                                                                                                           | prompt string on `prompt_submit`, else `null` (`event.ts:161-173`)                                                           | Interpolate the user prompt into an `llm_classify` prompt (request-type refinement).                                 |
| `last_assistant_message` | `{}`                                                                                                                                           | `stop`→`assistantText`; `prompt_submit`→settled `priorAssistantText`; else `null` (`event.ts:130-145`)                       | Scan the prior assistant turn for drift phrases.                                                                     |
| `recent_turns`           | `{}`                                                                                                                                           | role-labeled last-N turns on `prompt_submit`, else `null` (`event.ts:147-159`)                                               | Multi-turn context for classification.                                                                               |
| `session_tool_history`   | `{ scope?: 'current_turn' \| 'session' \| 'since_scope_start' (def current_turn), filter_names?: string[] }` (`session_tool_history.ts:36-41`) | `ok({ tools: string[], count })` (`session_tool_history.ts:48-64`)                                                           | Has tool X run this turn/session? (e.g. verify-before-citing checks for a recall.)                                   |

### State I/O (`src/functions/state.ts`)

All `durable:false, memoizable:false` — state changes between calls, so memoizing would go stale (`state.ts:89-93`).

| Primitive     | Args                                       | Returns                                                                                | When to use                                                                                                                                    |
| ------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_state`  | `{ key, pack? }` (`state.ts:50`)           | parsed JSON, or `ok(null)` on ENOENT (`state.ts:100-116`)                              | Read pack/session state. `pack` namespaces under `packs/<id>/state/`; omitted = session scope. ENOENT→null is the canonical "no state" signal. |
| `write_state` | `{ key, value, pack? }` (`state.ts:51-55`) | `ok(undefined)`; atomic tmp+rename (`state.ts:118-137`)                                | Persist a value.                                                                                                                               |
| `append_log`  | `{ name, entry }` (`state.ts:56`)          | `ok(undefined)`; lock-serialized JSONL append via proper-lockfile (`state.ts:139-172`) | Append to a session log with concurrent-writer safety.                                                                                         |

### FSM (`src/functions/fsm.ts`) — drive the pack's own lifecycle

| Primitive        | Args                      | Returns                                                                                                    | When to use                                                                                                                |
| ---------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `read_fsm_state` | `{ pack? }` (`fsm.ts:32`) | current state string; `null` if pack ships no `fsm.yaml` (`fsm.ts:36-49`)                                  | Gate on lifecycle (`if: st == "researching"`). `pack` reads ANOTHER pack's state (cross-pack gating).                      |
| `advance_fsm`    | `{ event }` (`fsm.ts:33`) | new state (== current if the event matched no transition — total/no-op); `null` if no FSM (`fsm.ts:51-70`) | Fire a lifecycle event; guards (`when`) are evaluated through the expression engine over current bindings, then persisted. |

### Audit / LLM (model-neutral — packs say `model: fast_classifier`, never a vendor id; `llm.ts:1-12`)

| Primitive           | Args                                                                                                                                           | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | When to use                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_call`     | `{ model, prompt, timeout_ms?(1..600000) }` (`llm.ts:65-69`)                                                                                   | `ok(stdout)`; `err(arg_invalid)` on unknown alias, `err(runtime)` on spawn/timeout (`llm.ts:87-123`). `durable:true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Full model response — narrative/long-form. Resolves the alias via `ctx.packModels` then user `models.yaml`.                                                                                                                                                                                                                                                            |
| `llm_classify`      | `{ model, prompt, allowed_labels: string[], timeout_ms? }` (`llm.ts:71-76`)                                                                    | `ok(label)`; clamps to `ok('UNCERTAIN')` on no-match AND on EVERY thrown error; `err(arg_invalid)` only on unknown alias (`llm.ts:125-172`). `durable:true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Constrained single-label classification. Audit knob: a high `UNCERTAIN` rate flags a dead-binary misconfig vs genuine indecision (`llm.ts:28-32`).                                                                                                                                                                                                                     |
| `cached_audit`      | `{ cache_key, model, prompt XOR lenses[2..4], subject?, timeout_ms?, pass_verdict?, fail_verdict? }`; each lens is `{ id, prompt, criteria? }` | Single-review mode memoizes an identity bound to prompt, model, and declared verdict policy; unsafe historical prompt-only entries miss once. Lens mode starts missing reviewers concurrently, persists partial results, retries only exact-subject missing/changed lenses, and returns `GUESS_FREE` only when every exact first-line verdict passes. Both modes require a 50-KiB capture-time model bound: current `subscription/cli` supports it, while API/SDK/MCP/Ollama strategies reject the bounded call before dispatch rather than buffering then truncating. Subject-bearing entries are additionally bound to `sha256(subject)`. | The pack-owned SCOPE/PLAN/AUTHOR/CODE adversarial audit. `dispatchCachedAudit` is the one schema/cache/ledger/task-persistence owner reused by gate reaudit; `audit_evidence` is the one strict persisted contract/read projection, and the commit gate also recomputes exact active-pack policy identity; adapters do not recreate cache entries or reviewer prompts. |
| `check_destination` | `{ goal, recent_actions: string[], model?(def 'reasoning') }` (`destination_check.ts:67-71`)                                                   | `ok({ level:'pass' \| 'block', message })` — `DRIFTING`→block, else pass (`destination_check.ts:120-168`). `durable:true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Pre-packaged goal-drift check; composes `llm_classify` with a closed `ON_GOAL \| DRIFTING \| UNCERTAIN` label set (`destination_check.ts:95`).                                                                                                                                                                                                                         |
| `read_rubric`       | `{ name: 'scope' \| 'author' }` (`read_rubric.ts:34`)                                                                                          | `ok(content)` whole-file, or `ok(null)` on miss/over-cap(64KB) — never truncates (`read_rubric.ts:43-60`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Single-source the audit rubric (`docs/rubric/{scope,author}.md`); audits interpolate `{{rubric}}` from it (`memoizable:false` so a rubric edit is reflected and the audit cache invalidates).                                                                                                                                                                          |

### Verdict / control-flow (`src/functions/verdict.ts` — pure object builders, `durable:false`)

| Primitive                 | Args                                                                                                                                      | Returns                                                                                                                             | When to use                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `verdict`                 | discriminated on `level`: `pass`/`block`/`warn`/`surface` carry `{ message }`; `directive` carries `{ next_action }` (`verdict.ts:59-65`) | re-emits the args; the evaluator special-cases this as the rule's terminal RuleResult (`verdict.ts:77-88`)                          | The ONLY way a rule produces a final Verdict. `directive` routes a structured next_action.                                       |
| `halt_task`               | `{ reason }` (`verdict.ts:67`)                                                                                                            | `ok({kind:'halt',reason})` action descriptor — never side-effects (`verdict.ts:90-97`)                                              | Signal the hook layer to halt the host session.                                                                                  |
| `restart_workflow`        | `{ entry_skill }` (`verdict.ts:68`)                                                                                                       | `ok({kind:'restart',entrySkill})` (`verdict.ts:99-106`)                                                                             | Re-enter a workflow at a named skill.                                                                                            |
| `set_active_task_state`   | `{ state }` (`verdict.ts:69`)                                                                                                             | `ok({kind:'state_set',state})` — declares intent only; compose `write_state` to persist (`verdict.ts:108-115`)                      | Split "declare intent" from "do the write" for an explicit audit trail.                                                          |
| `reset_scope_track_state` | `{}` (`reset_scope_track_state.ts:29`)                                                                                                    | `ok(null)` always (best-effort, clears `SCOPE_TRACK_STATE_KEYS` + scope window) (`reset_scope_track_state.ts:31-56`)                | On a new track's `scope_start` re-arm, clear the prior track's per-track pointers so they don't leak.                            |
| `arm_scope`               | `{}` (`arm_scope.ts:35`)                                                                                                                  | unchanged state if request-type is `research`, else fires `scope_start`; `ok(null)` if no FSM (`arm_scope.ts:37-62`)                | Single owner of the request-type veto on the SCOPE arm — both producers route through it so a research turn can never arm SCOPE. |
| `spawn_subagent`          | `{ model, prompt, context?: { project?, profession? } (strict) }` (`subagent.ts:136-146`)                                                 | `ok({ stdout, drifts })`; `err(runtime)` on SDK-load/run failure (`subagent.ts:226-283`). `durable:true` (most expensive primitive) | Spawn a full subagent SDK run; rolls drift up to the PARENT session catalog. SDK is a lazy optional peer dep.                    |

### RAG / lessons

| Primitive                         | Args                                                                                                    | Returns                                                                                                                                                                         | When to use                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `recall` (`rag.ts`)               | `{ query, k?(1..100, def 5) }` (`rag.ts:58-61`)                                                         | `ok(RecallHit[])`, `[]` on empty/no-match (`rag.ts:83-102`). `durable:true, memoizable:true`                                                                                    | Fused semantic+lexical memory recall; scope resolved by `resolveRecallScope()`. |
| `embed` (`rag.ts`)                | `{ text }` (`rag.ts:63-65`)                                                                             | `ok(number[] \| null)` — `null` = embedder unavailable (degraded, not error) (`rag.ts:104-122`)                                                                                 | Get an embedding vector.                                                        |
| `store_lesson` (`rag.ts`)         | `{ id, content, tags?=[], source?='unknown', author?:'user' \| 'agent'(def 'agent') }` (`rag.ts:67-73`) | `ok(undefined)`; stamps `createdAt` (`rag.ts:124-149`). `memoizable:false` (never memoize a write)                                                                              | Persist a lesson into the RAG store.                                            |
| `propose_lesson` (`lessons.ts`)   | `{ description, body, evidence?: string[], authored_by?:'user' \| 'agent' }` (`lessons.ts:84-91`)       | `ok({ id, status })`; `err(runtime)` on infra (`lessons.ts:111-136`). `durable:true`                                                                                            | Create a wedge-gate lesson candidate. `user`-authored are eviction-immune.      |
| `promote_lesson` (`lessons.ts`)   | `{ id }` (`lessons.ts:93-95`)                                                                           | `ok({status:'promoted',detail})` OR `ok({status:'blocked',reasons})` when the wedge moat fires (NOT an error); `err(runtime)` only on real infra failure (`lessons.ts:157-184`) | Promote a candidate; branch on `result.status` in the verdict.                  |
| `recall_lesson` (`lessons.ts`)    | `{ query, limit?(1..50) }` (`lessons.ts:97-99`)                                                         | `ok(hits)` (`lessons.ts:186-205`). `durable:true, memoizable:true`                                                                                                              | FTS recall across non-discarded lessons.                                        |
| `capture_feedback` (`lessons.ts`) | `{ id, polarity:'up' \| 'down', signal_id }` (`lessons.ts:215-219`)                                     | `ok({ id })` (`lessons.ts:213-231`)                                                                                                                                             | Feed the gate's external_signal_sources (a promotion precondition).             |
| `record_applied` (`lessons.ts`)   | `{ id, session_id? }` (`lessons.ts:235`)                                                                | `ok({ id })` (`lessons.ts:233-247`)                                                                                                                                             | Increment applied_count (gate requires ≥3 to promote).                          |

### Chat / env / session

Registered in `buildRegistry` (`bootstrap.ts:128-268`) — most via dedicated `register*Function(r)` helpers (e.g. `registerCheckChatConnectionFunction`, `registerEnsureUmbrellaTopicFunction`, `registerSetRequestType`), the pure ones as `FunctionDef` objects via `r.register(...)` (e.g. `ChatWatcherAutostart`, `SessionStatusManifest`, `HandoffSessionStart`, `CheckFlowHealth`, `IsAutomationMode`, `ScopeDwellTick`, in the `bootstrap.ts:176-232` block).

| Primitive                                    | Args                                                                                                                                                                                   | Returns                                                                              | When to use                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `chat_watcher_autostart`                     | `{}` (`chat_watcher_autostart.ts:32`)                                                                                                                                                  | `AutostartResult \| null`                                                            | session_start: direct the agent to start the inbound chat watcher (real-time messages).                            |
| `ensure_umbrella_topic`                      | `{ cwd? }` (`ensure_umbrella_topic.ts:136`)                                                                                                                                            | topic-ensure result                                                                  | Ensure the umbrella's Telegram topic exists; writes back the topic_id.                                             |
| `check_chat_connection`                      | `{ cwd? }` (`check_chat_connection.ts:62`)                                                                                                                                             | connection status                                                                    | Diagnose chat wiring.                                                                                              |
| `session_status_manifest`                    | `{}` (`session_status_manifest.ts:57`)                                                                                                                                                 | `ManifestResult \| null` (`session_status_manifest.ts:177`)                          | ONE consolidated "what opensquid is connected to" report (chat+flow+packs+daemon+engine) on session begin.         |
| `handoff_session_start`                      | `{}` (`handoff_session_start.ts:33`)                                                                                                                                                   | `InjectResult \| null`                                                               | Auto-resume from the prior session's handoff doc on first prompt.                                                  |
| `check_flow_health`                          | `{}` (`check_flow_health.ts:36`)                                                                                                                                                       | `CheckFlowHealthResult \| null`                                                      | Loud session_start inject when hooks aren't wired / no gate pack active.                                           |
| `is_automation_mode`                         | `{}` (`is_automation_mode.ts:41`)                                                                                                                                                      | `{ value: bool, source: 'env' \| 'flag' \| 'none' }` (`is_automation_mode.ts:45-48`) | Gate Stop-event LLM checks to fire only inside `/loop`-style automation (skills read `automation.value === true`). |
| `scope_dwell_tick`                           | `{}` (`scope_dwell.ts:36`)                                                                                                                                                             | `DwellResult`                                                                        | Tick a per-session dwell counter while in scoping/researching; surfaces a "converge scope" directive at threshold. |
| `set_request_type`                           | `{ type: 'research' \| 'work' }` (`set_request_type.ts:17`)                                                                                                                            | writes the refined request-type record                                               | The RTC.5 LLM refinement writes the classified request-type that `arm_scope` reads.                                |
| `recall_pre_inject`                          | `{ k?(1..20,5), min_score?(0..1,0.4), max_tokens?(100..20000,4000), min_prompt_chars?(0..10000,20), query_field?:'prompt' \| 'user_prompt'('prompt') }` (`recall_pre_inject.ts:53-61`) | injected recall context                                                              | prompt_submit: inject token-budgeted memory recall before the turn.                                                |
| `rubric_pre_inject` / `procedure_pre_inject` | `{}` (`rubric_pre_inject.ts:34`, `procedure_pre_inject.ts:30`)                                                                                                                         | injected content                                                                     | prompt_submit: deliver the audit rubric / pack operating procedure to the agent before authoring.                  |

### Active-task read primitives (`src/functions/active_task.ts`, all `memoizable:false`, fail CLOSED on read error)

`has_active_task` → `{ present, id, task_id }` (`active_task.ts:46-64`); `workflow_phases_complete` → `{ active, complete }` (all 7 phases logged) (`active_task.ts:73-93`); `has_generated_spec` → `{ present, generated }` (spec path resolves on disk) (`active_task.ts:126-159`); `task_list_generated` → `{ all_generated, ungenerated }` (whole open list carries provenance) (`active_task.ts:176-209`); `open_task_count` → `{ count }` (`active_task.ts:222-241`). These back the workflow/scope→task gates.

### Gated capability stubs (AUTO.3, `index.ts:36-44`)

`file_write` `{ path, content }` (`file_write.ts:35-38`), `shell_exec` `{ command }` (`shell_exec.ts:26`), `http_request` `{ url, method?(GET..OPTIONS, def GET) }` (`http_request.ts:26-29`) flow through `CapabilityGate.check()` before any side effect. `file_write` is the only one with a real impl (atomic tmp+rename); `shell_exec`/`http_request` are gated stubs that emit a runtime/not-implemented error even on allow (`shell_exec.ts:55-62`, `http_request.ts:61-66`). NOT registered in `buildRegistry`, so they are NOT in the default discipline-runtime path.

### Worked example — a real command gate (from `packs/builtin/default-discipline/manifest.yaml:39-53`)

```yaml
# T-GATE-MATCHER-SUBSTRING (GM.3, wg-52e57e2ed252): structural — matches a real
# `git commit --amend` invocation, not the substring inside a grep/echo/prompt.
- name: never-amend
  on: tool_call
  detect:
    call: command_invokes
    args:
      program: git
      subcommand: commit
      flag_any: ['--amend']
  when: hit
  level: block
  message: >-
    BLOCKED: `git commit --amend` violates the never-amend rule.
```

And the refspec-target variant (`manifest.yaml:58-72`) adds `arg_any: ['main', 'master']` so a force-push gate matches `git push --force … main` but not `main:develop` (push TO develop).

---

## Teams / Professions / Roles (`team.yaml`)

A **profession pack** is a pack the parent agent spawns _as a subagent_ rather than loading into its own mind. `team.yaml` is the side-file that makes this possible: it declares one or more **roles** the agent can instantiate via the `spawn_subagent` primitive. This file is REQUIRED for any pack whose manifest sets `usage: profession` or `usage: both`, and is absent (and ignored if present) for the default `usage: active`.

### When you need it

The manifest `usage` field selects the load path (`src/packs/schemas/manifest.ts:546`, `usage: PackUsage.default('active')`; enum `PackUsage = z.enum(['active','profession','both'])` at `src/packs/schemas/manifest.ts:314`):

- `active` — pack loads into the parent agent's context; its skill rules fire through the dispatcher. No `team.yaml`.
- `profession` — pack is spawned as a subagent when a `directive` verdict names it via `next_action.profession`. **REQUIRES `team.yaml`.**
- `both` — eligible for either path. **REQUIRES `team.yaml`.**

The loader hard-enforces the requirement (`src/packs/loader.ts:182-200`): for `profession`/`both` it `stat`s `<packdir>/team.yaml` and throws `pack <name>: usage: <u> REQUIRES team.yaml at <path> declaring ≥1 SubagentRole (none found)` if missing, then reads + `Team.parse`s it, throwing `pack <name>: team.yaml at <path> failed to parse — <e>` on any schema violation. The parsed team is folded onto the runtime `Pack` as `pack.team` (`src/packs/loader.ts:224-225`; type `team: Team.optional()` at `src/runtime/types.ts:389`, optional so test fixtures and `active` packs can omit it).

### The schema (authoritative shape)

From `src/packs/schemas/team.ts:49-69`:

```ts
export const SubagentRole = z.object({
  name: z.string().min(1),
  pack: z.string().min(1),
  model_alias: z.string().min(1),
  tools: z.array(z.string().min(1)).min(1).optional(),
  handoff_signal: z.string().optional(),
  instructions: z.string().optional(),
});

export const Team = z.object({
  name: z.string().min(1),
  roles: z.array(SubagentRole).min(1),
});
```

| Field                    | Where                         | Req?           | Meaning                                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | `Team` (`team.ts:66`)         | yes, min 1     | Team identifier (e.g. `scope-architect-team`). Convention: `<pack>-team`.                                                                                                                                                                                                                 |
| `roles`                  | `Team` (`team.ts:67`)         | yes, `.min(1)` | Array of roles; a zero-role team is a config error — Mode-A orchestration would be silently broken (`team.ts:30-32`).                                                                                                                                                                     |
| `roles[].name`           | `SubagentRole` (`team.ts:50`) | yes, min 1     | Role identifier the parent references when spawning, and what `next_action.args.role` matches against (`profession_resolver.ts:72-76`).                                                                                                                                                   |
| `roles[].pack`           | `team.ts:51`                  | yes, min 1     | The profession pack the spawned subagent loads (e.g. `scope-architect` or `profession/task-spec-author`). The subagent's universal pinned skills come from its OWN pack set, not the parent's (`team.ts:13-15`).                                                                          |
| `roles[].model_alias`    | `team.ts:52`                  | yes, min 1     | **Model-neutral** task-purpose label (e.g. `reasoning`). Resolved against the user's `models.yaml` at spawn time — NEVER a vendor model id (`team.ts:25-28`; the primitive in `src/functions/subagent.ts:12-16, 52-56` stays vendor-name-free). Schema validates only "non-empty string". |
| `roles[].tools`          | `team.ts:53`                  | host-dependent | Explicit canonical tool authority for generated host roles. Pi role generation requires it and maps names such as `Read`, `Write`, `MultiEdit`, and `mcp__opensquid__workgraph_get` to Pi invocation names. Authority is never inferred from prose.                                       |
| `roles[].handoff_signal` | `team.ts:54`                  | optional       | Sentinel string the subagent emits on completion (e.g. `SCOPE_COMPLETE`); the parent scans stdout for it (`team.ts:20-22`).                                                                                                                                                               |
| `roles[].instructions`   | `team.ts:55`                  | optional       | Role-specific system-prompt addendum applied to the spawned subagent.                                                                                                                                                                                                                     |

`SubagentRole` and `Team` are plain `z.object` values rather than strict objects.
Unknown fields therefore parse, but only declared fields have runtime meaning.

### What it does at runtime

opensquid **never invokes `spawn_subagent` itself** (`profession_resolver.ts:9-13`; `src/functions/subagent.ts:9-13`). The flow is:

1. Some `active` pack's skill rule emits a `directive` verdict whose `next_action.profession` names a profession pack (and optionally `next_action.args.role`). The chain-handoff pattern in `packs/builtin/pack-architect/team.yaml:79-84` is a real example: emit `next_action: { profession: 'scope-architect', rationale: ... }` and stop.
2. On a `prompt_submit` event the dispatcher builds a `teamsByPack` map from every loaded pack's `pack.team` (`dispatch.ts:442-445`) and calls `resolveProfessionDirective(na, packs, teamsByPack)` (`dispatch.ts:446`).
3. `resolveProfessionDirective` (`profession_resolver.ts:45-87`) validates, in order: pack exists (`unknown-pack`), `usage` is `profession`/`both` (`wrong-usage`, with `usage = pack.usage ?? 'active'`), a team was loaded (`missing-team`), team has roles (`no-roles`); if `args.role` was given it must match a role name (`role-not-found`), else **the first role wins** (`role = team.roles[0]!`, `profession_resolver.ts:84-85` — Phase-2 "leaf-node profession" discipline). On success it returns `{ ok, pack, team, role }`.
4. Fail-open in the SAFE direction: an invalid directive is **DROPPED** (not surfaced to the agent) with a warning, so the agent is never told to spawn a misconfigured profession (`profession_resolver.ts:15-18`, `dispatch.ts:447-453`; messages from `formatProfessionError`, `profession_resolver.ts:93-106`).
5. A valid directive is aggregated onto the UserPromptSubmit envelope; the AGENT reads it and calls `spawn_subagent({ model, prompt, context })` (`src/functions/subagent.ts:8-10`), supplying the resolved `model_alias` and `instructions`.

### Worked example (real, `packs/builtin/scope-architect/team.yaml:18-23`)

```yaml
name: scope-architect-team
roles:
  - name: scope-architect
    pack: scope-architect
    model_alias: reasoning
    tools:
      - Read
      - Write
      - Bash
      - Grep
      - mcp__opensquid__workgraph_get
      - mcp__opensquid__recall
      - mcp__opensquid__read_state
      - mcp__opensquid__web_fetch
    handoff_signal: SCOPE_COMPLETE
    instructions: |
      You are the scope-architect subagent. The parent agent spawned you
      via a chain-handoff directive because scope-first authoring is
      required for the current task.
      ... (charter: read context, produce pre-research artifact, emit SCOPE_COMPLETE) ...
```

All three builtin profession packs are single-role and **self-reference** their own pack (Mode A: the profession's own discipline applies to its subagent context):

- `packs/builtin/scope-architect/team.yaml` — role `scope-architect`, pack `scope-architect`, signal `SCOPE_COMPLETE`.
- `packs/builtin/task-spec-author/team.yaml` — role `spec-author`, pack `profession/task-spec-author`, signal `SPEC_AUTHORED` (note the `profession/` prefix form for `pack`).
- `packs/builtin/pack-architect/team.yaml` — role `pack-architect`, pack `pack-architect`, signal `PACK_AUTHORING_COMPLETE`.

### Authoring checklist

1. Set `usage: profession` (or `both`) in `manifest.yaml`. Per the schema comment (`manifest.ts:309-311`, "Per L8") profession packs SHOULD also be `kind: focused` (composites have no `team.yaml`). NOTE: this is a documented convention only — the comment claims "the loader enforces this," but the loader's only profession/both check is the `team.yaml` existence+parse at `loader.ts:182-200`; there is no `kind`-vs-`usage` cross-field refine in the loader or the schema. Do not rely on a runtime block here.
2. Create `team.yaml` at the pack root with `name` and a non-empty `roles` list.
3. Each role: pick a `name`, point `pack` at the profession pack to load, set a model-neutral `model_alias`, and declare the canonical `tools` that role may use.
4. Add a `handoff_signal` and `instructions` charter so the subagent knows its job and how to signal completion.
5. Multi-role professions are reachable today only via `next_action.args.role` matching; with no `role` arg the dispatcher always picks `roles[0]` (`profession_resolver.ts:84-85`).

---

## Models subsystem: `models.yaml` and the alias system

### The core thesis: aliases, not model names

Packs and rules NEVER name a concrete model or vendor binary. They reference an **abstract task-purpose alias** (`reasoning`, `fast_classifier`, `content_judge`). A separate config layer binds each alias to a concrete backend `{mode, impl, cli, args, ...}`. This is the model-neutrality contract enforced throughout the source: the dispatcher branches on abstract mode/impl names, never on a vendor binary identity (`src/models/dispatcher.ts:52-87`), and the subscription/cli strategy treats `cfg.cli` as an opaque user-supplied string (`src/models/strategies/subscription_cli.ts:49-52`). The one place a vendor token appears literally in source is the `api`-mode provider split: the dispatcher compares `cfg.provider` (a user-supplied string from `models.yaml`) against the literal labels `'anthropic'` / `'openai'` to pick the API client (`src/models/dispatcher.ts:64,67`). No concrete model id or host-binary name is ever hardcoded — those live exclusively in user config (`src/models/types.ts:41-49`).

### The two schemas (keep them aligned)

There are TWO representations of an alias config, deliberately mirrored:

1. **YAML-side Zod schema** — `src/packs/schemas/models.ts`. Validates `models.yaml` on disk.
2. **Runtime TS interface** — `src/models/types.ts` (`ModelAliasConfig`). The cross-process contract the strategies see.

**`ModelAlias` fields** (`src/packs/schemas/models.ts:55-68`):

| field         | type                                       | required          | meaning                                                                  |
| ------------- | ------------------------------------------ | ----------------- | ------------------------------------------------------------------------ |
| `description` | string                                     | no (default `''`) | human note; suggested tier                                               |
| `mode`        | enum `subscription`\|`api`\|`local`\|`mcp` | **yes**           | the call mode (`models.ts:40,57`)                                        |
| `impl`        | enum `cli`\|`sdk`                          | no                | only meaningful for `subscription` (`models.ts:43,58`, `types.ts:25-30`) |
| `cli`         | string                                     | no                | host binary name/path (subscription+cli)                                 |
| `args`        | string[]                                   | no (default `[]`) | argv passed to the binary                                                |
| `sdk`         | string                                     | no                | sdk module id (subscription+sdk)                                         |
| `model`       | string                                     | no                | user-supplied model id (sdk/api path)                                    |
| `endpoint`    | string (url)                               | no                | api endpoint                                                             |
| `provider`    | string                                     | no                | api provider label (`anthropic`\|`openai`)                               |
| `server`      | string                                     | no                | mcp server command (mcp mode)                                            |
| `tool`        | string                                     | no                | mcp tool name (mcp mode)                                                 |

`ModelsConfig` is `z.record(z.string(), ModelAlias).default({})` (`src/packs/schemas/models.ts:77`) — an **empty `models.yaml` (`{}`) is valid**; a pack with only deterministic track-checks ships no aliases. Cross-field validation (e.g. "`cli` required when `mode=subscription, impl=cli`") is NOT enforced at the schema layer — the strategy enforces its own preconditions at call time (`subscription_cli.ts:49-51` throws if `cli` is missing) (`models.ts:10-13`).

### How packs reference aliases

Three primitives/rule-kinds consume an alias by name:

- **`cached_audit`** — `args.model: <alias>` (the coding-flow SCOPE/AUTHOR gates). Real example, `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml:114-130`:
  ```yaml
  - call: cached_audit
    if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/research/") && contains(targs.file_path, "-pre-research-") && rubric != null'
    on_error: continue
    args:
      cache_key: coding-flow-guess-audit-cache
      model: reasoning
      timeout_ms: 600000
      lenses:
        - id: evidence
          prompt: >-
            Audit the evidence criteria against {{effective}} ...
        - id: architecture
          prompt: >-
            Audit the architecture criteria against {{effective}} ...
    as: audit
  ```
- **`llm_classify`** — `args.model: <alias>`, returns one of `allowed_labels` or `'UNCERTAIN'` (`src/functions/llm.ts:160-165`). Real example, `packs/builtin/default-discipline/skills/d9-guard/skill.yaml:44-65` (the rule supplies `model: fast_classifier`, a `prompt`, and `allowed_labels: [ALLOW, BLOCK]`):
  ```yaml
  - call: llm_classify
    if: automation.value == true
    as: classification
    args:
      model: fast_classifier
  ```
- **`subagent_call`** — `args.model: <alias>` (non-classify free-text spawn) (`src/functions/llm.ts:87-123`).
- **`destination_check` rules** — top-level `model_alias: <alias>` (NOT inside `args`), default `reasoning`. Real example, `packs/builtin/default-discipline/skills/workflow/skill.yaml:18-22`:
  ```yaml
  - id: workflow-phases-required
    kind: destination_check
    interval:
      every_n_tool_calls: 10
    model_alias: reasoning
  ```
  (`model_alias` defaults to `'reasoning'` per `src/runtime/types.ts:258`.)
- **`team.yaml` roles** — `model_alias: reasoning`, resolved at subagent-spawn time (`packs/builtin/task-spec-author/team.yaml:14`).

### Alias → backend resolution (the merge)

`loadModelsConfig(packModels?)` (`src/models/load_config.ts:59-108`) builds the merged alias map with **three layers, lowest to highest precedence**:

1. **Pack-shipped `models.yaml`** (lowest) — folded into `Pack.models` by the loader and threaded as `ctx.packModels`. The out-of-the-box default (`load_config.ts:62-68`).
2. **User-level `~/.opensquid/models.yaml`** — read, `ModelsConfig`-validated, merged OVER the pack layer; **fail-soft** (absent/unreadable/invalid YAML is silently skipped, the resolver must never throw) (`load_config.ts:79-87`).
3. **`OPENSQUID_MODELS_CONFIG_INLINE` env var** (highest) — JSON object, test seam + power-user override; permissive (no Zod) (`load_config.ts:92-105`).

`ctx.packModels` is populated by the hook dispatcher from the active pack's loaded `models.yaml`, spread-conditionally: `...(pack.models !== undefined ? { packModels: pack.models } : {})` (`src/runtime/hooks/dispatch.ts:399`); `Pack.models` is the optional folded side-file (`src/runtime/types.ts:363`). For packs that ship no `models.yaml`, `ctx.packModels` is `undefined` and only env + user-yaml contribute (`llm.ts:96-98`).

### Resolution + dispatch (how `cached_audit`'s `model` arg becomes a call)

In `cached_audit.execute` (`src/functions/cached_audit.ts:150-163`):

1. `const cfg = await loadModelsConfig(ctx.packModels)` — the merged map.
2. `const aliasCfg = cfg[model]` — look up the alias. If missing → `err({kind:'arg_invalid', message: 'Unknown model alias "<model>"'})` (`cached_audit.ts:151-154`). `subagent_call`/`llm_classify` do the identical lookup-and-error (`llm.ts:99-105, 137-143`).
3. `const strategy = resolveStrategy(model, aliasCfg)` then `await strategy.call(prompt, {timeoutMs})`.

`resolveStrategy(alias, config, secrets?)` (`src/models/dispatcher.ts:47-88`) is a **pure** function branching on `(mode, impl)`:

| (mode, impl / provider)         | strategy                  | notes                                                                                 |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `subscription` + `cli`          | `subscriptionCliStrategy` | spawns `cfg.cli` with `cfg.args`, pipes prompt via stdin (`dispatcher.ts:52-54`)      |
| `subscription` + `sdk`          | `subscriptionSdkStrategy` | `dispatcher.ts:55-57`                                                                 |
| `api`, `provider=anthropic`     | `apiAnthropicStrategy`    | requires a `SecretResolver`; throws at resolve time if absent (`dispatcher.ts:58-66`) |
| `api`, `provider=openai`        | `apiOpenAIStrategy`       | `dispatcher.ts:67-69`                                                                 |
| `api`, other/undefined provider | throws config error       | `dispatcher.ts:70-73`                                                                 |
| `local`                         | `localOllamaStrategy`     | Ollama is the only Phase-1 local impl (`dispatcher.ts:75-79`)                         |
| `mcp`                           | `mcpStrategy`             | fail-fasts on missing server/tool at factory time (`dispatcher.ts:80-84`)             |
| unknown mode                    | `stubStrategy`            | safe fallback (`dispatcher.ts:85-87`)                                                 |

The subscription/cli strategy (`subscription_cli.ts:46-72`) reads `cfg.cli` (throws if absent, `:49-51`), `cfg.args ?? []` (`:53`), and `timeoutMs` (default 30s, `subscription_cli.ts:32,54`), then runs a one-shot detached CLI with the prompt on stdin via the shared `runOneShotCli` lifecycle helper (`:61-68`). Exit 0 → trimmed stdout; nonzero → reject; timeout → `CliTimeoutError` (`subscription_cli.ts:18-22, 39-44`).

### Authoring a pack's `models.yaml` — worked example

Real, from `packs/builtin/seo-aeo-expert/models.yaml:6-19`:

```yaml
fast_classifier:
  description: >-
    Single-label classification: folklore-vs-evidenced recommendation check,
    pack destination check. Suggested tier: fast.
  mode: subscription
  impl: cli

content_judge:
  description: >-
    Short structured judgement on content shape (answer-first opening,
    extractable facts) and validation-evidence audits via cached_audit.
    Suggested tier: fast-to-mid.
  mode: subscription
  impl: cli
```

Note: the pack declares the alias contract + suggested tier but leaves `cli`/`args` UNSET, so the user's `~/.opensquid/models.yaml` supplies the concrete binding. The minimal pack form is `packs/builtin/default-discipline/models.yaml:8` which is literally `{}` (the pack references `reasoning`/`fast_classifier` but lets the user pick the backend entirely).

### The matching user-global `~/.opensquid/models.yaml`

The user maps each alias a pack references to a concrete backend, e.g.:

```yaml
reasoning:
  mode: subscription
  impl: cli
  cli: claude
  args: ['-p']
fast_classifier:
  mode: subscription
  impl: cli
  cli: claude
  args: ['-p']
```

**The `args: ['-p']` is load-bearing**: bare `claude` starts the interactive TUI and hangs on the piped stdin prompt → the audit `subagent_call`/`cached_audit` times out → the coding-flow FSM never advances past `scoping` (the flow becomes uncompletable). This is exactly the failure the user-yaml layer (`load_config.ts:70-87`) was wired to prevent: before that layer was wired, a pack alias like `reasoning` resolved to `undefined` → `arg_invalid` → audits never ran → FSM stuck (documented in `load_config.ts:11-13, 70-78`).

### Authoring checklist for a perfect pack `models.yaml`

1. Declare aliases by **task purpose** (`reasoning`, `fast_classifier`, `content_judge`), never a model id. The pack-architect walkthrough enforces "No vendor model names anywhere (use model_alias)" (`packs/builtin/pack-architect/skills/skill-yaml-author-walkthrough/skill.yaml:65`).
2. Set `mode` (required) + `impl` (for subscription). Leave `cli`/`args`/`model` to the user unless the pack genuinely owns the binding.
3. Use a `description` with a suggested tier so the user can map intelligently.
4. Reference the alias from rules via `args.model:` (cached_audit/llm_classify/subagent_call) or top-level `model_alias:` (destination_check) — never both forms in one place.
5. If the pack ships no LLM-driven rules, omit `models.yaml` entirely or ship `{}`.

---

## Drift Response Config (`drift_response.yaml`)

When a pack rule fires and produces a _verdict_, the rule only decides **what happened**. The pack's `drift_response.yaml` decides **what the runtime does about it**. This separation is deliberate: drift response is pack-declared policy, not a hardcoded mechanism (`src/packs/schemas/drift_response.ts:7-12`).

### What an author declares

`drift_response.yaml` is an **optional** side-file in the pack directory (alongside `skill.yaml`, `fsm.yaml`, `models.yaml`). The loader reads it with an ENOENT-as-absent contract — a missing file → `undefined`, distinct from "file present with explicit defaults" (`src/packs/loader.ts:321-331`, `:311-318`). The schema (`src/packs/schemas/drift_response.ts:64-70`) is:

```ts
export const DriftResponseConfig = z
  .object({
    default: DriftPolicyEnum.default('block_tool'),
    per_rule: z.record(z.string(), DriftPolicyEnum).default({}),
    corrective_skills: z.record(z.string(), z.string().min(1)).default({}),
  })
  .strict();
```

| Field               | Meaning                                                                                                                                                                                                                                   | Default                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `default`           | Policy applied to any rule with no `per_rule` entry                                                                                                                                                                                       | `block_tool` (schema default, fires only when the file _is present_ but omits the field) |
| `per_rule`          | `ruleId → policy` override map; direct lookup on every verdict                                                                                                                                                                            | `{}`                                                                                     |
| `corrective_skills` | `ruleId → corrective-skill-name`; consulted **only** by the `auto_correct` policy. Decoupled from `per_rule` so you can pre-declare a corrective skill for a rule still on `block_tool` and flip to `auto_correct` later without rewiring | `{}`                                                                                     |

`.strict()` is intentional: a top-level typo like `defualt:` fails loudly at load instead of silently falling through — important for a safety-critical file (`src/packs/schemas/drift_response.ts:14-16`, `src/packs/loader.ts:311-313`).

### The six policies (`DriftPolicyEnum`)

Declared at `src/packs/schemas/drift_response.ts:42-49`; the runtime union mirror is `DriftPolicy` at `src/runtime/types.ts:493-499`:

| Policy               | Runtime action (`RuntimeAction`)                          | Effect                                                                                                                                  | Wired?                                                                                                                            |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `block_tool`         | `{kind:'block_tool', message}`                            | Refuse the pending tool call (exit 2 + message)                                                                                         | Yes — `src/runtime/hooks/dispatch.ts:490-497`                                                                                     |
| `warn`               | `{kind:'warn', message}`                                  | Let the tool through, buffer the message, **continue the walk** (exit 0) so a later pack's FSM advance still runs                       | Yes — `dispatch.ts:498-508`                                                                                                       |
| `full_stop_and_redo` | `{kind:'halt', reason, entrySkill?}`                      | Hard block (exit 2) surfacing the verdict message; the destructive ledger reset is a separate opt-in `restart` action, NOT applied here | Yes — `dispatch.ts:509-526`                                                                                                       |
| `notify_and_pause`   | `{kind:'notify_pause', reason, severity}`                 | Surface the message (exit 0 + stderr); a hook can't truly pause the loop                                                                | Yes — `dispatch.ts:527-541`                                                                                                       |
| `auto_correct`       | `{kind:'auto_correct', correctiveSkill, verdict}`         | Resolve corrective skill from `corrective_skills[ruleId]`, run it, re-evaluate the rule                                                 | **Stub** — `dispatch.ts:542-551` falls through to exit 0; runtime layer `src/runtime/auto_correct.ts` exists but is not connected |
| `escalate`           | `{kind:'escalate', reroutedSeverity:'critical', verdict}` | Bump severity to critical + reroute via NotificationRouter                                                                              | **Stub** — `dispatch.ts:542-551` falls through to exit 0; runtime layer `src/runtime/escalate.ts` exists but is not connected     |

The dispatch table is a `Record<DriftPolicy, ...>` lookup (NOT an if/else cascade) so TS enforces exhaustiveness — omitting a handler is a compile error (`src/runtime/drift_response.ts:103-131`, design note `:78-92`). The `RuntimeAction` union is at `src/runtime/types.ts:501-507`.

### How a verdict resolves to a response at runtime

The hook dispatcher (`src/runtime/hooks/dispatch.ts:476-488`) computes the policy with a three-level precedence chain:

```ts
const driftResponse = pack.driftResponse;
const resolvedPolicy: DriftPolicy =
  driftResponse?.per_rule[rule.id] ??
  driftResponse?.default ??
  defaultPolicyForLevel(result.verdict.level);
const action = applyDriftResponse(result.verdict, resolvedPolicy, {
  ...(driftResponse !== undefined ? { correctiveSkills: driftResponse.corrective_skills } : {}),
});
```

1. **per-rule override** — `per_rule[rule.id]`. `rule.id` is required by the Skill schema, so the lookup is always well-defined (`dispatch.ts:474-475`).
2. **pack default** — `driftResponse.default`.
3. **level-derived fallback** — `defaultPolicyForLevel(level)` when the pack ships **no file at all** (`driftResponse` is `undefined`): `block → block_tool`, everything else (`warn`/`surface`/`pass`/`directive`) → `warn` (`src/runtime/drift_response.ts:66-68`). This honors the verdict's authored `level:` so a fileless pack's `level: warn` rule warns instead of hard-blocking — replacing the historical blanket `block_tool` default (`src/runtime/drift_response.ts:50-62`). (Note: the `Pack.driftResponse` doc comment at `src/runtime/types.ts:343-350` still describes the OLD blanket-`block_tool` fallback and is stale relative to this `defaultPolicyForLevel` path.)

Only **message-bearing verdicts** (`MessageVerdict` — levels `pass`/`block`/`warn`/`surface`) flow through `applyDriftResponse`. `level: directive` verdicts take a separate aggregation path and never reach drift response (`src/runtime/drift_response.ts:70-76`, verdict union at `src/runtime/types.ts:113-143`, `MessageVerdict` at `:142-143`).

**Fail-loud guarantees (constraint C10, no silent fail-open):**

- Unknown policy string (typo that slipped past schema, or future variant) → degrade to `notify_pause` severity `critical`, interpolating the raw string for audit (`src/runtime/drift_response.ts:139-148`).
- `auto_correct` with no `corrective_skills[ruleId]` entry (or no `ruleId`) → degrade to `notify_pause` severity `critical` naming the missing entry (`src/runtime/drift_response.ts:112-128`).

### Where verdicts are recorded

Resolved drift events append to JSONL catalogs: each pack writes `~/.opensquid/packs/<id>/state/drift-catalog.jsonl` and the session writes one under `~/.opensquid/sessions/<id>/state/drift-catalog.jsonl` (`appendSessionDriftEvent`, `src/runtime/drift_catalog.ts:192`). `readAllDriftCatalogs` (re-exported from `src/runtime/index.ts:33`) merges them chronologically and pins `pack` provenance to the file location (any on-disk `pack` field is overwritten — `src/runtime/drift_catalog.ts:18-24`). The MCP tool `list-drift-events` surfaces the aggregated view (`src/mcp/tools/list-drift-events.ts:24`, `:36`).

### Worked examples (real builtin packs)

**`packs/builtin/default-discipline/drift_response.yaml`** — strict default, softened per-rule:

```yaml
default: full_stop_and_redo
per_rule:
  'guard:never-amend': block_tool # block the one call, don't halt the task
  'guard:no-force-push-main': block_tool
  'guard:substrate-purity': warn # soft smell, not a stop signal
  'guard:version-slot-assignment': notify_and_pause
  'guard:research-start': warn # honesty-ledger claims — all warn
  # ...
  'guard:versioning-pre1-patch-only': full_stop_and_redo
  workflow-phases-required: full_stop_and_redo
  phase-logged-before-commit: full_stop_and_redo
```

Note the quoted keys: compiled-guard rule ids are `guard:<name>` and the embedded colon requires quoting; the two `workflow-*` keys are unquoted because that skill keeps bare rule ids (`packs/builtin/default-discipline/drift_response.yaml:14-52`).

**`packs/builtin/seo-aeo-expert/drift_response.yaml`** — permissive default, block only irreversible damage:

```yaml
default: warn
per_rule:
  citation-bot-disallow: block_tool
  robots-wildcard-disallow: block_tool
```

The authoring pattern is inverted from default-discipline: SEO is judgment-heavy, so the pack informs (`warn`) and only hard-blocks silent total-visibility loss (`packs/builtin/seo-aeo-expert/drift_response.yaml:1-11`).

### Authoring checklist

1. Pick a pack-wide `default` matching your pack's stance (strict → `full_stop_and_redo`/`block_tool`; advisory → `warn`).
2. Add `per_rule` entries only where a specific rule deserves a different response than the default. Keys must be the rule's `id` (quote `guard:`-prefixed ids).
3. If using `auto_correct` for any rule, add its corrective skill to `corrective_skills` (a missing entry degrades to a critical notify, not a crash) — but note `auto_correct`/`escalate` are not yet enforced (stub falls through to exit 0).
4. Omit the file entirely if level-derived defaults suffice (`block` rules block, others warn).

---

## Pack authoring surfaces: the PROCEDURE (METHOD) and the RUBRIC (BAR)

A pack ships two distinct agent-facing authoring surfaces. They are deliberately split: the **procedure** tells the agent _how to do the work_, the **rubric** tells it _the standard the work must meet_. The coding-flow pack's own `procedure.md` states this split in its header: "This is the **METHOD**. The SCOPE/AUTHOR **rubric** (injected alongside this) is the **BAR**" (`packs/builtin/coding-flow/procedure.md:3`).

| Surface                      | File                            | Owner                                  | Type                    | Loaded as                   | Injected by            | Consumed by audit?                          |
| ---------------------------- | ------------------------------- | -------------------------------------- | ----------------------- | --------------------------- | ---------------------- | ------------------------------------------- |
| Operating procedure (METHOD) | `procedure.md` (pack root)      | each pack                              | raw markdown, no schema | `Pack.procedure` (optional) | `procedure_pre_inject` | no — advisory only                          |
| Audit rubric (BAR)           | `docs/rubric/{scope,author}.md` | the opensquid **package** (not a pack) | raw markdown, no schema | read on demand by name      | `rubric_pre_inject`    | **yes** — interpolated into the gate prompt |

### 1. procedure.md — the per-pack METHOD

**Where it lives & how it loads.** A pack ships `procedure.md` at its root. The loader reads it optionally: `const procedure = await loadOptionalProcedure(join(dir, 'procedure.md'))` (`src/packs/loader.ts:174`), folded onto the runtime Pack only when present: `...(procedure !== undefined ? { procedure } : {})` (`src/packs/loader.ts:241`). The field is declared optional on the Pack type — "Pack-owned agent-facing operating procedure (from `procedure.md`); injected to the agent when the pack is engaged" (`src/runtime/types.ts:421-423`).

**The load contract (`loadOptionalProcedure`, `src/packs/loader.ts:255-263`):**

- ENOENT → `undefined` (the side-file is OPTIONAL — a pack need not ship one) (`src/packs/loader.ts:260`).
- Size cap `MAX_PROCEDURE = 64_000` (`src/packs/loader.ts:254`); **over-cap → `undefined`, never a partial read** (`src/packs/loader.ts:258`). The cap exists because procedure.md is re-injected into agent context on _every_ engaged prompt, so it shares the rubric's context-budget cost profile, unlike the programmatically-consumed YAML side-files (`src/packs/loader.ts:249-252`).
- Raw markdown read — no schema (`src/packs/loader.ts:252, :257`).

**How it's threaded & injected.** The dispatcher copies it into the function-call context: `...(pack.procedure !== undefined ? { packProcedure: pack.procedure } : {})` (`src/runtime/hooks/dispatch.ts:405`), reaching `ctx.packProcedure` (declared `src/functions/registry.ts:60-65`). `procedure_pre_inject` (`src/functions/procedure_pre_inject.ts`) then:

1. fires only on `prompt_submit` (`procedure_pre_inject.ts:40`);
2. no-ops if the pack ships no procedure (`:41`);
3. **self-gates GENERICALLY with no hardcoded pack id** (`:42-46`): if the pack ships an FSM (`ctx.packFsm`), it injects only while the pack is ENGAGED — current state ≠ `fsm.initial` (`:43-45`). So "engaged" is derived from the pack's _own_ `fsm.initial`, never duplicated into YAML. A pack with no FSM is engaged whenever loaded (`:13`, doc comment; the `ctx.packFsm !== undefined` guard at `:43` is simply skipped);
4. injects a header + the pack's own manual: `## ${ctx.packId} — operating procedure (follow this to pass the gates first-try)` followed by `ctx.packProcedure` (`:47-48`).

It is **advisory** — it never blocks; it injects nothing when not engaged or when no procedure exists (`:16-19` doc comment, enforced by the `ok(null)` returns at `:40-45`). For coding-flow the engaged set is _every_ non-idle state, deliberately covering SCOPE→AUTHOR→EXECUTE "since gate-fighting happens in EXECUTE too" (`:10-12` doc comment).

**The hosting rule is UNCONDITIONAL** (`packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml:139-141`):

```yaml
- id: inject-procedure
  process:
    - call: procedure_pre_inject
```

The conditional logic lives in the primitive (derived from `fsm.initial`), not the YAML — matching `inject-rubric`'s shape.

### 2. The audit rubric — the single-sourced BAR

**Where it lives.** `docs/rubric/scope.md` (the guess-audit's pass criteria) and `docs/rubric/author.md` (the spec-audit's pass criteria). These belong to the **opensquid package**, shipped via `package.json` `files[]: ["docs/rubric"]` (`package.json:31`) — NOT to a pack. Each rubric is short, self-describing prose stating exactly which conditions yield a passing verdict. The scope rubric: "A pre-research / scope artifact passes (`VERDICT: GUESS_FREE`) ONLY if all three hold" — NEVER-GUESS, BEST-SOLUTION, FULL-FIX (`docs/rubric/scope.md:7-16`). The author rubric: "A task spec passes (`VERDICT: SPEC_COMPLETE`) ONLY if all three hold" — 11-FIELD CONTRACT, 100% DESIGN COVERAGE, SIMPLICITY (`docs/rubric/author.md:7-17`).

**The reader (`read_rubric`, `src/functions/read_rubric.ts`).** A primitive with `argSchema: { name: z.enum(['scope','author']) }` (`:34`). Resolution is **module-relative to the opensquid package**, not cwd / CLAUDE_PROJECT_DIR: `PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')` (`:37`) — so the recurring sub-repo-vs-umbrella cwd split cannot misresolve it (`:11-14` doc comment). It reads `docs/rubric/<name>.md` whole (`:45`). **FAIL-LOUD**: on file-miss / path-misresolve / over-cap (`MAX_RUBRIC = 64_000`, `:32`) it returns `null` — never throws, never truncates (`:16-18` doc comment, `:43-49`). It is `memoizable: false` so a rubric edit is reflected on the next read (`:57`).

### 3. The single-source discipline: gate criteria == agent guidance

The same rubric text feeds **both** the audit (the gate) and the agent (the guidance), so they cannot drift. Both rubric files state the rule inline: "Edit HERE — both the audit and the agent reflect the change (no second copy)" (`docs/rubric/scope.md:5`, `docs/rubric/author.md:5`).

**(a) Into the audit prompt** — the gate criteria. In the SCOPE lifecycle skill the rubric is read and interpolated as `{{rubric}}`, NOT hardcoded (`packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml:101-104`):

```yaml
- call: read_rubric
  if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/research/") && contains(targs.file_path, "-pre-research-")'
  args: { name: scope }
  as: rubric
```

Then a **fail-loud precondition** blocks the audit from ever running rubric-less (`skill.yaml:107-113`): `if: ... && rubric == null` → a `block` verdict explaining "the canonical rubric (docs/rubric/scope.md) is unreadable — a packaging/install fault, NOT a content failure." Only when `rubric != null` does the `cached_audit` run, with the rubric interpolated into the adversarial prompt: "Apply EXACTLY this rubric (the single canonical source, docs/rubric/scope.md):\n\n{{rubric}}\n\n" (`skill.yaml:114-130`). The AUTHOR audit mirrors this exactly for `docs/rubric/author.md` (`skill.yaml:230-250`).

**(b) Into the agent's context BEFORE authoring** — the guidance. `rubric_pre_inject` (`src/functions/rubric_pre_inject.ts`) reuses the SAME `readRubricContent` (`:27, :47-48`) — "ONE canonical source for the audit AND the agent" (`:16-17` doc comment). On `prompt_submit`, when the coding-flow FSM is in an active SCOPE/AUTHOR phase (`ACTIVE = {scoping, researching, researched, spec_authored}`, `:32`), it injects BOTH rubrics together under the header "## Coding-flow quality rubric — the bar the SCOPE/AUTHOR gates will apply (hold it BEFORE you author)" (`:50-58`). It injects both (not phase-gated to one) because under run-to-exhaustion the whole SCOPE→AUTHOR flow is one turn with no intervening prompt, so one injection must cover every phase the turn traverses (`:9-14` doc comment). Its hosting rule `inject-rubric` is unconditional (`entry-and-handoffs/skill.yaml:131-133`), placed AFTER `enter-scoping` so the cold-kickoff turn's just-armed `scoping` is visible to the file-order rule walk (`:97-98`).

**Cache coherence.** Editing a rubric fragment auto-invalidates the audit's verdict cache: the audit memoizes by `sha256(prompt)`, and the rubric content is interpolated _into_ the prompt, so a fragment edit changes the prompt hash and forces a re-audit (`src/functions/read_rubric.ts:6-9` doc comment).

**Shared injection envelope.** Both injectors return the identical `{ kind: 'inject_context', content }` envelope via `buildInjectContext` (`src/functions/inject_context.ts:19-21`) so they "cannot drift in the envelope/`kind` literal"; only the CONTENT composition differs (rubric = multi-section bar; procedure = header + manual) (`inject_context.ts:7-10` doc comment). The dispatcher aggregates each `inject_context` result into `contextInjections` for `prompt_submit` / `session_start` events (`src/runtime/hooks/dispatch.ts:412-428`, push at `:420`) and emits it as Claude Code's `hookSpecificOutput.additionalContext` envelope at UserPromptSubmit (`dispatch.ts:87`; returned via `contextInjections` at `:495, :524, :557`).

### Authoring checklist for a pack author

- To ship a METHOD: add `procedure.md` at the pack root (raw markdown, ≤ 64 KB), and add an unconditional `- call: procedure_pre_inject` rule in a `prompt_submit` skill. The engagement gate is automatic (derived from your `fsm.initial`); ship no per-pack id anywhere.
- The audit RUBRIC (`docs/rubric/*.md`) is package-owned and currently coding-flow-specific (`scope`/`author`). To change the BAR, edit those files — both the gate prompt and the agent injection update with zero second copy. Never hardcode rubric text into a skill prompt; interpolate `{{rubric}}` from `read_rubric` and guard with a `rubric == null` fail-loud block.

---
