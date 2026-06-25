# SCOPE rubric — the guess-audit's pass criteria

The canonical, single-source rubric the coding-flow SCOPE gate applies to a pre-research / scope artifact.
Read whole by `read_rubric(name: scope)` and (a) interpolated into the guess-audit prompt and (b) injected to
the agent before authoring. Edit HERE — both the audit and the agent reflect the change (no second copy).

A pre-research / scope artifact passes (`VERDICT: GUESS_FREE`) ONLY if ALL FIVE hold:

1. **NEVER-GUESS** — a claim is acceptable ONLY if DERIVED from cited evidence (a `file:line`, a memory, or
   the user's own words) OR explicitly flagged as an unresolved open question — an unchecked
   `- [ ] OPEN QUESTION: …` task-list marker — to ask the user (resolve it by checking the box `- [x]`).
2. **BEST-SOLUTION** — the artifact must show the best solution was found: alternatives weighed against the
   criteria and the SIMPLEST correct one chosen (no proliferating special-cases).
3. **FULL-FIX** — the chosen solution must be the FULL fix: when the existing shape is the cause, it is
   re-architected, NOT a local patch that bolts on a special-case to dodge the rework (that patch is itself
   the proliferating-special-case overcomplication the Full-fix-over-patch guideline forbids).
4. **FULL-SCOPE CAPTURE** — the artifact enumerates the COMPLETE scope of the change against the umbrella
   design it cites (every affected tier / element / wiring obligation), so a downstream spec can cover 100%
   of the REAL end-state — not a convenient slice. Silently narrowing to part of the cited design with no
   flagged `- [ ] OPEN QUESTION` / explicit deferral is itself an unstated assumption → fails NEVER-GUESS.
5. **ON-TOPIC / NO UNASKED ADDITION** — the MIRROR of NEVER-GUESS (§1 rejects the UNSOURCED; this rejects
   the UNASKED). Every scoped element must TRACE TO THE CAPTURED USER ASK. An element that is evidence-
   derived but NOT within the ask is an ADDITION and must be ROUTED, never silently folded in:
   - **nice-to-have** (not needed to meet the scope) → a BACKLOG entry awaiting user confirmation;
   - **complementary** (affects architecture, not the specced list) → ASK the user "is this what you want?";
   - **unrelated** (outside the ask) → reject / surface separately.
     Only an element that is 100% on-topic AND maps to a specced criterion proceeds silently. Citing evidence
     (a `file:line` / a defect) does NOT make an unasked addition on-topic — that is the exact drift this
     criterion exists to catch. The verdict is deterministic: an element traces to the ask, or it does not.
