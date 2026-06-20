# AUTHOR rubric — the spec-audit's pass criteria

The canonical, single-source rubric the coding-flow AUTHOR gate applies to a task spec. Read whole by
`read_rubric(name: author)` and (a) interpolated into the spec-audit prompt and (b) injected to the agent
before authoring. Edit HERE — both the audit and the agent reflect the change (no second copy).

A task spec passes (`VERDICT: SPEC_COMPLETE`) ONLY if ALL FIVE hold:

1. **11-FIELD CONTRACT** — EVERY "### Task" block has all 11 fields (Required skills, Deliverable, Depends on,
   Files affected, Key code shapes, Test fixtures, Acceptance criteria, Risk callouts, References,
   Verification commands, 7-phase steps); every Key-code-shapes block is REAL code (not pseudocode); every
   7-phase step names concrete files/decisions.
2. **100% SCOPE COVERAGE — no silent gaps** — the task set covers EVERY scoped element as captured in the
   pre-research (which the SCOPE gate now requires to be COMPLETE — see SCOPE rubric §4), NOT merely the
   pre-research's restatement of a slice. Every element maps to a task OR to a NAMED, TRACKED deferral (a
   referenced open issue / explicit downstream dependency). A scoped element absent with no tracked owner,
   or a prose-only "deferred to a separate track" with no referenced issue, is a SILENT GAP → INCOMPLETE.
3. **WIRED / END-TO-END RELIABILITY** — each Deliverable's Acceptance criteria must prove the artifact works
   IN ITS LIVE PATH: wired into its real caller AND integration- or live-proven — not merely that a module
   exists and unit tests pass. A component that would satisfy its acceptance while having ZERO live callers
   is built-but-dormant → INCOMPLETE, UNLESS it (a) includes the wiring + a live/integration acceptance
   criterion, or (b) names its wiring as an EXPLICIT tracked downstream task. "Module + unit tests, no path
   to live" = INCOMPLETE.
4. **TECHNICAL CORRECTNESS vs the design's SEMANTICS** — the Key code shapes + approach are verified correct
   against the design's INTENDED BEHAVIOR (cited): the spec states the intended semantics (an action's
   effect, a contract, an invariant) and shows the approach matches — no divergence, no hand-waved technical
   claim. Every Acceptance criterion rests on a cited fact (`file:line` / the design / the user's words) or a
   test — never an unstated assumption. An assumption presented as fact = INCOMPLETE.
5. **SIMPLICITY** — the design is the SIMPLEST correct solution: no proliferating special-cases (that signals
   a missed decomposition), every lifecycle an explicit total-transition FSM, every transform a pure
   function, no implicit state.
