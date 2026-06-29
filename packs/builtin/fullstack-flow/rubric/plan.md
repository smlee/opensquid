# PLAN rubric — the guess-free PLAN audit's pass criteria (v2 fullstack-flow)

Canonical single-source rubric, read whole by `read_rubric(name: plan)`, interpolated into the PLAN
content-audit prompt AND injected to the agent before planning. Edit HERE only. Authored fresh for v2 (v1
`coding-flow` had no PLAN rubric — this is net-new, grounded in the design's PLAN stage
`docs/design/opensquid-v2-coding-flow-design.md` §3.2 + the user's guess-free-at-every-stage principle).

A work-graph / decomposition passes (`VERDICT: GUESS_FREE`) ONLY if ALL FIVE hold:

1. **COMPLETE COVERAGE** — every element of the guess-free SCOPE maps to ≥1 task/issue OR a NAMED, TRACKED
   deferral (a referenced open issue). A scoped element absent with no tracked owner is a SILENT GAP → fails.
2. **ACYCLIC** — the `blocks` + `parent-child` dependency edges form no cycle (Kahn-checkable). A cyclic plan
   cannot be executed in order → fails.
3. **NO-GUESS DEPENDENCIES** — every dependency edge is DERIVED (the depended-on task genuinely produces what
   the dependent needs), not asserted. An edge with no cited reason is a guess → fails NEVER-GUESS.
4. **ON-TOPIC** — every task traces to the captured user ask (not merely to the pre-research). A task covering
   a scope element that does not itself trace to the ask is propagated drift → fails.
5. **RE-AUDIT SCOPE (ROLLING)** — the SCOPE artifact this plan decomposes still holds `GUESS_FREE` at PLAN
   time (re-evaluated, not a stale cache). If the scope drifted since its gate, PLAN fails here — catching the
   drift at this boundary rather than at the end (the user's "audit the previous run on the next run").

Verdict is deterministic per criterion (covered-or-not, acyclic-or-not, edge-cited-or-not, traces-or-not,
prior-verdict-holds-or-not).
