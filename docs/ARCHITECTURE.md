# OpenSquid — Architecture (single source of truth)

Version: 0.5.441 · Last updated: 2026-06-14

This is the **one** map of the whole system: what each part is, **how the parts depend on each
other**, and **what gets brittle when you change something**. opensquid is not a bag of features —
it is one interconnected loop. Treat this doc as the reference point before any change: find the
subsystem you're touching, read its relationships, then read the [Change-impact map](#change-impact-map).

Deep-dives (this doc is the entry point; these are the details):
`docs/pack-runtime.md` (pack format + dispatch), `docs/pack-fsm-architecture.md` (FSM engine),
`docs/flows.md` (FLOW templates), `docs/state-formats.md` (on-disk shapes), `docs/lexicon.md`
(design principles), `docs/rubric/{scope,author}.md` (gate criteria).

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
   │     MEMORY        │◀──store_lesson──────────────│ coding-flow FSM, │───────┘
   │ RAG + lessons +   │                             │ gates, git gate, │
   │ work-graph        │──recall feeds each turn────▶│ request-type     │
   └───────┬──────────┘                             └──────────────────┘
           │ umbrella/namespace key is SHARED with ▼
   ┌──────────────────┐
   │      CHAT         │  remote I/O over the whole session (inbound→hooks, outbound←chat_send)
   └──────────────────┘
```

The five load-bearing connections (memorize these — they are where disconnection happens):

1. **Packs DEFINE flows.** The `coding-flow` pack's `fsm.yaml` + skills ARE the lifecycle the Flows
   subsystem enforces. Change the pack → you change the flow.
2. **Flows WRITE memory.** `log_phase` writes the phase ledger; audits read the rubric docs; the
   request-type record + FSM state are session memory the gates read.
3. **Memory FEEDS packs/flows.** `recall` (+ `recall_pre_inject`) is what the agent knows each turn;
   the request-type + FSM records drive the arm decision and the stop guards.
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
        ├─ rubric_pre_inject / procedure_pre_inject← PACKS (coding-flow docs)  → additionalContext
        ├─ drainUmbrellaInbox                       ← CHAT (inbox)  → additionalContext
        └─ dispatchEvent
             └─ walk PACKS → skills → rules → evaluator → primitives
                  ├─ enter-scoping reads request-type → advance_fsm (FLOWS: scoping)   → STATE (FSM)
                  └─ directives (next_action)                                          → additionalContext
agent acts (Write/Edit/Bash/git/...)
  └─▶ PreToolUse hook → dispatch
        ├─ a pre-research Write → guess-audit (spawn) → GUESS_FREE → advance_fsm       → STATE (FSM)
        ├─ a spec Write → spec-audit → SPEC_COMPLETE → advance_fsm
        └─ git commit → execute-gate (in-session NUDGE)        [git gate.ts = the HARD boundary]
  └─▶ PostToolUse hook → phase-advance (after log_phase)        → STATE (FSM) + MEMORY (phase ledger)
agent stops
  └─▶ Stop hook → pause-stop-guard (reads request-type + FSM), maybeDriveInbound/streamOutput (CHAT)
session ends
  └─▶ SessionEnd hook → reconcile memory, compression, auto-handoff, clearFsmState
```

Every arrow crosses a subsystem boundary. That is the point: a change to any node ripples along its arrows.

---

## 3. Subsystems at a glance

