# Pre-research — coding-flow workflow-completeness audit + fix

**Date:** 2026-06-04. **Repo:** opensquid. **Trigger:** user audit request — verify the
`coding-flow` pack actually implements the intended personal workflow. **Method:** three
read-only Explore audits (workflow-enforcement, scoping-completeness, lexicon+orphans),
each evidence-backed (file:line). **User design ruling (this turn):** each region boundary
is crossed AUTOMATICALLY when that region's CONTENT is complete + audited — the same
mechanism at every boundary (scope→author→execute). No manual "begin" signal.

## 0. The automation boundary (the keystone — user ruling)

SCOPE is the ONE INTERACTIVE phase: the agent interrupts to ask the user, fills every gap,
and finds the BEST solution against the criteria (given + discovered). SCOPE is complete
when (a) all gaps are filled, (b) all questions are answered, (c) the best solution is found
per criteria (lexicon Simplicity + alternatives/inversion/spike). The MOMENT scope
completes, AUTHOR + EXECUTE run FULLY AUTOMATED — no questions, no pauses — to depletion.
So the pack must: PERMIT + REQUIRE question-resolution in SCOPE, and treat a question/pause
AFTER scope (FSM past `researched`) as DRIFT. This is why the gates felt wrong: the pack
had no notion of the interactive-scope vs automated-after split.

## 1. The intended workflow (the spec being audited against)

1. SCOPE + TASK AUTHORING back-to-back until the COMPLETE task list exists (every task
   fully specced, no gaps); ALL questions answered DURING scoping (gaps filled there).
2. THEN the 7-phase CODE layer runs per task.
3. As each task's 7 phases complete → a report is sent to the main chat → STRAIGHT to the
   next task, looping until all tasks deplete, NO pauses.
4. Lexicon principles (Simplicity, no-implicit-state, …) APPLIED, not just documented.
5. No gates left behind; every session/run works as intended.

## 2. Audit findings (gaps, with evidence)

- **req 1 — NOT enforced.** FSM is a single linear pass (`fsm.yaml:13-22`), not a per-task
  loop; `tasks_loaded` fires on the FIRST `TaskCreate` (`scope-lifecycle:170`) and
  `scope-before-code` (`:136`) then permits code. spec-audit never counts task blocks —
  one thin task passes. Per-task author→code interleaving is allowed.
- **req 2 — absent.** No rule keys off `phases_complete`; no `chat_send`/topic-15 anywhere
  in the pack; no next-task auto-advance; chain dead-ends at `phases_complete`.
- **req 3 — partial.** (a) flagged-but-UNANSWERED open questions pass `GUESS_FREE`
  (`scope-lifecycle:46-54`) and advance — nothing forces resolution. (b) `research_done`
  advance is UNCONDITIONAL on the audit (`advance-on-research` ordered first, `:17-31`);
  guess-audit is `warn`-only (`:63`) → SCOPE gate is advisory, not gating. (c) the depth
  gate (recall+Read+Grep≥3, DPC.5) + the three-section completeness gate (SG.1) live in
  `scope-architect`, which is NOT in `active.json` → dormant on the live umbrellas.
  spec-audit itself is sound (11-field + real-code, fail-closed, `:96-105`).
- **req 4 — documented, not enforced.** `docs/lexicon.md` exists (Simplicity Principle
  `:10`, no-implicit-state `:13`, determinism boundary `:18`, …). coding-flow only
  REFERENCES it in `manifest.yaml goal:` prose; neither guess-audit nor spec-audit applies
  any principle as a criterion.
- **req 5 — mostly ok.** All 6 hooks wired (`settings-writer.ts:36-47` + package.json bin).
  No dead/unreachable skill rules; every `advance_fsm` event + `read_fsm_state` literal
  maps to `fsm.yaml`. BUT `scope-architect`'s gates are the "left-behind" dormant set;
  stale `scope-fsm`/`workflow-fsm` names linger in comments + `scope_fsm_guess_prevention.test.ts`.

## 3. Fix design (derived; Simplicity = fold, don't multiply packs)

