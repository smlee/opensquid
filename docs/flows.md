# OpenSquid — App Flows (the end-to-end map)

The single reference that traces every major flow from a cold install to a running, gated session.
Every claim is cited `file:line` against the tree at the time of writing (2026-06-10; §3 reconciled to the
v2 `fullstack-flow` design-of-record 2026-07-03). Where a flow has a KNOWN GAP, it is marked **⚠ GAP** with
the audit evidence. Where a step is NOT yet fully traced, it says so — no guesswork.

> Maintenance rule: when a flow changes, update the cited line here. A drift between this doc and the code
> is itself a finding. (This doc exists because the first-run audit found NO flows map — only
> `docs/pack-fsm-architecture.md` for the FSM internals.)

---

## 0. The layers (what state lives where)

| Surface                 | Path                                                                     | Written by                                                     | Read by                                             |
| ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------- |
| Claude Code hooks + MCP | `~/.claude/settings.json`                                                | wizard: `src/setup/wizard/settings-writer.ts`, `mcp-writer.ts` | Claude Code at session start                        |
| git gates               | `<repo>/.git/hooks/pre-commit,pre-push`                                  | `src/setup/wizard/git-hooks.ts` (`opensquid gate install`)     | git on commit/push                                  |
| pack activation         | `<scope>/.opensquid/active.json` `{packs:[]}`                            | **⚠ nothing — user hand-authors**                              | `bootstrap.ts:321-347` → `discovery.ts:218`         |
| project identity        | `<cwd>/.opensquid/project.json` `{version,id,uuid}`                      | **⚠ nothing (paths.ts:130-168 READ-only)**                     | `resolveProjectUuid` (paths.ts:187)                 |
| chat routing            | `~/.opensquid/channels.json`                                             | **⚠ wizard omits it**                                          | `routing.ts:133-148 loadChannelsConfig` (null-safe) |
| memory store            | `~/.opensquid/rag.sqlite` + `store/lessons/`                             | `memorize` / importer / compression                            | `recall(query,k,scope)` (scoped)                    |
| FSM / phase state       | `~/.opensquid/sessions/<id>/state/{fsm-<pack>,*-audit-cache,phase}.json` | the flow gates (fullstack-flow v2 / coding-flow v1)            | the gates + `gate.ts` + `read_state`                |

---

## 1. Install → first-run → setup

1. **Install** the `opensquid` CLI (`src/cli.ts` is the entrypoint; commands registered via
   `registerSetupWizard` from `setup/cli/hooks.ts`, `registerSetup` from `setup/cli/chat.ts`, `registerGate`,
   `registerDoctor`, etc., cli.ts:33-42).
2. **`opensquid setup wizard hooks`** → writes the 5 Claude hooks (PreToolUse/PostToolUse/SessionStart/Stop/
   UserPromptSubmit) into `~/.claude/settings.json` (`settings-writer.ts`) + the MCP servers `opensquid` +
   `opensquid-chat` into `mcpServers` (`mcp-writer.ts`) + the git pre-commit/pre-push hooks (`git-hooks.ts`).
   **✅ verified by the audit — this path wires hooks + MCP correctly.**
3. **`opensquid setup chat`** → `buildPlan()` (`setup/cli/chat_actions_writers.ts`) writes
   `models.yaml`, `.env`, the pack `manifest.yaml`, `chat_agent.yaml`, **and — GAP A CLOSED at 0.5.381
   (T-fix-first-run-setup-completeness FRS.A)** — `.opensquid/project.json` when the FULL identity
   resolution (`OPENSQUID_PROJECT_UUID` env, then the cwd-walk) finds none: the orchestrator probes
   `resolveProjectUuid`, mints the uuid, and the card rides the WritePlan (previewed in dry-run, backed
   up, suppression-idempotent — an env uuid or existing card anywhere up the walk means no action).
   The `agent_bridge/cli.ts:233` instruction is now true for fresh users.
4. **Pack activation** — **GAP B CLOSED at 0.5.382 (T-fix-first-run-setup-completeness FRS.B,
   user-confirmed default):** after the pack step the wizard PROMPTS
   `Activate the "<pack>" discipline pack for this machine? [Y/n]` and, only on explicit consent
   (plus the plan confirm), writes user-scope `active.json` through the WritePlan with the MERGED
   deduped pack list (existing entries preserved, prior file backed up). Decline = the documented
   ungated state, now an explicit choice — the "no silent installs" invariant (`pack-runtime.md`
   §3.1) is preserved and SURFACED instead of doubling as an onboarding cliff.
