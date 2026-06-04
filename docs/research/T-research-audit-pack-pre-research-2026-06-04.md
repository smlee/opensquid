# Pre-research — RESEARCH/AUDIT flow (slash command + workflow + lexicon) (2026-06-04)

Prompted by: "do we have the lexicon and principles for the research flow?" → finding: the
lexicon exists but the research-flow principles are enforced-but-unlabeled (scattered in the
guess-audit prompt + feedback memories). → "create a research/audit pack… perhaps a slash
command to trigger a specific workflow."

## §1 — The gap (verified)

`docs/lexicon.md` has labeled DESIGN/coding principles (Simplicity, no-implicit-state,
determinism boundary, FSM=containment) but NO labeled research-flow principles. The
research principles ARE enforced — the coding-flow guess-audit prompt hardcodes NEVER-GUESS

- BEST-SOLUTION + teach-back depth (`packs/builtin/coding-flow/skills/scope-lifecycle/
skill.yaml:55-101`) — and the rest live as the user's feedback memories (no-skim,
  synthesis-step, no-questions-after-scope). The guess-audit even says "choose the simplest
  correct **per the lexicon**" — it points at the lexicon for coding principles, but the
  RESEARCH principles it enforces have no lexicon home. Asymmetry: research is the only stage
  of SCOPE→AUTHOR→CODE whose governing principles aren't labeled, despite the north star
  "research depth = the leverage" (`loop/docs/opensquid-memory-communication-architecture.md`
  §0).

## §2 — Thesis

Auditing is a DISTINCT behavior pattern from building (coding-flow = SCOPE→AUTHOR→CODE).
Audit = gather → verify → refute → synthesize, no building — the VERIFY faculty of the
perfect-teammate loop (project + understand + **verify** + consolidate). It is exactly the
adversarial-audit done by hand twice on 2026-06-04 (the 4-agent coding-flow audit; the
memory probe). Formalize it as a user-invocable flow.

## §3 — Design decisions (user-accepted defaults + the slash/workflow trigger)

1. **Trigger = a slash command → a workflow.** A `/research-audit <target>` skill
   (`~/.claude/skills/research-audit/SKILL.md`) instructs the agent to run a fan-out
   adversarial-audit WORKFLOW (the Workflow tool — the audit is inherently multi-agent, the
   tool's native domain; a skill instructing a Workflow call is a sanctioned opt-in path).
2. **Audit against ALL THREE criteria:** design-coverage (as-built vs the design/spec) +
   principle-adherence (vs `docs/lexicon.md`) + test/correctness (vs the tests + real
   behavior). That triad is what makes it a real audit.
3. **Subagent FAN-OUT baked in:** independent refutation is the point — adversarial-verify
   uses N skeptics per finding, majority-survives.
4. **Output = delivered findings + OFFER the handoff** (do not auto-spawn a fix track; the
   user decides per-audit). Confirmed findings → a coding-flow fix track when accepted.
5. **The research principles get a HOME:** a labeled "Research / Audit flow" section in
   `docs/lexicon.md`, which both the new skill AND the existing guess-audit reference (so
   nothing is hardcoded-only). This is the thread-B fix.

## §4 — The workflow shape (the slash command runs this)

Phases mirror the research principles as gates:

| Phase           | Agents                                                                                                           | Principle enforced                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **gather**      | parallel readers, one per subsystem/dimension of the target                                                      | no-skim / breadth — read end-to-end, map the surface |
| **verify**      | one per criterion (design-coverage, principle-adherence, test/correctness), each emits findings with `file:line` | never-guess — every finding cited                    |
| **adversarial** | N skeptics per finding, prompted to REFUTE; keep only majority-survivors                                         | adversarial-verify — confirmed ≠ self-graded         |
| **synthesize**  | one synthesizer → integrated, severity-ranked, deduped findings                                                  | synthesis-step — integrated whole, not a list dump   |

Pipeline (not barrier) where possible: a dimension's findings verify as soon as its review
lands. Output: a findings report (severity + evidence + verdict), then "spawn a coding-flow
fix track? (y)".

## §5 — Scope of THIS slice (RA.1)

- `~/.claude/skills/research-audit/SKILL.md` — the slash command (instructs the workflow).
- `docs/lexicon.md` — the labeled "Research / Audit flow" principles section.
- This pre-research (the scope artifact).

DEFERRED (noted, not built now): an opensquid `research-audit` PACK (FSM + guards) that
GATES the audit the way coding-flow gates building — the governance layer. The
slash-command + workflow is usable immediately; the pack-FSM is the heavier follow-on if we
want the audit itself gated/enforced rather than skill-instructed.

## §6 — Risks / invariants

- The skill must be model-neutral + harness-aware (it lives in `~/.claude/skills`, not a git
  repo — personal config; the lexicon change is the committed opensquid artifact).
- The workflow must scale to the target: a few finders for a small target, larger fan-out +
  3–5-vote adversarial pass for "thorough" — and `log()` any coverage cap (no silent
  truncation).
- Findings must be `file:line`-cited (never-guess) and adversarially survived before
  "confirmed" — the skill must not present unverified findings as confirmed.
- The lexicon section is referenced by the guess-audit too (re-point it), so the principles
  have ONE canonical home.
