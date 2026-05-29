# Load-budget audit (T-CTX-LOOP CTX.6)

**Date:** 2026-05-29
**Source:** docs/tasks/T-ctx-loop.md CTX.6; user 2026-05-29 locks:

- _"load/unload context feature is to help focus agents on the current goals"_
- _"it is also to reduce tokens as well"_
- _"per work we need load/unload context that is correct"_ (per-task unit)
- _"memory load/unload is part of the memory consolidation"_ (integrated cycle)

## The principle

For each resource carried in the per-turn working set, bias the working set
toward "satisfies current goal" and away from "doesn't." Load/unload is the
READ side of the same loop whose WRITE side is consolidation: CTX.0 verify,
CMP.4 compression, MAU.3 reconcile. Drift = the loop breaking at any
position.

## Per-resource audit table

| Resource                              | Cost per turn (est)          | Load decision                                                                                      | Consolidation tie-in                                                                           | Gap                                                       |
| ------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Global `~/.claude/CLAUDE.md` mind-map | ~360 tokens                  | Harness auto-load turn 1                                                                           | CTX.4 detects new project → propose addition via CTX.0 gate                                    | None — CTX.1 + CTX.4 close the loop                       |
| Local `MEMORY.md` mind-map            | ~290 tokens                  | Harness auto-load turn 1                                                                           | CTX.2 mind-map-staleness-prompt at session-end → propose updates via CTX.0 gate                | None — CTX.1 + CTX.2 close the loop                       |
| RAG recall (per turn)                 | up to 4000 tokens (cap)      | CTX.3 goal-token query composition + applyHitBudget (score + token-budget)                         | MAU.3 flushes verified writes to RAG; CMP.4 compresses verified-satisfied groups               | None                                                      |
| Pack skills (preload)                 | ~10 skills × small footprint | `Skill.load: preload` + `requires:` precondition (skill skipped silently when not applicable)      | Skills define WHEN their rule fires; conditional firing = unload-equivalent at evaluation time | T-WGRP-2 (regex flag-form bypass surfaced VOCAB.1) queued |
| Pack skills (lazy)                    | 0 when trigger absent        | `Skill.load: lazy` + `when_to_load: tool_match`/`file_glob` matchers                               | Same as preload                                                                                | None                                                      |
| Hook output (`additionalContext`)     | variable                     | Composed inline at user-prompt-submit from contextInjections + directives + CTX.4 new-project line | None at write side; READ-side surface only                                                     | None                                                      |
| MCP tool definitions                  | harness-fixed, ~7 tools      | Harness-managed; opaque to opensquid                                                               | N/A                                                                                            | N/A (out of opensquid's reach)                            |
| Conversation backlog                  | harness-managed              | Harness summarizer                                                                                 | N/A                                                                                            | Out of opensquid's reach                                  |

## Per-task load/unload boundary (user lock 2026-05-29)

Each task is its own load/unload boundary. The architectural map:

```
TaskUpdate(in_progress)  ────────────────►  LOAD-side at task start
                                              - active-task.json mirror seeds
                                              - recall query (CTX.3) prefixes
                                                with new task.subject + taskId
                                              - pack skills' requires: re-eval
                                                against new state

work happens (7-phase per CTX.1 workflow)
                                              consolidation candidates accumulate
                                              in wedge automation_buffer

TaskUpdate(completed)    ────────────────►  WRITE-side at task end
                                              - task-completion-consolidate
                                                skill (CTX.2) surfaces
                                                "consolidate this task's
                                                learnings via memorize?"
                                              - agent proposes candidates,
                                                user verbatim-confirms,
                                                CTX.0 gate writes
                                              - active-task.json clears or
                                                archives
```

The LOAD-side at task START is partly wired (CTX.3's goal-token reads the
new active-task immediately). What's NOT wired explicitly: a task-start
directive analogous to CTX.2's task-completion-consolidate that says
"a new task is starting; consider what context to drop from the working
set" + a session-state nudge for the agent to re-focus. Queued as
**T-TASK-START-FOCUS** follow-up.

## Primitives shipped (CTX.6)

### `applyHitBudget<T>(items, minScore, maxTokens) → {kept, truncated}`

Pure helper at `src/runtime/load_budget.ts`. Generic over any
`BudgetableItem` (score + tokenCost). Score-filters cheap first, then
whole-item-granular accumulates by tokenCost until budget exhausted.
First consumer: `recall_pre_inject` (the RAG hit selector, previously
inlined as `selectHitsForInjection`). Future resources that need
score+budget truncation reuse this primitive.

## Queued follow-up tracks

- **T-TASK-START-FOCUS** — task-start LOAD-side directive (analogue of
  CTX.2's task-completion-consolidate, but firing at TaskUpdate(in_progress)
  to surface "re-focus the working set toward this new goal")
- **T-WGRP-2** (queued during VOCAB.1 follow-up commit) — workflow gate
  regex precision phase 2 to handle `git -c <flag> commit` form
- **T-POSTPUSH** — verify-CI-after-push enforcement (needs PostToolUse hook
  surface)

## What this gives the user (e+a frame)

- Per-turn cost stays bounded because every consumed resource passes through
  a score + budget filter (recall ships this; others have hook-time
  composition limits)
- Focus stays sharp because each per-task boundary re-evaluates what's
  worth carrying forward
- Drift gets caught because consolidation requires verbatim confirmation
  before anything becomes durable
- The loop is one architectural principle applied across surfaces, not
  multiple disconnected gates