| Subsystem         | Owns                                                                                 | Key code                                                                                                                                     | Deep-dive                              |
| ----------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Install/Setup** | the npm package, the wizards, the `~/.opensquid/` + `~/.claude/` layout              | `src/cli.ts`, `src/setup/`, `src/runtime/paths.ts`, `package.json`                                                                           | §4.1                                   |
| **Runtime**       | hooks → dispatch → evaluator → ~50 primitives; the event/verdict model               | `src/runtime/hooks/`, `dispatch.ts`, `evaluator/`, `src/functions/`, `bootstrap.ts`                                                          | `pack-runtime.md`                      |
| **Packs**         | pack format (manifest+skills+side-files), loader, the builtin pack set               | `src/packs/`, `src/runtime/types.ts` (`Pack`), `packs/builtin/`                                                                              | `pack-runtime.md`                      |
| **Flows/Gates**   | the coding-flow FSM, guess/spec/phase gates, git-owned gate, request-type classifier | `packs/builtin/coding-flow/`, `src/runtime/fsm*.ts`, `src/functions/cached_audit.ts`, `src/setup/cli/gate.ts`, `src/runtime/request_type.ts` | `pack-fsm-architecture.md`, `flows.md` |
| **Memory**        | RAG (libsql+fastembed), lessons + wedge gate, work-graph, compression/retention      | `src/rag/`, `src/workgraph/`, `src/runtime/phase_ledger.ts`, `src/mcp/tools/`                                                                | `state-formats.md`                     |
| **Chat**          | chat-daemon, umbrella routing, inbound watcher + drain, `chat_send` bridge           | `src/channels/`, `src/runtime/chat/`, `src/mcp/chat-bridge-server.ts`, `src/chat_daemon/client.ts`                                           | —                                      |

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
- **Touchpoints:** the `coding-flow` pack DEFINES the FLOWS FSM+gates; `models.yaml` configures MEMORY's
  embedder/LLM aliases; side-files are threaded by RUNTIME dispatch; packs are located by SETUP
  (`active.json`); pack rules call MEMORY (`recall`/`store_lesson`) and inject the rubric/procedure.
- **A pack is the unit of behavior.** Editing a pack changes the agent's flow, gates, and injected guidance at once.

### 4.4 Flows / Gates

- **Owns:** `coding-flow/fsm.yaml` (idle→SCOPE→AUTHOR→CODE, 9 states); the content gates — guess-audit
  (SCOPE→`GUESS_FREE`), spec-audit (AUTHOR→`SPEC_COMPLETE`), phase-log (7 phases); the in-session skills
  (entry-and-handoffs, scope-lifecycle, execute-gate, phase-advance/audit, pause-stop-guard, pause-prevention,
  task-start); the **git-owned hard boundary** `gate.ts` (pre-commit/pre-push, binds to agents, humans pass);
  the **request-type classifier** (research vs work, `request_type.ts`).
- **Touchpoints:** the FSM IS a PACK side-file; the gates run via RUNTIME primitives (`cached_audit` spawns
  subagents); the audits read the rubric DOCS and write the FSM STATE; `log_phase` writes MEMORY (phase ledger);
  `gate.ts` reads session STATE written by the hooks; the request-type record (written by the UPS hook) is read by
  enter-scoping + the stop guards. **Two-layer design:** in-session gates = best-effort NUDGE; `gate.ts` = fail-closed.

### 4.5 Memory

- **Owns:** the RAG store (`libsql-fastembed` default; per-file `store/lessons/<id>.md` = git-versionable truth;
  lexical + claude-auto-memory backends); the Lesson type (durability, retired_at, tier/namespace); recall/memorize/forget;
  the **wedge gate** (anti-self-grading lesson promotion); the **work-graph** (event-sourced op-log + libSQL projection,
  claim/audience); compression + 30-day retention/demote.
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

