# OpenSquid — Architecture (single source of truth)

Version: 0.5.441 · Last updated: 2026-07-03 (Flows/Gates reconciled to the v2 `fullstack-flow` design-of-record)

This is the **one** map of the whole system: what each part is, **how the parts depend on each
other**, and **what gets brittle when you change something**. opensquid is not a bag of features —
it is one interconnected loop. Treat this doc as the reference point before any change: find the
subsystem you're touching, read its relationships, then read the [Change-impact map](#change-impact-map).

Deep-dives (this doc is the entry point; these are the details):
`docs/pack-runtime.md` (pack format + dispatch), `docs/pack-fsm-architecture.md` (FSM engine),
`docs/flows.md` (the end-to-end gated flow, v2), `docs/state-formats.md` (on-disk shapes), `docs/lexicon.md`
(design principles), `packs/builtin/fullstack-flow/rubric/*.md` (gate criteria, v2).

---

## 1. The thesis — one loop, not six features

opensquid is a **behavior runtime**: an orchestrator that loads **packs** (the total definition of an
agent's behavior — FSMs + guards + the agent-facing procedure) and runs them over every agent action,
backed by durable **memory**, gated by **flows**, wired by **install/setup**, with **chat** as the
remote I/O. The parts complement each other:

```
        install/setup  ──writes the config+state layout everything else reads──┐
              │                                                                 │
              ▼                                                                 ▼
   ┌──────────────────┐   threads pack content    ┌──────────────────┐   reads/writes
   │   RUNTIME         │◀──(procedure/models/fsm)──│      PACKS        │   ~/.opensquid/
   │ hooks→dispatch→   │                           │ manifest+skills+  │   (the shared
   │ evaluator→        │──runs rules/gates────────▶│ fsm+rubric+       │    substrate)
   │ primitives        │                           │ procedure         │        ▲
   └───────┬──────────┘                            └────────┬─────────┘        │
           │ injects recall/rubric/procedure                │ DEFINES          │
           │ runs the audits, writes FSM+phase state        ▼                  │
           ▼                                        ┌──────────────────┐       │
   ┌──────────────────┐   log_phase / recall /      │      FLOWS       │       │
   │     MEMORY        │◀──store_lesson──────────────│ fullstack-flow   │───────┘
   │ RAG + lessons +   │                             │ FSM (v2), gates, │
   │ work-graph        │──recall feeds each turn────▶│ git gate         │
   └───────┬──────────┘                             └──────────────────┘
           │ umbrella/namespace key is SHARED with ▼
   ┌──────────────────┐
   │      CHAT         │  remote I/O over the whole session (inbound→hooks, outbound←chat_send)
   └──────────────────┘
```

The five load-bearing connections (memorize these — they are where disconnection happens):

1. **Packs DEFINE flows.** The `fullstack-flow` pack's inline `fsm` + skills ARE the lifecycle the Flows
   subsystem enforces (v2 design-of-record; the v1 `coding-flow` pack is the still-shipped legacy default).
   Change the pack → you change the flow.
2. **Flows WRITE memory.** `log_phase` writes the phase ledger; audits read the rubric docs; the
   request-type record + FSM state are session memory the gates read.
3. **Memory FEEDS packs/flows.** `recall` (+ `recall_pre_inject`) is what the agent knows each turn;
   the request-type + FSM records drive the arm decision (the stop guard reads FSM + open-count only).
4. **Runtime THREADS packs.** dispatch reads each pack's `procedure`/`models`/`fsm` and threads them
   to primitives; the primitives run the gates and inject memory/rubric/procedure.
5. **Install WIRES all of it.** setup writes the hooks (`~/.claude/settings.json`), the MCP servers
   (`~/.claude.json`), and the `~/.opensquid/` layout. Chat + memory **share** the umbrella/namespace
   key. If setup is wrong, nothing downstream fires.

---

## 2. A turn's data-flow (the spine)

```
user prompt
  └─▶ UserPromptSubmit hook (runtime)
        ├─ resetTurnLedger                         → STATE (session ledger)
        ├─ classifyRequestType → writeRequestType  → MEMORY/STATE (request-type record)  [FLOWS reads it]
        ├─ recall_pre_inject                       ← MEMORY (top-K)  → additionalContext
        ├─ rubric_pre_inject / procedure_pre_inject← PACKS (fullstack-flow rubric/procedure)  → additionalContext
        ├─ drainUmbrellaInbox                       ← CHAT (inbox)  → additionalContext
        └─ dispatchEvent
             └─ walk PACKS → skills → rules → evaluator → primitives
                  ├─ enter-scoping reads request-type → advance_fsm (FLOWS: scoping)   → STATE (FSM)
                  └─ directives (next_action)                                          → additionalContext
agent acts (Write/Edit/Bash/git/...)
  └─▶ PreToolUse hook → dispatch
        ├─ a stage-advance Write → deterministic gate + content-audit → GUESS_FREE → advance_fsm  → STATE (FSM)
        │   (v2: scope/plan/author/code gates, each a zero-LLM predicate + a `VERDICT: GUESS_FREE` audit)
        └─ git commit → execute-gate (in-session NUDGE)        [git gate.ts = the HARD boundary]
  └─▶ PostToolUse hook → phase-advance (after log_phase)        → STATE (FSM) + MEMORY (phase ledger)
agent stops
  └─▶ Stop hook → pause-stop-guard (reads FSM + open-count), maybeDriveInbound/streamOutput (CHAT)
session ends
  └─▶ SessionEnd hook → reconcile memory, compression, auto-handoff, clearFsmState
```

Every arrow crosses a subsystem boundary. That is the point: a change to any node ripples along its arrows.

---

## 3. Subsystems at a glance

| Subsystem         | Owns                                                                                                                                                           | Key code                                                                                                                                                                | Deep-dive                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Install/Setup** | the npm package, the wizards, the `~/.opensquid/` + `~/.claude/` layout                                                                                        | `src/cli.ts`, `src/setup/`, `src/runtime/paths.ts`, `package.json`                                                                                                      | §4.1                                   |
| **Runtime**       | hooks → dispatch → evaluator → ~50 primitives; the event/verdict model                                                                                         | `src/runtime/hooks/`, `dispatch.ts`, `evaluator/`, `src/functions/`, `bootstrap.ts`                                                                                     | `pack-runtime.md`                      |
| **Packs**         | pack format (manifest+skills+side-files), loader, the builtin pack set                                                                                         | `src/packs/`, `src/runtime/types.ts` (`Pack`), `packs/builtin/`                                                                                                         | `pack-runtime.md`                      |
| **Flows/Gates**   | the v2 `fullstack-flow` FSM (5-stage), per-stage deterministic + guess-free gates, git-owned gate, request-type classifier (v1 `coding-flow` = shipped legacy) | `packs/builtin/fullstack-flow/`, `packs/builtin/coding-flow/`, `src/runtime/fsm*.ts`, `src/runtime/coverage/`, `src/functions/cached_audit.ts`, `src/setup/cli/gate.ts` | `flows.md`, `pack-fsm-architecture.md` |
| **Memory**        | RAG (libsql+fastembed), lessons + wedge gate, work-graph, compression/retention                                                                                | `src/rag/`, `src/workgraph/`, `src/runtime/phase_ledger.ts`, `src/mcp/tools/`                                                                                           | `state-formats.md`                     |
| **Chat**          | chat-daemon, umbrella routing, inbound watcher + drain, `chat_send` bridge                                                                                     | `src/channels/`, `src/runtime/chat/`, `src/mcp/chat-bridge-server.ts`, `src/chat_daemon/client.ts`                                                                      | —                                      |

---

## 4. Per-subsystem — owns / inputs / outputs / **touchpoints**

### 4.1 Install / Setup / State-layout

- **Owns:** the npm `bin` set (the CLI + 6 hook bins + 2 MCP servers, `package.json:12-22`); the wizards
  (`src/setup/wizard/{settings-writer,mcp-writer,codex-hooks-writer}.ts`, `src/setup/cli/chat_*`); the
  canonical path layout (`src/runtime/paths.ts`, `OPENSQUID_HOME()`).
- **Writes (the config other subsystems consume):** `~/.claude/settings.json` (hook entries, marked
  `@opensquid:true`), `~/.claude.json` (`opensquid` + `opensquid-chat` MCP servers), `~/.codex/hooks.json`
  (codex parity), `~/.opensquid/{active.json, models.yaml, channels.json, config.json, .env, sessions/, store/, ...}`.
- **Touchpoints (downstream dependents):** Runtime hooks depend on `settings.json` being present+correct;
  the MCP tools depend on `~/.claude.json`; Packs load from `active.json` + `~/.opensquid/packs/`; Chat
  depends on `config.json` (tokens) + `channels.json` (routing); Memory keys on the umbrella from `channels.json`.
- **This is the root dependency.** If setup is broken, _every_ other subsystem silently no-ops.
- **Verify:** `opensquid doctor {hooks,codex-hooks,memory,git-hooks,update}`.

### 4.2 Runtime (the spine)

- **Owns:** the 6 hook bins; `dispatchEvent` (walks packs→skills→rules, threads `packId/packModels/packFsm/packProcedure`
  into the eval context, aggregates `contextInjections`+`directives`); the evaluator + `if:` interpreter;
  the function registry (~50 primitives registered in `bootstrap.ts`); the Event (8 kinds) + Verdict (5 levels) model.
- **Inputs:** host hook payloads; the loaded packs; the session/FSM/memory state on disk.
- **Outputs:** `additionalContext` (injections+directives), `permissionDecision: deny` (block), FSM/state writes,
  audit spawns, memory reads/writes.
- **Touchpoints:** threads PACK content → primitives; primitives read/write MEMORY + STATE; runs the FLOWS gates;
  injects CHAT inbox; is installed BY setup. **Adding a primitive** = register in `bootstrap.ts` (+ thread via
  `dispatch.ts` if it reads pack content, + register in test registries if pack rules call it — see [Change-impact](#change-impact-map)).

### 4.3 Packs

- **Owns:** `manifest.yaml` (+ `skills/*/skill.yaml`) and the optional side-files `fsm.yaml`, `team.yaml`,
  `models.yaml`, `drift_response.yaml`, `chat_agent.yaml`, `channels.yaml`, `notifications.yaml`, **`procedure.md`**;
  the loader (`loadPack`); the runtime `Pack` object (`types.ts:351`); the 13 builtin packs.
- **Touchpoints:** the `fullstack-flow` pack DEFINES the FLOWS FSM+gates (v2; `coding-flow` = v1 legacy); `models.yaml` configures MEMORY's
  embedder/LLM aliases; side-files are threaded by RUNTIME dispatch; packs are located by SETUP
  (`active.json`); pack rules call MEMORY (`recall`/`store_lesson`) and inject the rubric/procedure.
- **A pack is the unit of behavior.** Editing a pack changes the agent's flow, gates, and injected guidance at once.

### 4.4 Flows / Gates

- **Owns:** the **v2 design-of-record `fullstack-flow`** — an inline FSM (`pack.yaml`, `scope → scope_write →
plan → author → code → deploy → verify → accept → done`) whose five user-facing stages (SCOPE → PLAN →
  AUTHOR → CODE → DEPLOY) are each a **deterministic zero-LLM gate** (a pure predicate over `buildGuardCtx`,
  `on_fail: block`) LAYERED with a guess-free **content-audit** (`VERDICT: GUESS_FREE`, one verdict vocabulary
  across all four content stages — no `SPEC_COMPLETE` in v2). The gate context reads the coverage checker
  (`src/runtime/coverage/{anchors,check}.ts`), the 7-phase ledger, and the work-graph. The **git-owned hard
  boundary** `gate.ts` (pre-commit/pre-push, binds to agents, humans pass; `DISCIPLINE_PACKS =
['coding-flow','fullstack-flow']`, `gate.ts:50`) is the fail-closed floor; the **request-type classifier**
  (`request_type.ts`) arms the flow. The **v1 `coding-flow`** pack (idle→SCOPE→TASK-AUTHORING→CODE, 9 states;
  guess-audit→`GUESS_FREE`, spec-audit→`SPEC_COMPLETE`, 7-phase log) is the still-shipped opt-in legacy default
  (see `flows.md` §3/§3a).
- **Touchpoints:** the FSM IS a PACK side-file; the gates run via RUNTIME primitives (`cached_audit` spawns
  subagents; the deterministic predicates read on-disk state, no spawn); the audits read the rubric DOCS and
  write the FSM STATE; `log_phase` writes MEMORY (phase ledger); `gate.ts` reads session STATE written by the
  hooks (FSM `fsm-<pack>.json`, the code-audit cache, the active task + phase ledger) and re-checks diff
  staleness. **Two-layer design:** in-session PreToolUse gates = best-effort NUDGE (the v2 `enforceOnly` block
  path fires only under `OPENSQUID_AUTOMATION=1`, `pre-tool-use.ts:328`); `gate.ts` = fail-closed at commit.

### 4.5 Memory

- **Owns:** the RAG store (`libsql-fastembed` default; per-file `store/lessons/<id>.md` = git-versionable truth;
  lexical + claude-auto-memory backends); the Lesson type (durability, retired_at, tier/namespace); recall/memorize/forget;
  the **wedge gate** (anti-self-grading lesson promotion); the **work-graph** (event-sourced op-log + libSQL projection,
  claim/audience; **per-project** — one shared store/clock with a `project` column, resolved server-side like the
  kanban namespace, degrading a marker-less session to `'legacy-global'`); compression + 30-day retention/demote.
- **Touchpoints:** recall is CALLED by pack rules + injected by RUNTIME (`recall_pre_inject`); the scope **namespace**
  comes from the active umbrella (SHARED with CHAT); `models.yaml` (PACKS) picks the embedder; `log_phase` (FLOWS)
  writes the ledger; memorize writes are scoped by the umbrella resolved from cwd/channels.json (SETUP/CHAT).
- **Scope is fail-closed:** null namespace → only `shared` memory; cross-project leakage is structurally prevented.

### 4.6 Chat

- **Owns:** the long-lived `chat-daemon` (owns the bot tokens, a UDS socket, writes umbrella inbox JSONL);
  umbrella routing (`channels.json`, pure FSM); the inbound watcher (real-time push) + Stop-hook drain (fallback);
  outbound `chat_send` (the separate `opensquid-chat-bridge-mcp` server → daemon RPC); the live-session lease.
- **Touchpoints:** the daemon is configured BY setup (`config.json`/`channels.json`); inbound injects into the
  RUNTIME hooks (UPS additionalContext / Stop drive); the **umbrella key is SHARED with MEMORY scoping** and the
  lease; chat is the remote I/O over the WHOLE session. **Known fragility:** the inbound watcher can die silently
  in long sessions → degrades to the turn-boundary drain (see [Stale/disconnect](#stale--disconnected)).

---

## 5. Relationship matrix — "if I change ROW, it affects COLUMN"

| ↓ change / → affects | Install                                                 | Runtime                             | Packs                                         | Flows                                                           | Memory                               | Chat                              |
| -------------------- | ------------------------------------------------------- | ----------------------------------- | --------------------------------------------- | --------------------------------------------------------------- | ------------------------------------ | --------------------------------- |
| **Install/Setup**    | —                                                       | hooks must re-register              | pack discovery (`active.json`)                | gate install                                                    | store/scope paths                    | daemon tokens+routing             |
| **Runtime**          | hook bin names ↔ `package.json` `bin` + settings-writer | —                                   | dispatch threading of side-files              | primitives the gates call                                       | recall/state primitives              | inbox drain + chat_send           |
| **Packs**            | —                                                       | new side-file ⇒ thread in dispatch  | —                                             | **fullstack-flow pack = the FSM+gates** (v1 coding-flow legacy) | models.yaml ⇒ embedder; recall rules | chat_agent.yaml                   |
| **Flows**            | gate.ts ↔ git hooks                                     | audit primitives, classifier in UPS | the fullstack-flow / coding-flow pack content | —                                                               | log_phase ⇒ ledger; rubric docs      | stop-guard reads FSM + open-count |
| **Memory**           | store/db paths                                          | recall/recall_pre_inject shape      | recall hits feed pack rules                   | request-type/FSM records drive gates                            | —                                    | umbrella namespace = scope key    |
| **Chat**             | channels.json/config.json                               | inbound event → hooks               | chat_agent binding                            | —                                                               | umbrella key = memory namespace      | —                                 |

Read a row before you change that subsystem. Each non-empty cell is a place that can break.

---

## 6. Config & state layout (canonical)

The shared substrate. Detailed shapes in `docs/state-formats.md`; this is the index.

```
~/.claude/settings.json        hooks: 6 opensquid-hook-* entries (@opensquid:true)   ← WRITTEN BY setup; READ BY host→runtime
~/.claude.json                 mcpServers: opensquid + opensquid-chat                 ← WRITTEN BY setup; READ BY host
~/.codex/hooks.json            5 events (codex parity, absolute bin paths)            ← WRITTEN BY setup
~/.opensquid/
  active.json                  opted-in packs (user scope)                            ← Packs
  models.yaml                  model aliases (reasoning, fast_classifier, ...)         ← Packs/Memory/LLM
  channels.json                umbrella routing (members→umbrella→telegram target)    ← Chat + Memory(namespace)
  config.json                  chat bot tokens (chmod 600)                            ← Chat
  .env                         API tokens (chmod 600; canonical per SHL.1)            ← Chat/SDK
  rag.sqlite / store/lessons/  RAG store + per-file git-versionable truth             ← Memory
  workgraph.db / workgraph/    work-graph projection + per-op files                   ← Memory
  lessons/<status>/            wedge-gate lessons (per-file source)                   ← Memory
  phase_ledger/<taskId>/       durable 7-phase audit ledger                           ← Flows→Memory
  sessions/<sid>/state/        fsm-<pack> (e.g. fsm-fullstack-flow), request-type, *-audit-cache, ledgers  ← Runtime/Flows
  sessions/<sid>/active-task.json  the active task signal                             ← Runtime/Flows/git-gate
  umbrellas/<id>/inbox/*.jsonl + live-session.lease                                   ← Chat
  chat-daemon.{sock,pid,log}   daemon endpoints                                       ← Chat
<project>/.opensquid/active.json + .opensquid/attestations.jsonl                      ← Packs / git-gate
```

---

## 7. Change-impact map

The "what gets brittle when you touch X" reference. **Before changing a left-column item, check the right column.**

| If you change…                                                                                       | …re-verify (these get brittle)                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`fullstack-flow/pack.yaml` `fsm`** (states/guards/transitions; v1 `coding-flow/fsm.yaml` likewise) | every `guard`/`advance_fsm` binding; the gates that read state (execute-gate, pause-stop-guard); `gate.ts` (fullstack-flow: `isComplete` phases ∧ code-audit `GUESS_FREE` ∧ diff-staleness; v1: `phases_complete`); request-type arm path; the FSM-active set in `rubric_pre_inject`/`procedure_pre_inject` |
| **session-state shape/key** (`sessions/<sid>/state/*`)                                               | all `read_state` consumers across packs; the audits' cache keys; the classifier record; `gate.ts` (reads FSM+phases+active-task); the request-type consumers                                                                                                                                                |
| **a pack side-file** (add/rename, e.g. `procedure.md`)                                               | `loadPack` (load it), `types.ts` `Pack` (field), `dispatch.ts` (thread it into eval ctx), the consuming primitive, and **test registries** (`coding-flow.test.ts`/`default-discipline.test.ts` must register any primitive a shipped rule calls — or dispatch tests break)                                  |
| **a new primitive** (`src/functions/*`)                                                              | register in `bootstrap.ts`; export in `src/functions/index.ts`; if it reads pack content, add the field to `FunctionContext` + thread in `dispatch.ts`; if a shipped pack rule calls it, register it in the dispatch test registries                                                                        |
| **the rubric** (`packs/builtin/fullstack-flow/rubric/{scope,plan,author,code}.md`)                   | BOTH the audit pass-criteria AND the agent-injected guidance change (single-source by design — that's the point; don't add a second copy). The rubrics cite the design-of-record at `loop/docs/design/opensquid-v2-coding-flow-design.md` (the loop repo, not opensquid)                                    |
| **hook wiring** (`package.json` `bin` ↔ `settings-writer.ts` `OPENSQUID_BIN_FOR_EVENT`)              | the whole pipeline: a renamed/missing bin = that event silently no-ops; re-run `opensquid setup wizard hooks` + `doctor hooks`                                                                                                                                                                              |
| **the umbrella/namespace key** (`channels.json` routing or `scope.ts`)                               | Chat routing AND Memory scoping AND the live-session lease all key on it together — change one, reconcile all three                                                                                                                                                                                         |
| **the RAG backend / Lesson schema** (`src/rag/`)                                                     | `recall`/`recall_pre_inject`, all backends (libsql/lexical/auto-memory + the fallback wrapper), per-file source round-trip, `rebuildLibsqlIndex`, the wedge store                                                                                                                                           |
| **the git gate** (`gate.ts`)                                                                         | the gate-binding model (agents armed / humans pass); `isDocsOnly`; the attestation trail (pre-commit ↔ pre-push); the in-session execute-gate must stay consistent with it                                                                                                                                  |
| **`command_invokes` / matchers**                                                                     | the git-class guards in `default-discipline` (never-amend, no-force-push-main, npm-version); `command_boundary.skill.test` (regression guard)                                                                                                                                                               |
| **the version (minor/major bump)**                                                                   | the final-audit-flow gate (planned, `wg-54eef8b4927c`) + `gate.ts` version-bump detection (FA.0 positional matcher shipped)                                                                                                                                                                                 |

**Process rule that falls out of this map:** never change a subsystem in isolation. A pack edit is a flow
edit; a state-shape edit is a gate edit; a key edit is a chat+memory edit. Walk the arrows.

---

## 8. Stale / disconnected (cleanup backlog, grounded)

Found during this mapping; each is a real disconnect to clean (drives the cleanup pass, tracked in the work-graph):

- **Pack discovery is not resilient** (`wg-a3e928b8255b`, **HIGH** — verified via CLI audit): one malformed pack in `~/.opensquid/packs/` crashes every pack-enumerating command (`schedule list`, `triggers list`, …) — `loadPack` throws on the first bad pack even when it isn't in `active.json`. Trigger here: a stale `a-user-pack.dpc6-backup/` dir. Discovery of the installed SET should fail-soft per-pack (skip+warn); an explicitly-loaded pack can still fail loud.
- **`dist/` ships dead code** (`wg-98a8d32127dd`, **HIGH** — ships to npm): `tsc` never cleans `dist/`, so `dist/anti-drift/*`, `dist/engine-client.js`, `dist/rag/backends/loop_engine.js`, and **56 `*.test.js`** (all with no live `src/`) accumulate and ship. Fix: `rm -rf dist` before build. (`npm/engine-*` = local cruft, not shipped.)
- **Install-flow holes** (`wg-5eedceaaa19f`): no `postinstall`/first-run nudge; `setup wizard mcp` `detectOpensquidRoot()` is dead code (defined, never called); the README happy-path assumes manual wizard steps; `daemon start/stop/restart` are stubs.
- **`~/.loop/.env` vs `~/.opensquid/.env`** — the chat wizard still references `~/.loop/.env` in places (SHL.1 made `~/.opensquid/.env` canonical); reconcile. The `~/.loop` tree is a rename remnant.
- **`dist/anti-drift/*`** — legacy 0.7.x monolith compiled output; superseded by `src/runtime/hooks/*` + dispatch; should not ship (and `dist/**/*.test.js` shouldn't ship either — packaging bloat).
- **Stale ADR paths** — `~/.opensquid/personas/` + `teams/` (ADR-0013) never built; `team.yaml` is the real mechanism (`wg-b400d5bc5ada` gap 2: docs/terminology).
- **Compression orchestrator** (`compression_orchestrator.ts`) — "TBD wiring"; consolidation not yet invoked at session boundary.
- **Chat watcher unsupervised** (`wg-83e8e91f39d2`) — dies silently in long sessions → silent fallback to turn-boundary drain; not auto-restarted.
- **channels.yaml / notifications.yaml** — pack side-files defined but not folded into the runtime Pack (await notification-router).
- **`memorize` synchronous confirm gate** (`wg-84d0d73b89c5`) — out of step with the decided records-everything + deferred-validation model (memory cluster, post-0.6.x).
- **Memory cluster (post-0.6.x, parked):** git-versioned memory (`wg-7f4df49787cb`), 30-day retention slices 2-3 (`wg-9e4f4eb2a40f`), stale-context durability/decay (`wg-4f91e0b5cb8c`).

---

## 9. How to use this doc

- **Before a change:** find the subsystem (§4), read its touchpoints, then the [Change-impact map](#change-impact-map). Walk the arrows.
- **Onboarding / "what does what":** §1–§3.
- **Finding stale/disconnected work:** §8 (kept in sync with the work-graph).
- **Exact shapes/APIs:** follow the deep-dive links — this doc is the map, not the territory; keep the details single-sourced in those docs, and keep _this_ doc the authoritative map of how they connect.

---

## 10. Requirements manifest (CFD.1 — deterministic coverage)

The 0.6.0 discipline rebuild's **in-repo requirement manifest**, verified deterministically by
`src/runtime/coverage/` (report-only today). Each entry is checked against the code: `reachable`/`binding` are
gated by their `proof`-test (the authority; static checks advisory), `absent` is the negative requirement
(exact-token). The author gate also reads `docs/coverage-allowlist.txt` (the adoption BASELINE — pre-existing
gated exports are grandfathered; new exports need a covering requirement: a forward ratchet). The two dead-cluster
deletion seeds (`skill_router`, `skill_prefilter`) are now MET. (`drift_response` is intentionally NOT a deletion
target: the per-pack-configurable drift system — each pack declares its policy via `drift_response.yaml`, resolved
per-rule by the dispatcher — IS the v2 design, documented in `docs/pack-system-guide.md`. An earlier seed wrongly
slated it for deletion; removed 2026-06-29.) Spec: `loop/docs/tasks/T-v2-coverage-foundation.md`.

```yaml requirements
requirements:
  - id: R-SKILLS-PER-STATE
    intent: 'the FSM state is the router — skills(S) bound on entry, unloaded on leave (SKILL.1)'
    spec: 'ARCHITECTURE.md#4'
    assert: { kind: reachable, symbol: onStateEntry, from: [pre-tool-use, post-tool-use] }
    proof: 'src/runtime/skill/state_skills.live.test.ts'
  - id: R-AUDIT-CTX
    intent: 'guards can read guess/spec verdicts + phase state in buildGuardCtx'
    assert: { kind: binding, ctx_key: 'verdict.guess', in: buildGuardCtx }
    proof: 'src/runtime/loop/audit_ctx.test.ts'
  - id: R-DELETE-SKILL-ROUTER
    intent: 'the relevance-guessing router MODULE is gone (state is the router)'
    assert: { kind: absent, symbol: skill_router }
  - id: R-DELETE-SKILL-PREFILTER
    intent: 'the skill prefilter MODULE is gone'
    assert: { kind: absent, symbol: skill_prefilter }
  # V2-ENF.2 (wg-0baaae4bcf2e) — mandatory reporting enforcement: one covering requirement per scoped element
  # of loop/docs/design/opensquid-reporting-model.md §7 (+ §5.4b/§5.4c). Each names the primary export + its
  # live-path proof-test (the authority; the static `from` hint is advisory — these surface through the loop's
  # post_tool_call path). Data-shape exports (types/interfaces/schema consts) are baselined in the allowlist.
  - id: R-REPORT-CHECKLIST
    intent: 'the workgraph IS the checklist — resolve before-commitment sub-issues (closed=done, open=unresolved, wedged=deferred) (reporting-model §7.1/§4.2)'
    spec: 'loop/docs/design/opensquid-reporting-model.md#7.1'
    wg: wg-0baaae4bcf2e
    assert: { kind: reachable, symbol: resolveChecklist, from: [post-tool-use] }
    proof: 'src/runtime/loop/report_checklist.test.ts'
  - id: R-REPORT-TEMPLATE
    intent: 'the 9 report types materialize as core md-templates, pack-overridable with a core-default fallback (reporting-model §7.2)'
    spec: 'loop/docs/design/opensquid-reporting-model.md#7.2'
    wg: wg-0baaae4bcf2e
    assert: { kind: reachable, symbol: readReportTemplate, from: [post-tool-use] }
    proof: 'src/runtime/loop/report_template.test.ts'
  - id: R-REPORT-RESOLUTION
    intent: 'block-on-unresolved at the stage-exit gate, AUTOMATION-GATED — holds under OPENSQUID_AUTOMATION, never blocks interactive (reporting-model §7.3)'
    spec: 'loop/docs/design/opensquid-reporting-model.md#7.3'
    wg: wg-0baaae4bcf2e
    assert: { kind: reachable, symbol: reportResolved, from: [post-tool-use] }
    proof: 'src/runtime/loop/report_resolution.test.ts'
  - id: R-REPORTS-DIR
    intent: 'SAVED reports land under <project>/.opensquid/reports/, NEVER the global home (reporting-model §7.4/§3)'
    spec: 'loop/docs/design/opensquid-reporting-model.md#7.4'
    wg: wg-0baaae4bcf2e
    assert: { kind: reachable, symbol: saveProjectReport, from: [post-tool-use] }
    proof: 'src/runtime/loop/reports_dir.test.ts'
  - id: R-HANDOFF-DEDUP
    intent: 'the handoff dedups artifacts by path (fullstack-flow key-drift + double-send fix) (reporting-model §7.5)'
    spec: 'loop/docs/design/opensquid-reporting-model.md#7.5'
    wg: wg-0baaae4bcf2e
    assert: { kind: reachable, symbol: dedupeArtifactsByPath, from: [post-tool-use] }
    proof: 'src/runtime/handoff/collect.test.ts'
  - id: R-FAILURE-REPORT
    intent: 'on any failure (wedge|held_gate|crash) render a report stating the reason + resolving action, saved + surfaced (reporting-model §5.4b)'
    spec: 'loop/docs/design/opensquid-reporting-model.md#5.4b'
    wg: wg-0baaae4bcf2e
    assert: { kind: reachable, symbol: renderFailureReport, from: [post-tool-use] }
    proof: 'src/runtime/loop/failure_report.test.ts'
  - id: R-FOLLOW-REMINDER
    intent: 'the anti-drift follow-the-injected-procedure/rubric reminder (reporting-model §5.4c)'
    spec: 'loop/docs/design/opensquid-reporting-model.md#5.4c'
    wg: wg-0baaae4bcf2e
    assert: { kind: reachable, symbol: renderFollowReminder, from: [post-tool-use] }
    proof: 'src/runtime/loop/follow_reminder.test.ts'
```
