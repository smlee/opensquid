# AUTHOR rubric — the spec-audit's pass criteria

The canonical, single-source rubric the coding-flow AUTHOR gate applies to a task spec. Read whole by
`read_rubric(name: author)` and (a) interpolated into the spec-audit prompt and (b) injected to the agent
before authoring. Edit HERE — both the audit and the agent reflect the change (no second copy).

A task spec passes (`VERDICT: SPEC_COMPLETE`) ONLY if all three hold:

1. **11-FIELD CONTRACT** — EVERY "### Task" block has all 11 fields (Required skills, Deliverable, Depends on,
   Files affected, Key code shapes, Test fixtures, Acceptance criteria, Risk callouts, References,
   Verification commands, 7-phase steps); every Key-code-shapes block is REAL code (not pseudocode); every
   7-phase step names concrete files/decisions.
2. **100% DESIGN COVERAGE** — the task set covers EVERY element of the SCOPE design — no design item is left
   without a task.
3. **SIMPLICITY** — the design is the SIMPLEST correct solution: no proliferating special-cases (that signals
   a missed decomposition), every lifecycle an explicit total-transition FSM, every transform a pure
   function, no implicit state.
