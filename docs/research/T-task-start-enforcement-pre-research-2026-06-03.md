# Pre-research — T-FSM-UNIFY FU.11 (the task-start hook: per-task flow enforcement)

**Date:** 2026-06-03. **Repo:** opensquid. **Trigger:** the user observed nothing
stops/nudges the agent when it STARTS a new task — so it rides the previous task's
completed state and skips scope. Research this turn: Read of `coding-flow/fsm.yaml`,
`src/runtime/fsm.ts`, `coding-flow/skills/entry-and-handoffs/skill.yaml`,
`src/functions/active_task.ts`. Every claim cited.

## 1. Root cause (verified, file:line)

1. **The FSM is SESSION-level, not per-task.** State persists at
   `<sess>/state/fsm-coding-flow.json` keyed by session (`fsm_state.ts`), not by
   task. So after one task reaches `phases_complete` (`coding-flow/fsm.yaml:36`), the
   next task's code write reads that same post-`researched` state.
2. **`scope-before-code` keys on the session FSM.** It blocks only when
   `st ∉ {researched, spec_authored, spec_complete, tasks_loaded, phases_in_flight,
phases_complete}` (`coding-flow/skills/scope-lifecycle/skill.yaml`). At
   `phases_complete` it allows code — so a NEW, unscoped task is waved through.
   Observed live: FU.10's code rode FU.9's `phases_complete`.
3. **No task-start signal resets or nudges the flow.** `enter-scoping` only advances
   `idle → scoping` (`entry-and-handoffs/skill.yaml` enter-scoping), so it is inert
   once the machine has moved past `idle`. Nothing fires when a task is activated.

## 2. Fix design (derived; the task-start hook the user asked for)

The "start work" signal that the dispatcher already sees is **`TaskUpdate(<id>,
in_progress)`** — a `tool_call` (PreToolUse). Bind a guard to it:

- Read `has_active_task` + `has_generated_spec` (`active_task.ts:43,120` — the latter
  is true iff the active task's `metadata.spec` resolves to a file on disk).
- If the just-activated task is **unscoped** (`has_generated_spec.generated == false`):
  `advance_fsm(task_unscoped)` + a `directive` verdict nudging "scope this first
  (research → 11-field spec) before code."
- If **scoped**: no-op — the per-task phase ledger already handles EXECUTE (a new
  active task starts a fresh ledger — `workflow_phases.ts` `appendPhase`).

**FSM addition (one wildcard transition):** `{ from: '*', on: task_unscoped, to:
scoping }`. `step` supports `from === ANY_STATE` (`fsm.ts:106`), so this resets the
machine to `scoping` from ANY state. Then `scope-before-code` (already loaded) fires
for the new task — the reset is what re-arms the always-on gate. Totality preserved
(`validateFsm`).

**Directive pattern:** mirror `handoff-research-to-spec` (`entry-and-handoffs/skill.yaml`)
— a `verdict` `level: directive` with a `next_action` rationale.

## 3. Decisions (no unresolved guess)

1. **Trigger = `TaskUpdate(in_progress)`** — derived: it is the explicit "I am
   starting this task" signal, already a `tool_call` event; no native TaskStart hook
   exists, but the dispatcher sees this.
2. **Key on `has_generated_spec` (per-task), not the session FSM** — derived: the
   gap is that the FSM is session-level; the proven per-task signal is the active
   task's spec-on-disk (the old scope-architect "Gate A", `active_task.ts:108-143`).
3. **Reset via a `*`-wildcard transition** (`task_unscoped → scoping`), not a new
   primitive — derived: `step` already supports `*` (`fsm.ts:106`); reuse `advance_fsm`.
4. **Scope of THIS task = the task-start nudge only.** A per-WRITE `has_generated_spec`
   gate on every code write (catches code with no declared task at all) is a STRICTER
   complementary change — flagged as a follow-up, not bundled, to keep this minimal.

## 4. Open questions — none that block. (The per-write hard gate in §3.4 is a

separate, flagged follow-up.)
