# Pre-research — T-FSM-UNIFY FU.7 (the EXECUTE content gate: phase-logged-before-commit)

**Date:** 2026-06-03. **Repo:** opensquid. **Trigger:** the user observed the agent
keeps skipping the 7-phase CODE flow. Research done this turn: Read of
`sangmin-personal-rules/skills/workflow/skill.yaml`, `src/functions/active_task.ts`,
`src/runtime/hooks/dispatch.ts`. Every claim below is cited.

## 1. Root cause (verified, file:line)

`coding-flow` gates SCOPE and AUTHOR with content gates but leaves EXECUTE (the
7-phase CODE stage) un-gated interactively — the same hole, one stage down:

1. **No commit gate in `coding-flow`.** Its three skills are `scope-lifecycle`,
   `entry-and-handoffs`, `phase-advance` (loadPack output). `phase-advance` only
   ADVANCES the FSM on `log_phase`; no rule emits a `block` on `git commit`.
2. **The existing 7-phase gate is automation-mode-only → inert interactively.**
   `~/.opensquid/packs/sangmin-personal-rules/skills/workflow/skill.yaml:31-32`
   declares `requires: [{kind: automation_mode_on}]`; header :4,:12 confirm
   "automation OFF → dispatcher skips". So interactively nothing blocks a commit
   before the 7 phases — why every FU task committed with zero `log_phase` calls.
3. **Net:** SCOPE has `scope-before-code` + `guess-audit`; AUTHOR has
   `taskcreate-spec-required` + `spec-audit`; CODE/EXECUTE has neither a blocking
   commit gate — only the FSM advance.

## 2. Fix design (derived; primitive shapes verified)

Port `workflow-phases-required` (`workflow/skill.yaml:34-70`) into a new `coding-flow`
`execute-gate` skill, **mode-independent** (drop the `automation_mode_on` requires —
SCOPE/AUTHOR are already mode-independent):

- `match_command` on `tool_args.command` with the anchored git-commit pattern
  (`workflow/skill.yaml:38`) → `committing`; gate on bare `committing` exactly as the
  proven personal gate does (`:47,:50,:61,:64`).
- `has_active_task` → `{present}` (`active_task.ts:43-58`); `workflow_phases_complete`
  → `{active, complete}` (`active_task.ts:67-90`, `complete` ⟺ all 7 REQUIRED phases
  logged for the CURRENTLY-active task, `isComplete(state, active.id)`).
- `verdict block` if `committing && active.present == true && phases.complete == false`
  — names the remedy (`mcp__opensquid__log_phase` for each of the 7 phases).
- Ad-hoc commits (no active task) PASS (interactive practicality); the SCOPE gate
  already forces code work into the flow, so a tracked task is the in-flow case.

## 3. Interaction risk found (real; affects coding-flow robustness)

The dispatcher **short-circuits on the FIRST verdict** (`dispatch.ts:14`) walking packs
in scope order (`:331` `for (const pack of packs)`, skills `:337`). So when a
HIGHER-precedence user-scope pack emits ANY verdict on a pre-research / spec write
(e.g. `scope-architect/pre-research-authoring`'s DPC.5 "insufficient research" warn),
it short-circuits BEFORE `coding-flow` (project scope) walks — so coding-flow's
`advance-on-research` never fires and the FSM stays at `idle` (the gate then blocks all
code). Observed live this turn. **Decision:** out of scope for FU.7 (it is a dispatcher
ordering concern — side-effect advances arguably should run even past a verdict
short-circuit); FLAGGED as a follow-up. FU.7 only adds the missing commit gate.

## 4. Decisions (no unresolved guess)

1. Mode-independent (drop `automation_mode_on`) — derived: SCOPE/AUTHOR gates are
   already mode-independent FSM gates (`coding-flow/skills/scope-lifecycle`).
2. Active-task-scoped, not every-commit — derived: the personal gate's no-active-task
   block was automation-only (`workflow/skill.yaml:50-57`); blocking every interactive
   commit is impractical.
3. Mirror the proven `match_command` usage (bare `committing`) — derived from the
   shipped personal gate, not re-invented.

## 5. Open questions — none that block FU.7. (The dispatch short-circuit interaction

in §3 is a separate, flagged follow-up.)
