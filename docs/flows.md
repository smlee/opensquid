# OpenSquid — App Flows (the end-to-end map)

The single reference that traces every major flow from a cold install to a running, gated session.
Every claim is cited `file:line` against the tree at the time of writing (2026-06-10). Where a flow has a
KNOWN GAP, it is marked **⚠ GAP** with the audit evidence. Where a step is NOT yet fully traced, it says
so — no guesswork.

> Maintenance rule: when a flow changes, update the cited line here. A drift between this doc and the code
> is itself a finding. (This doc exists because the first-run audit found NO flows map — only
> `docs/pack-fsm-architecture.md` for the FSM internals.)

---

## 0. The layers (what state lives where)

| Surface                 | Path                                                | Written by                                                     | Read by                                             |
| ----------------------- | --------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| Claude Code hooks + MCP | `~/.claude/settings.json`                           | wizard: `src/setup/wizard/settings-writer.ts`, `mcp-writer.ts` | Claude Code at session start                        |
| git gates               | `<repo>/.git/hooks/pre-commit,pre-push`             | `src/setup/wizard/git-hooks.ts` (`opensquid gate install`)     | git on commit/push                                  |
| pack activation         | `<scope>/.opensquid/active.json` `{packs:[]}`       | **⚠ nothing — user hand-authors**                              | `bootstrap.ts:321-347` → `discovery.ts:218`         |
| project identity        | `<cwd>/.opensquid/project.json` `{version,id,uuid}` | **⚠ nothing (paths.ts:130-168 READ-only)**                     | `resolveProjectUuid` (paths.ts:187)                 |
| chat routing            | `~/.opensquid/channels.json`                        | **⚠ wizard omits it**                                          | `routing.ts:133-148 loadChannelsConfig` (null-safe) |
| memory store            | `~/.opensquid/rag.sqlite` + `store/lessons/`        | `memorize` / importer / compression                            | `recall(query,k,scope)` (scoped)                    |
| FSM / phase state       | `~/.opensquid/sessions/<id>/state/*.json`           | the coding-flow gate skills                                    | the gates + `read_state`                            |

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
4. **Pack activation** — **⚠ GAP B (HIGH, by-design-but-no-scaffolding):** nothing writes
   `active.json`. A fresh user who finishes the wizard has an EMPTY pack list → an UNGATED agent (no
   coding-flow, no discipline). This is the deliberate "no silent installs" opt-in invariant
   (`pack-runtime.md` §3.1), but no wizard step prompts the user to opt a pack in, so the safety invariant
   doubles as an onboarding cliff.
5. **`opensquid doctor`** (`setup/cli/doctor.ts`) — self-diagnosis. _(Coverage of all pieces not re-verified
   in this pass — see Not-yet-traced.)_

**Net first-run state:** hooks ✅, MCP ✅, git gates ✅, models/chat config ✅; **project.json ❌, a pack ❌,
channels.json ❌**. The remediation track is `docs/tasks/T-fix-first-run-setup-completeness.md`.

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

## 3. The 3-stage coding flow (SCOPE → TASK-AUTHORING → CODE)

The flagship gate. ONE total FSM (`packs/builtin/coding-flow/fsm.yaml`), three gated stages, each with a
CONTENT gate. **✅ the audit found NO real holes here — the FSM is total + tested, gates fail closed.**

**FSM states** (fsm.yaml:18-26): `idle → scoping → researching → researched → spec_authored → spec_complete
→ tasks_loaded → phases_in_flight → phases_complete`.

### Stage 1 — SCOPE (`scoping/researching → researched`)

- Gate: **guess-audit** (`skills/scope-lifecycle/skill.yaml`). On a `docs/research/*-pre-research-*.md`
  write, a `cached_audit` (skill.yaml:89; model `reasoning`, 170s) audits the artifact for NEVER-GUESS +
  BEST-SOLUTION + FULL-FIX and must emit `VERDICT: GUESS_FREE`. The verdict is memoized by
  sha256(prompt) in cross-turn session state (0.5.373): a re-fire on UNCHANGED content is a cache HIT —
  no spawn; only `VERDICT:`-bearing output is ever cached.
- Preconditions BEFORE the audit string is judged: **open-question block** (artifact contains
  `OPEN QUESTION` → block: answer it in SCOPE) and **depth block** (`depth.count < 3` → "do real research");
  then the trichotomy `{GUESS_FREE → advance, UNRESOLVED → warn+loopback, no-verdict}`.
- The loop-back `researched --guess_found--> researching` is a `loopback_gate` FLOW template
  (`manifest.yaml:27-29` → `flows_compiler.ts:37-49`).
- **F0c note:** when the audit spawn times out (long session → spawn exhaustion), `on_error: continue`
  binds the error to the audit var → the AUDIT-UNAVAILABLE branch **blocks** (fails CLOSED), it does not
  advance; timeouts are never cached, so the next write retries. Since 0.5.373 (`cached_audit`) re-fires
  on unchanged content no longer spawn at all — the dominant exhaustion cause. A genuinely spent budget
  still recovers only via a fresh session.

### Stage 2 — TASK-AUTHORING (`spec_authored → spec_complete → tasks_loaded`)

- Gate: **spec-audit** (`scope-lifecycle/skill.yaml:186-268`). On a `docs/tasks/T-*.md` write, a
  `cached_audit` (skill.yaml:207, same memoization as the SCOPE audit) audits the 11-field contract +
  100% design coverage + Simplicity and must emit `VERDICT: SPEC_COMPLETE` (contract at
  skill.yaml:226-230) to fire `advance_fsm(spec_verified)`. INCOMPLETE only warns;
  audit-unavailable blocks (both stay `spec_authored`).
- **taskcreate-spec-required** (skill.yaml:319-346) BLOCKS `TaskCreate` unless `st == spec_complete`
  (or already past), except `track ∈ {fix, doc, trivial}`.
- A separate pack, **scope-architect / inline-spec-block**, blocks a spec write with NO pre-research on disk
  (its `base_file` cwd-anchor bug was fixed 0.5.372, c7b3cbd).

### Stage 3 — CODE (`tasks_loaded → phases_in_flight → phases_complete`)

- **scope-before-code**: `src/`∪`packs/`∪`test/` writes are BLOCKED before `spec_complete`
  (scope-lifecycle, the `scope-before-code` rule).
- **7-phase ledger**: `log_phase` (`mcp/tools/log_phase.ts`) records pre_research→learn→code→test→audit→
  post_research→fix against the active task; needs an active task (`active-task.json`, mirrored from the
  harness `TaskUpdate(in_progress)` by `active_task_mirror.ts`).
- **execute-gate** (`skills/execute-gate/skill.yaml:16-71`): the git **pre-commit/pre-push** hooks
  (`opensquid gate install`) read REAL session FSM state + the active-task phase ledger and BLOCK a commit
  when mid-flow or with phases incomplete. The matcher `\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b` (skill.yaml:27)
  catches `cd <dir> && git commit` (the FU.1 fix). Both backing reads **fail closed**.
- On task completion the FSM re-arms (`phases_complete --scope_start--> scoping`) so a NEW track is re-gated.

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