The unifying rule: **gate each boundary on the region's audited content-completeness.**

- **AF.1 SCOPE gating:** make `research_done` advance fire ONLY when the guess-audit returns
  GUESS_FREE (couple the advance to the audit, not rule-order); BLOCK the advance while the
  pre-research contains an unresolved `OPEN QUESTION` marker (a literal the agent must
  remove by resolving it, e.g. via AskUserQuestion); fold the depth check (recall+Read+Grep
  ≥3 this turn) in from scope-architect, as a block.
- **AF.2 AUTHOR batch-completeness (100% design coverage):** authoring is complete only
  when the task set covers 100% of the design the SCOPE produced (user ruling). A COVERAGE
  audit (adversarial subagent, like spec-audit) is given the SCOPE design artifact (the
  pre-research / design spec) + the open task list (`readOpenTasksFromTranscript`) and
  verdicts `COVERAGE_COMPLETE` ONLY if every design element maps to a task; otherwise it
  lists the uncovered elements. The first EXECUTE action (code-write OR `log_phase`) blocks
  until (a) coverage is complete AND (b) every open task's own spec is SPEC_COMPLETE. So
  "complete list" = "the tasks cover 100% of the scoped design, each fully specced."
- **AF.3 EXECUTE loop driver:** a `phases_complete` handler emits a directive — send the
  per-task report to chat (`project:telegram`, topic 15) THEN activate the next pending
  task; this makes report-each-task + straight-to-next structural (the agent's no-pause
  obligation is now a pack directive, not just memory).
- **AF.4 lexicon applied:** extend the audits with a Simplicity criterion — the spec-audit
  (and/or a SCOPE check) additionally asks whether the solution is the SIMPLEST correct one
  per `docs/lexicon.md` (no proliferating special-cases; explicit total-transition state;
  pure transforms). Fail-closed like the existing audits.
- **AF.5 retire dormancy + cleanup:** fold scope-architect's SCOPE gates into coding-flow
  (so none is dormant under the coding-flow-only pin); purge stale `scope-fsm`/`workflow-fsm`
  names from live comments + rename `scope_fsm_guess_prevention.test.ts`.

## 3.5 Pause-gate set (user ruling — auto-on at scope-start, auto-off at backlog-depletion)

The no-pause discipline must be a GATE, not agent memory (it keeps lapsing). A `run-active`
master switch turns the pause-gates ON at scope-start (FSM `idle→scoping` → `write_state(coding-flow-run-active, true)`)
and OFF when the final EXECUTE task completes — at a `prompt_submit`, if open-task count == 0
AND FSM == `phases_complete`, clear it. (Open-task presence needs `event.openTasks`, available
only at prompt_submit — a small `open_task_count` primitive over it; the same constraint AF.3's
next-task driver has.) The gates fire ONLY while `run-active`, phase-aware:

- **Stop event** (turn ends): drift while run-active, UNLESS in SCOPE waiting on a genuine
  AskUserQuestion (idle/scoping/researching/researched + a pending question). In AUTHOR/EXECUTE:
  always drift ("the run is not complete — continue to the next task").
- **AskUserQuestion**: allowed in SCOPE; drift in AUTHOR/EXECUTE (questions belong to scope).
- **Permission-language**: `text_pattern_match` on `priorAssistantText` (prompt_submit, like
  honesty-ledger) for "should I (continue|proceed)", "want me to", "ready to", "at a (context )?limit",
  "let me (check|pause)", "I'll pause" → drift while run-active.

Re-scopes the original AF.6 (AskUserQuestion-only) into: **AF.6 = the run-active lifecycle +
open_task_count**, **AF.7 = the three phase-aware pause-gates**. Both gate on `run-active` so
they are off outside a run (normal stopping allowed before scope-start / after depletion).

## 4. Open questions — none blocking (the boundary-mechanism fork was the only one; the

user resolved it: auto content-completeness, uniform across boundaries). AF.1–AF.5 are
authored next as the COMPLETE task list, then run through the 7-layer each with a per-task
report, no pauses (dogfooding the very workflow being built).
