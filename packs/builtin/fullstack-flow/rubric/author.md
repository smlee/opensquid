# AUTHOR (TASKING) rubric — the guess-free TASK audit's pass criteria (v2 fullstack-flow)

Canonical single-source rubric, read whole by `read_rubric(name: author)`, interpolated into the AUTHOR
content-audit prompt AND injected to the agent before authoring. Edit HERE only. Authored fresh for v2;
criteria reference the proven v1 standard (`coding-flow/rubric/author.md`) and add EXISTING-SOLUTION search
(user 2026-06-28: existing-solutions belong AT tasking — reuse shortens coding) + the rolling re-audit.

A task spec passes (`VERDICT: GUESS_FREE` / `SPEC_COMPLETE`) ONLY if ALL EIGHT hold (the original six PLUS the
two architecture criteria 7–8 — SSOT + MODULARITY, so a spec that bakes in a redundant store or cross-module
coupling STILL fails):

1. **11-FIELD CONTRACT** — every `### Task` block has all 11 fields; every Key-code-shapes block is REAL code
   (not pseudocode); every 7-phase step names concrete files/decisions.
2. **100% SPEC COMPLETENESS — no silent gaps, no drift** — the task set covers EVERY scoped element OR a NAMED,
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
7. **SINGLE-SOURCE-OF-TRUTH** — the spec introduces no second store of a datum an existing store (the DB)
   already owns; every derived read is a projection, not a duplicate store that can diverge. A task that bakes
   in a redundant flat file / table for data the DB already owns is a redundancy defect → fails (spec the
   projection / derived read, or cite why one writer genuinely owns both).
8. **MODULARITY** — each concern the spec introduces lives behind ONE seam with a stated contract; the spec
   does not thread one responsibility across unrelated modules or reach around a seam into another module's
   internals. A spec that bakes in cross-module coupling for a volatile detail (I/O, a vendor, a schema) is a
   modularity defect → fails (name the seam and its contract, or state why one boundary genuinely owns both).
9. **RE-AUDIT PLAN (ROLLING)** — the PLAN this spec authors against still holds `GUESS_FREE` at AUTHOR time
   (re-evaluated). A plan that drifted since its gate fails here.

(Eight mandatory + the rolling re-audit; deterministic per criterion.)
