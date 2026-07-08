# CODE rubric — the guess-free CODE audit's pass criteria (v2 fullstack-flow)

Canonical single-source rubric, read whole by `read_rubric(name: code)`, interpolated into the CODE
content-audit prompt AND injected to the agent. Edit HERE only. Authored fresh for v2 (v1 `coding-flow` had no
CODE rubric — net-new), grounded in the design's CODE·before / CODE·after research types
(`docs/design/opensquid-v2-coding-flow-design.md` §4.2) + the user's two-point model (2026-06-28).

CODE has two halves (BEFORE + AFTER) plus the architecture criteria (§C, mirroring SCOPE on the diff); ALL must
hold for `VERDICT: GUESS_FREE`.

## A. BEFORE coding (pre_research / learn) — verify + expand + align

1. **VERIFY THE TASK** — every claim in the task spec is re-confirmed against current reality (`file:line` /
   the live API), not taken on faith. A task claim contradicted by the code is surfaced, not coded around.
2. **EXPAND** — the task is expanded to the concrete implementation detail (affected files, existing defs to
   reuse, current non-deprecated syntax) — the LOCAL readiness surfacers.
3. **ALIGN TO SCOPE** — the work confirmed to match the scoped element it implements; no silent widening.
4. **READ THE DOCS (external)** — for any external API/library/version the task touches, the official primary
   docs are consulted (recorded as a `WebSearch`/`WebFetch`/intranet call) so it is built right the first time.
   (Existing-solution discovery is NOT here — that was decided at AUTHOR/tasking.)

## B. AFTER coding (audit) — another layer (user: "another run for audit")

5. **ALIGNMENT** — the written code matches the goal/scope (re-checked against the captured ask + scoped element).
6. **PROPER USE OF DOCUMENTATION** — the APIs/libraries are used per their official docs (no deprecated calls,
   no misused signatures) — verified against the primary source, not assumed.
7. **EXISTING-SOLUTION DOUBLE-CHECK** — a final check that no existing solution was reinvented (the AUTHOR
   search re-confirmed against what was actually built).
8. **FULL-FIX — NO MVP** — the shipped code is the full fix, not a band-aid/special-case that dodges the real
   rework, AND it implements the FULL scoped design — not a reduced / MVP / phase-1 subset. A design element
   left unimplemented with no tracked, named deferral = INCOMPLETE (treated like a failing test, not "done").
9. **EXTERNAL REQUIRED** — the audit reached the external rung (recorded consultation); local-only cannot audit
   "what did I miss / is this the best / does this match the docs." 100% confidence is unreachable from local.
   Exempt only a genuinely external-dependency-free change (diff-derived, not agent-asserted).

## C. ARCHITECTURE (the diff introduces no architecture defect — mirrors SCOPE §7–10, enforced on the CHANGE)

11. **MODULARITY** — the change stays behind its seam with a stated contract; it does not reach into another
    module's internals or thread one responsibility across unrelated files. A diff that ripples a volatile
    detail (I/O, a vendor, a schema) across modules is a modularity defect → fails (keep it behind the seam,
    or state why one boundary genuinely owns both).
12. **SCALABILITY** — the change adds no unbounded buffer, no per-item full scan on a growing set, no hot path
    whose work grows with total history. A new O(N)-per-tick scan of an ever-growing set, or an unbounded
    queue, is a scalability defect → fails (bound it, or cite why N is fixed).
13. **SINGLE-SOURCE-OF-TRUTH** — the change adds no second store of a datum an existing store (the DB) already
    owns; a new flat file / table duplicating DB-owned data is a redundancy defect → fails (use a projection /
    derived read, not a second store). One writer per datum; every other reader derives.
14. **PUSH-vs-PULL** — the change adds no poll/pull loop reconstructing state a producing boundary could have
    PUSHED (an event / hook / write-through). A poll where the producer already knows the moment of change is a
    push-vs-pull defect → fails (push from the known boundary, or cite why the producer cannot signal).

## D. Rolling re-audit

10. **RE-AUDIT AUTHOR** — the TASK spec this code implements still holds `GUESS_FREE` at CODE time
    (re-evaluated). A task that drifted since its gate fails here, catching it at this boundary.

Verdict is deterministic per criterion (verified-or-not, aligned-or-not, external-reached-or-not,
prior-verdict-holds-or-not). The QUALITY of a source / the elegance of the fix is advisory, not a hard fail.
