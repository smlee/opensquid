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
2. **BEST-SOLUTION** — alternatives are weighed against the criteria and the SIMPLEST correct one chosen (no
   proliferating special-cases). A "best solution" claim is unprovable from local alone (§6) — it requires the
   external check below.
3. **FULL-FIX** — the chosen solution is the FULL fix: when the existing shape is the cause it is
   re-architected, never a local patch that bolts a special-case on to dodge the rework.
4. **FULL-SCOPE CAPTURE** — the artifact enumerates the COMPLETE scope against the umbrella design it cites
   (every affected tier / element / wiring obligation) so a downstream plan can cover 100% of the real
   end-state. Silently narrowing to a convenient slice with no flagged `- [ ] OPEN QUESTION` fails NEVER-GUESS.
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
