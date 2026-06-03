# Pre-research — T-FSM-UNIFY FU.12 (the per-write scope gate — close the flow's last door)

**Date:** 2026-06-03. **Repo:** opensquid. **Trigger:** re-evaluation — "the flow is
complete" was an over-claim. Code written with NO declared task is uncaught: the FSM
gate can be stuck post-`researched`, and the FU.11 task-start hook only fires on
`TaskUpdate(in_progress)`. Research this turn: Read of
`coding-flow/skills/scope-lifecycle/skill.yaml` (the code gate),
`src/functions/active_task.ts` (has_generated_spec). Cited.

## 1. Root cause (verified, file:line)

`scope-before-code` (`scope-lifecycle/skill.yaml:121-137`) blocks ONLY on the session
FSM `st` (`read_fsm_state`). It does not consult the active task. So:

- FSM at `phases_complete` (a prior task) + a NEW code write with no declared task →
  `st` is post-`researched` → **allowed**. Nothing ties the code to a scoped task.
- The FU.11 task-start hook only fires on `TaskUpdate(in_progress)` — if the agent
  never declares a task, it never fires.
- The execute-gate bites only at `git commit`, and fail-opens with no active task
  (`has_active_task.present == false`). So an unscoped code-write → commit path is open.

## 2. Fix design (derived)

Add a per-task condition to `scope-before-code`: also block when the active task has
no generated spec. `has_generated_spec` (`active_task.ts:120-143`) returns
`{present, generated}` where `generated == false` covers BOTH "no active task" (`:129`)
and "active task without a resolvable spec" (`:131,:134`) — one check.

New gate condition (block a code write when EITHER the track is pre-research OR the
task is unscoped):

```yaml
- call: has_generated_spec
  if: '(tool == "Write" || tool == "Edit") && (contains(targs.file_path,"src/") || contains(targs.file_path,"packs/") || contains(targs.file_path,"test/"))'
  as: spec
- call: verdict
  if: '… (code path) … && (st-pre-research… || spec.generated == false)'
  args:
    {
      level: block,
      message: 'no scoped active task — TaskUpdate(<id>,in_progress) on a task whose spec passed the audit, or scope it first',
    }
```

This makes code require a scoped active task, closing the door. The FSM check stays
(track-level); has_generated_spec adds the per-task truth.

## 3. Decisions (no unresolved guess)

1. **Extend `scope-before-code`, not a new skill** — derived: it is the single code
   gate; one rule keeps the OR-logic colocated.
2. **`generated == false` is the single predicate** — derived: it already collapses
   no-task + no-spec (`active_task.ts:129,131`).
3. **Test impact, acknowledged:** the FU.2 scope-gate test dispatches code writes with
   NO active task seeded, so it will now block even after the research doc — UPDATE it
   to seed a scoped active task (writeActiveTask with a resolvable `spec`). Add a new
   case: FSM past-researched + no scoped task → blocked.

## 4. Open questions — none that block. (Strictness is intended: in the coding-flow

discipline, every code write belongs to a scoped task.)