| ↓ change / → affects | Install                                                 | Runtime                             | Packs                            | Flows                                | Memory                               | Chat                           |
| -------------------- | ------------------------------------------------------- | ----------------------------------- | -------------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------ |
| **Install/Setup**    | —                                                       | hooks must re-register              | pack discovery (`active.json`)   | gate install                         | store/scope paths                    | daemon tokens+routing          |
| **Runtime**          | hook bin names ↔ `package.json` `bin` + settings-writer | —                                   | dispatch threading of side-files | primitives the gates call            | recall/state primitives              | inbox drain + chat_send        |
| **Packs**            | —                                                       | new side-file ⇒ thread in dispatch  | —                                | **coding-flow pack = the FSM+gates** | models.yaml ⇒ embedder; recall rules | chat_agent.yaml                |
| **Flows**            | gate.ts ↔ git hooks                                     | audit primitives, classifier in UPS | the coding-flow pack content     | —                                    | log_phase ⇒ ledger; rubric docs      | stop-guard reads request-type  |
| **Memory**           | store/db paths                                          | recall/recall_pre_inject shape      | recall hits feed pack rules      | request-type/FSM records drive gates | —                                    | umbrella namespace = scope key |
| **Chat**             | channels.json/config.json                               | inbound event → hooks               | chat_agent binding               | —                                    | umbrella key = memory namespace      | —                              |

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
  sessions/<sid>/state/        fsm-coding-flow, request-type, *-audit-cache, ledgers  ← Runtime/Flows
  sessions/<sid>/active-task.json  the active task signal                             ← Runtime/Flows/git-gate
  umbrellas/<id>/inbox/*.jsonl + live-session.lease                                   ← Chat
  chat-daemon.{sock,pid,log}   daemon endpoints                                       ← Chat
<project>/.opensquid/active.json + .opensquid/attestations.jsonl                      ← Packs / git-gate
```

---

## 7. Change-impact map

The "what gets brittle when you touch X" reference. **Before changing a left-column item, check the right column.**

| If you change…                                                                          | …re-verify (these get brittle)                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`coding-flow/fsm.yaml`** (states/transitions)                                         | every skill that `advance_fsm`; the gates that read state (execute-gate, pause-stop-guard); `gate.ts` `commitAllowedNow` (keys on `phases_complete` + 7 phases); request-type idle-return + RTC.4 stranded-scoping; the FSM-active set in `rubric_pre_inject`/`procedure_pre_inject` |
| **session-state shape/key** (`sessions/<sid>/state/*`)                                  | all `read_state` consumers across packs; the audits' cache keys; the classifier record; `gate.ts` (reads FSM+phases+active-task); the request-type consumers                                                                                                                         |
| **a pack side-file** (add/rename, e.g. `procedure.md`)                                  | `loadPack` (load it), `types.ts` `Pack` (field), `dispatch.ts` (thread it into eval ctx), the consuming primitive, and **test registries** (`coding-flow.test.ts`/`default-discipline.test.ts` must register any primitive a shipped rule calls — or dispatch tests break)           |
| **a new primitive** (`src/functions/*`)                                                 | register in `bootstrap.ts`; export in `src/functions/index.ts`; if it reads pack content, add the field to `FunctionContext` + thread in `dispatch.ts`; if a shipped pack rule calls it, register it in the dispatch test registries                                                 |
| **the rubric** (`docs/rubric/{scope,author}.md`)                                        | BOTH the audit pass-criteria AND the agent-injected guidance change (single-source by design — that's the point; don't add a second copy)                                                                                                                                            |
| **hook wiring** (`package.json` `bin` ↔ `settings-writer.ts` `OPENSQUID_BIN_FOR_EVENT`) | the whole pipeline: a renamed/missing bin = that event silently no-ops; re-run `opensquid setup wizard hooks` + `doctor hooks`                                                                                                                                                       |
| **the umbrella/namespace key** (`channels.json` routing or `scope.ts`)                  | Chat routing AND Memory scoping AND the live-session lease all key on it together — change one, reconcile all three                                                                                                                                                                  |
| **the RAG backend / Lesson schema** (`src/rag/`)                                        | `recall`/`recall_pre_inject`, all backends (libsql/lexical/auto-memory + the fallback wrapper), per-file source round-trip, `rebuildLibsqlIndex`, the wedge store                                                                                                                    |
| **the git gate** (`gate.ts`)                                                            | the gate-binding model (agents armed / humans pass); `isDocsOnly`; the attestation trail (pre-commit ↔ pre-push); the in-session execute-gate must stay consistent with it                                                                                                           |
| **`command_invokes` / matchers**                                                        | the git-class guards in `default-discipline` (never-amend, no-force-push-main, npm-version); `command_boundary.skill.test` (regression guard)                                                                                                                                        |
| **the version (minor/major bump)**                                                      | the final-audit-flow gate (planned, `wg-54eef8b4927c`) + `gate.ts` version-bump detection (FA.0 positional matcher shipped)                                                                                                                                                          |

**Process rule that falls out of this map:** never change a subsystem in isolation. A pack edit is a flow
edit; a state-shape edit is a gate edit; a key edit is a chat+memory edit. Walk the arrows.

---

## 8. Stale / disconnected (cleanup backlog, grounded)

Found during this mapping; each is a real disconnect to clean (drives the cleanup pass, tracked in the work-graph):

- **Pack discovery is not resilient** (`wg-a3e928b8255b`, **HIGH** — verified via CLI audit): one malformed pack in `~/.opensquid/packs/` crashes every pack-enumerating command (`schedule list`, `triggers list`, …) — `loadPack` throws on the first bad pack even when it isn't in `active.json`. Trigger here: a stale `sangmin-personal-rules.dpc6-backup/` dir. Discovery of the installed SET should fail-soft per-pack (skip+warn); an explicitly-loaded pack can still fail loud.
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
