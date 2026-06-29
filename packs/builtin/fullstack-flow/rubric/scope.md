# SCOPE rubric — the guess-free SCOPE audit's pass criteria (v2 fullstack-flow)

Canonical single-source rubric, read whole by `read_rubric(name: scope)`, interpolated into the SCOPE
content-audit prompt AND injected to the agent before scoping. Edit HERE only — no second copy.
Authored fresh for v2 (not a v1 restore); criteria reference the proven v1 standard
(`coding-flow/rubric/scope.md`) and add the source-ladder external requirement
(`docs/design/opensquid-v2-coding-flow-design.md` §4.1).

A pre-research / scope artifact passes (`VERDICT: GUESS_FREE`) ONLY if ALL SIX hold:

1. **NEVER-GUESS** — every claim is DERIVED from cited evidence (`file:line`, a memory, or the user's own
   words) OR flagged as an unchecked `- [ ] OPEN QUESTION: …` for the user. No claim presented as fact without
   a citation.
   - **VALID OPEN QUESTION (the ONLY sanctioned pause, and ONLY in scope, user 2026-06-28):** a question is
     permitted ONLY if its answer genuinely CANNOT be found after thorough research (criterion §6's source-ladder
     fully climbed, local → external/primary) OR it is significant enough to CHANGE THE ARCHITECTURE (a genuine
     design fork the user must decide). The thorough scope-phase research is what earns the right to ask.
   - **NOT a valid question (drift — HARD-BLOCKED in EVERY phase, scope included):**
     (a) a question whose answer is findable by research (ask the research, not the user);
     (b) a CONFIRMATION / permission / DIRECTION-SEEKING question — "should I continue / proceed", "how should
         I proceed", "how do you want to proceed", "want me to", "ready to", "shall I", or ANYTHING SUGGESTIVE
         (any phrasing that fishes for the user to direct / choose / confirm instead of the agent deciding);
     (c) an OPTION / CHOICE question ("do you want A or B?") where principles + research settle the pick — the
         agent DECIDES it (the router's `DECIDE`: Simplicity / Best-Solution choose), it does NOT offload the
         pick to the user.
     A choice escalates ONLY when it is a genuine ARCHITECTURE-CHANGING fork that research + principles
     genuinely CANNOT settle. Otherwise: proceed, never pause.
   - **THESE BANNED QUESTIONS ARE DRIFT QUALIFIERS (user, 2026-06-28):** reaching for one is itself EVIDENCE
     drift is already underway — the symptom of an incomplete scope / a settleable decision being offloaded. So
     detecting a banned question does TWO things: (1) hard-block the action, AND (2) RECORD a drift event
     (`drift_catalog` / `appendProjectDriftEvent`) that feeds the anti-drift response + the rolling re-audit —
     never a silent block. The detector IS a drift signal, not just a gate.
2. **BEST-SOLUTION** — alternatives are weighed against the criteria and the SIMPLEST correct one chosen (no
   proliferating special-cases). A "best solution" claim is unprovable from local alone (§6) — it requires the
   external check below.
3. **FULL-FIX** — the chosen solution is the FULL fix: when the existing shape is the cause it is
   re-architected, never a local patch that bolts a special-case on to dodge the rework.
4. **FULL-SCOPE CAPTURE — NO MVP** — the artifact enumerates the COMPLETE scope against the umbrella design it
   cites (every affected tier / element / wiring obligation) so a downstream plan can cover 100% of the real
   end-state. Silently narrowing to a convenient slice with no flagged `- [ ] OPEN QUESTION` fails NEVER-GUESS.
   An **MVP / phase-1 / "simplest-that-passes" reduction of a fully-specified design IS such a silent
   narrowing** — the deliverable is the full end-state, not a convenient subset. Scoping to less than the cited
   design (without a tracked, named deferral) fails here.
5. **ON-TOPIC / NO UNASKED ADDITION** — every scoped element TRACES TO THE CAPTURED USER ASK. An
   evidence-derived element outside the ask is an ADDITION → route it (backlog / ask / reject), never fold it
   in silently. Citing a `file:line` does NOT make an unasked element on-topic.
6. **SOURCE-LADDER / EXTERNAL EVIDENCE (NEW)** — research climbs local-first (user's words → memory → prior
   research → local code) and, when local cannot answer, REACHES the external rung: the tool's OWN primary
   docs/repo (not blogs), recorded as a `WebSearch`/`WebFetch`/intranet consultation. "Best-solution" (§2) and
   "no existing solution" claims are NOT guess-free without it — 100% confidence/coverage is unreachable from
   local alone. Exempt only a genuinely external-dependency-free scope (diff-derived, not agent-asserted).

The verdict is deterministic per criterion: an element traces-or-doesn't, a claim is cited-or-not, the external
rung was reached-or-not. Quality of a chosen source (primary vs secondary) is advisory, not a hard fail.
