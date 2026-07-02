# AUTHOR — author the task spec(s): 11 fields, real code, full spec

You are in the AUTHOR (tasking) stage. Turn the plan into self-contained task specs a fresh lap can execute.

## Research (AUTHOR-specific)
- FAN OUT parallel subagents with the appropriate skills: existing-solution scouts (one per capability —
  local-codebase + external/primary-docs library experts) searching for reuse, plus one re-auditing the PLAN.
  They burn their context searching; you keep the cited reuse-or-reinvent verdict.
- EXISTING-SOLUTION SEARCH (reuse belongs HERE — reuse shortens coding): for any NEW capability, search the
  local codebase + the external/primary docs (record the consultation) and either reuse what exists or cite
  why none fits. Speccing a reinvention with no recorded search is a guess about novelty.
- RE-AUDIT the PLAN: confirm it still holds guess-free at author time; if it drifted, fix it first.

## Do
- Every `### Task` block carries all 11 fields; every Key-code-shapes block is REAL code (no pseudocode);
  every 7-phase step names concrete files/decisions.
- Cover 100% of the scope (or a named, tracked deferral). Each Deliverable's acceptance proves the artifact
  works IN ITS LIVE PATH (wired into its real caller) — a built-but-dormant component needs a tracked wiring
  task, else it is INCOMPLETE. Simplest correct design; no MVP/reduced subset of the scoped design.

## Gate to advance (author → code): `author_ready`
Passes when `author.manifest_complete` (no gated export lacks a covering requirement) ∧ `author.real_code`
(every requirement MET — a reachable/binding one requires its proof-test to pass; a stub with no passing proof
fails). Satisfy both and the gate advances you.