5. **`opensquid doctor`** (`setup/cli/doctor.ts`) — self-diagnosis. _(Coverage of all pieces not re-verified
   in this pass — see Not-yet-traced.)_

**Net first-run state (as of 0.5.383 — the remediation track is COMPLETE):** hooks ✅, MCP ✅, git gates ✅,
models/chat config ✅, **project.json ✅ (0.5.381), pack opt-in prompted ✅ (0.5.382), channels.json
seeded ✅ (0.5.383 — minimal umbrella row; telegram target by manual edit)**. A fresh `opensquid setup
chat` yields a fully wired, optionally-gated agent. Track: `docs/tasks/T-fix-first-run-setup-completeness.md`
(loop repo).

---

## 2. Session lifecycle (fresh AND `--resume`)

**✅ verified by the audit — this layer is correct.**

1. **SessionStart fires** (`runtime/hooks/session-start.ts:9-12`) with a `source` discriminator:
   `startup` (new), `resume` (`--resume`/`--continue`/`/resume`), `clear`, `compact`. The bin **acts on both
   `startup` AND `resume`**, no-opping only `clear`/`compact` (session-start.ts:88-93). So a resumed session
   re-runs full session setup.
2. **Per-hook pack+registry load** — every hook binary (`pre-tool-use.ts`, `user-prompt-submit.ts`,
   `post-tool-use.ts`, `session-start.ts`) calls `loadActivePacks()` + `buildRegistry()` with ZERO
   cross-invocation cache (`bootstrap.ts:319-347`; hooks are short-lived subprocesses). So settings reload
   identically on fresh vs resumed sessions — there is no fresh-vs-resume branch to break.
3. **Resolution** — `resolveProjectUuid` (paths.ts:187: env `OPENSQUID_PROJECT_UUID` → cwd-walk for
   `.opensquid/project.json` → null) and `resolveUmbrellaForCwd` (`channels/routing.ts:249`, longest-prefix
   over umbrella members). A cwd in no umbrella → null umbrella → legacy per-project keying.
4. **SessionStart also** claims the umbrella chat lease (force-takeover) + injects the connection manifest
   (session-start.ts:95-130).

---

## 3. The gated coding flow — v2 (SCOPE → PLAN → AUTHOR → CODE → DEPLOY)

**Design-of-record: `fullstack-flow`** (`packs/builtin/fullstack-flow/pack.yaml`) — the v2 rebuild of the
coding flow as a single FSM-primary pack. It is what **opensquid itself runs** (`.opensquid/active.json`
pins `fullstack-flow`). Each stage is a **deterministic, zero-LLM gate** (a pure predicate over
`buildGuardCtx`, every `on_fail: block` — no always-true pass-through) LAYERED with a guess-free
**content-audit** (a `cached_audit` that must emit `VERDICT: GUESS_FREE`). `validateFsm` proves the machine
total (every emit routed, decision totality); it LOADS + ADVANCES on hook events through the live v2 runtime
(`V2ObservedActor` / `v2_supply`). Spec: `loop/docs/tasks/T-v2-track2-discipline.md` (T2.1); design:
`loop/docs/design/opensquid-v2-coding-flow-design.md`.

