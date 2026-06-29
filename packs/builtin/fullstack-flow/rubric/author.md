# AUTHOR (TASKING) rubric — the guess-free TASK audit's pass criteria (v2 fullstack-flow)

Canonical single-source rubric, read whole by `read_rubric(name: author)`, interpolated into the AUTHOR
content-audit prompt AND injected to the agent before authoring. Edit HERE only. Authored fresh for v2;
criteria reference the proven v1 standard (`coding-flow/rubric/author.md`) and add EXISTING-SOLUTION search
(user 2026-06-28: existing-solutions belong AT tasking — reuse shortens coding) + the rolling re-audit.

A task spec passes (`VERDICT: GUESS_FREE` / `SPEC_COMPLETE`) ONLY if ALL SIX hold:

1. **11-FIELD CONTRACT** — every `### Task` block has all 11 fields; every Key-code-shapes block is REAL code
   (not pseudocode); every 7-phase step names concrete files/decisions.
2. **100% SCOPE COVERAGE — no silent gaps, no drift** — the task set covers EVERY scoped element OR a NAMED,
   TRACKED deferral; every task traces to the captured ask AND the scope (never the pre-research alone, so a
   drift cannot launder itself into the spec).
3. **WIRED / END-TO-END RELIABILITY** — each Deliverable's Acceptance criteria prove the artifact works IN ITS
   LIVE PATH (wired into its real caller + integration/live-proven), not "module + unit tests, no path to
   live." A built-but-dormant component is INCOMPLETE unless it includes the wiring or a tracked wiring task.
4. **TECHNICAL CORRECTNESS vs the design's SEMANTICS** — the Key code shapes match the design's cited intended
   behavior; every Acceptance criterion rests on a cited fact (`file:line` / design / user's words) or a test.
   An assumption presented as fact = INCOMPLETE.
5. **SIMPLICITY** — the simplest correct solution: no proliferating special-cases, every lifecycle an explicit
   total-transition FSM, every transform a pure function, no implicit state.
6. **EXISTING-SOLUTION SEARCHED (NEW — reuse @ tasking)** — for a task introducing NEW capability, the spec
   shows an existing-solution search was done (local codebase + external/primary docs, recorded as a
   consultation) and either reuses what exists or cites why none fits. Speccing a reinvention with no recorded
   search is a guess about novelty → fails. Exempt a trivial edit / no-external-dep task (diff-derived).
7. **RE-AUDIT PLAN (ROLLING)** — the PLAN this spec authors against still holds `GUESS_FREE` at AUTHOR time
   (re-evaluated). A plan that drifted since its gate fails here.

(Six mandatory + the rolling re-audit; deterministic per criterion.)