> **Implemented vs. intended.** fullstack-flow is **additive + opt-in**: it activates ONLY when pinned in
> `active.json` (pack.yaml:6). The v1 `coding-flow` pack (§3a) **stays the shipped out-of-box default** —
> neither discipline is auto-loaded; a fresh install is inert until one is pinned (`CHARTER.md` §"Make it the
> starting intent"). Promoting fullstack-flow to the default is an **OPEN QUESTION** for the user, not yet
> decided.

**FSM states** (pack.yaml:117-210): `scope → scope_write → plan → author → code → deploy → verify(decision)
→ accept(decision) → done(terminal)`. The five user-facing STAGES map onto the gate states; `scope_write`,
`verify`, and `accept` are internal helper states (the automated scope-artifact write, the deploy bug-fix
fork, and the human-acceptance touchpoint).

**Why gates, not executors:** the live observed actor advances only at gate/decision states — an executor
state is inert in observed mode (`v2_observed_actor.ts:74`). coding-flow is OBSERVED (the agent works in its
own harness; opensquid watches hook events), so the faithful translation of v1's pure states+transitions is a
gate chain whose triggers are hook events (pack.yaml:15-18).

### Stage 1 — SCOPE (`scope → scope_write → plan`)

- **Gate `scope_ready`** (pack.yaml:57): `!scope.is_advance || (scope.anchors_ok && !scope.open_question &&
contains(audit.scope, "VERDICT: GUESS_FREE"))`. The `!is_advance` short-circuit passes every non-advance
  event (the gate never blocks mid-scoping); only a Write/Edit of a `docs/research/*-pre-research-*` artifact
  is an advance, and then all three facets must hold: `anchors_ok` (every scoped element traces to the
  captured ask — the anti-drift verdict, `src/runtime/coverage/anchors.ts`), `!open_question` (no unchecked
  `- [ ] OPEN QUESTION` remains), and the GUESS_FREE content-audit verdict. Undefined verdict → `contains`→false
  → **block** (FAIL-CLOSED; loop-back until the producer's verdict lands).
- `scope_write` (pack.yaml:128) is the AUTOMATED state — its one job is to write the pre-research artifact +
  trigger the PLAN decompose; unlike `scope_ready` it has no short-circuit, so every non-advance event blocks
  until the artifact lands correctly.

### Stage 2 — PLAN (`plan → author`) — new top-level region vs v1

- **Gate `plan_ready`** (pack.yaml:67): `plan.acyclic && plan.complete && contains(audit.plan, "VERDICT:
GUESS_FREE") && contains(audit.scope, "VERDICT: GUESS_FREE")`. A deterministic check over the work-graph:
  `acyclic` (no cycle in the `blocks`+`parent-child` edges, Kahn) ∧ `complete` (every design element of the
  independent `extractScope` universe has ≥1 covering issue) ∧ the PLAN content-audit's GUESS_FREE verdict.
- **GFR.3 rolling re-audit:** the clause re-asserts the immediately-prior stage's verdict (SCOPE) still holds.
  Editing the scope artifact re-fires its content-audit (the cache is sha256(prompt)-keyed; a changed artifact
  re-evaluates), so drift is caught at the NEXT boundary, not only at the end. Only the immediately-prior
  stage is re-asserted — the cascade is transitive across gates.

### Stage 3 — AUTHOR (`author → code`)

- **Gate `author_ready`** (pack.yaml:75): `author.manifest_complete && author.real_code && contains(audit.author,
"VERDICT: GUESS_FREE") && contains(audit.plan, "VERDICT: GUESS_FREE")`. A deterministic check over the
  SHIPPED coverage checker (`src/runtime/coverage/check.ts`): `manifest_complete` (no gated export lacks a
  covering requirement — `report.orphans.length === 0`) ∧ `real_code` (every requirement MET — for
  reachable/binding this REQUIRES its proof-test to pass, so a stub with no passing proof fails). FAIL-CLOSED
  on a build error. Rolling re-audit re-asserts PLAN.

### Stage 4 — CODE (`code → deploy`)

- **Gate `code_ready`** (pack.yaml:85): `code.phases_complete && code.readiness_ran && code.deprecated_clean &&
contains(audit.code, "VERDICT: GUESS_FREE") && contains(audit.author, "VERDICT: GUESS_FREE")`.
  `phases_complete` = the shipped 7-phase ledger `isComplete` for the active task
  (pre_research→learn→code→test→audit→post_research→fix); `readiness_ran` = the three readiness surfacers ran +
  were recorded; `deprecated_clean` = the recorded readiness found NO known-deprecated call (a deprecated hit
  BLOCKS). FAIL-CLOSED (never-run readiness / no active task → block). Rolling re-audit re-asserts AUTHOR.
- The `flows.code_cycle` sub_flow (pack.yaml:217) is the §5-DEFERRED driven per-task region (one isolated
  machine per task); on the live OBSERVED path CODE is a plain gate (a sub_flow would park the flow and never
  reach DEPLOY, v2_observed_actor.ts:74).

### Stage 5 — DEPLOY (`deploy → verify → accept → done`)

- **Gate `deploy_ready`** (pack.yaml:89): `deploy.capability_ok` — the shipped `CapabilityGate` ALLOWS the
  deploy capability (SKIPPED→true when there is no deploy env, so a flow with nothing to deploy is not blocked).
- **`verify` decision** (DBL.1, pack.yaml:173): over `deploy.clean` (the recorded result of the configured
  `verifyCommand`). Clean → `accept`; **bugs → `author`** (re-spec the fix → code → deploy → re-verify — the
  bounded bug-fix loop, never ship broken); **DBL.2** `deploy.bugfix_exhausted` (round cap hit) → escalate to
  the human `accept` touchpoint instead of looping forever. `deploy.clean` defaults CLEAN when no verify is
  configured (mirroring `capability_ok`), preserving today's deploy→accept for unconfigured projects.
- **`accept` decision** (pack.yaml:183): `deploy.accepted` (the active task's durable acceptance item —
  survives a closed session, re-surfaces at start-up) → `done`. `deploy.reversible` (`active.json`
  `reversible: true`) → auto-accept (a reversible deploy can be undone). Else → loop back to `plan` (NEVER
  auto-declare "shipped").
- **FRONTEND enforcement** (FD5/FD6, `code_frontend_clean`, pack.yaml:105) is DEFINED but currently **UNWIRED**
  — its only evaluator (a bespoke `v2_enforce` PreToolUse hook) was removed as drift; re-wiring via the
  canonical commit-gate is deferred to the frontend slice (build order: frontend last).

### The git-owned hard boundary (both v1 and v2)

- **execute-gate / `gate.ts`**: the git **pre-commit/pre-push** hooks (`opensquid gate install`) read REAL
  session FSM state + the active-task phase ledger and BLOCK a commit when mid-flow or with phases incomplete.
  The matcher catches `cd <dir> && git commit` (the FU.1 fix); both backing reads **fail closed**;
  `isDocsOnly` lets a docs-only commit pass. This is the fail-closed floor beneath the in-session NUDGE gates
  (two-layer design), harness-agnostic, so `--no-verify` is futile.

### 3a. v1 `coding-flow` (the shipped default, legacy)

The proven v1 discipline: ONE total FSM (`packs/builtin/coding-flow/fsm.yaml`), three gated stages —
SCOPE → TASK-AUTHORING → CODE (`idle → scoping → researched → spec_authored → spec_complete → tasks_loaded →
phases_in_flight → phases_complete`), each with a `cached_audit` content gate (`VERDICT: GUESS_FREE` for
SCOPE, `VERDICT: SPEC_COMPLETE` for the 11-field task spec). It remains the shipped out-of-box default and the
grounding reference the v2 rubrics cite (`coding-flow/rubric/*.md`). fullstack-flow is its v2 rebuild — same
observed-mode semantics, PLAN + DEPLOY added, gates hardened to zero-LLM deterministic predicates.

---

## 4. Memory flow (recall / memorize / scope / compress)

- **recall** is **scoped** (T-memory-scope-isolation, 0.5.370-371): `RagBackend.recall(query, k, scope)` —
  `scope` is REQUIRED (scopeless recall = compile error). A pure `inScope` predicate (`rag/types.ts`):
  `shared` crosses every project, `project` matches its umbrella `namespace`; null namespace → shared only,
  fail-LOUD. The namespace = umbrella id (`rag/scope.ts`), so loop+opensquid collapse to one.
- **memorize** (`mcp/tools/memorize.ts`) tags tier + namespace; the auto-memory **importer** + the
  session-end **reconcile** (`session-end.ts:80 reconcileMemoryOnSessionEnd`) sync the per-project
  `~/.claude/projects/<cwd>/memory/` files into the RAG.
- **compression** consolidates memories (`rag/memory/compress.ts`); the consolidated `Mc` is durable across
  `rebuildLibsqlIndex` (T-fix-compression-durability, 0.5.369).
- **Axiom:** long-term RAG is append + compress, NEVER auto-delete (`project_memory_architecture_dual_surface_sync`).

---

## 5. Chat flow (remote terminal)

- The chat-daemon (`src/channels`, `dist/cli.js chat-daemon-worker` + `dist/mcp/chat-bridge-server.js`) owns
  the Telegram bot; inbound lands in `~/.opensquid/umbrellas/<id>/inbox/telegram.jsonl`, keyed by umbrella.
- A live session starts `opensquid chat watch` (a Monitor) at SessionStart; inbound streams in; replies go
  out via the `chat_send` MCP tool (`project:telegram` resolves the umbrella's outbound target).
- _(Full chat internals — lease handoff, the 409 single-poller constraint — not re-traced in this pass.)_

---

## Not yet traced (honest coverage limits)

- The `opensquid doctor` coverage (does it check ALL of: hooks, MCP, pack, project.json, daemon?).
- The content/validity of the files the wizard DOES write (models.yaml/.env/chat_agent.yaml correctness).
- Chat-flow internals (lease handoff, multi-umbrella).
- Whether `pack install` from a registry ever seeds a starter `active.json`.

## Known gaps → remediation tracks

- **A (HIGH):** `project.json` advertised but never written → `T-fix-first-run-setup-completeness`.
- **B (HIGH):** no pack activated by setup (opt-in cliff) → same track, wizard PROMPTS to activate.
- **C (LOW):** `channels.json` wizard-omitted.
- **Tooling:** `migrate-scope` is run-once, not a wired `opensquid` command.
