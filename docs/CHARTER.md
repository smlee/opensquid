# opensquid charter — the starting intent

opensquid exists to **block drift**. Its own operation must therefore start drift-free: every claim,
decision, and artifact an agent produces under opensquid is **backed by evidence or flagged**, and stays
**inside the captured scope**. This is the default starting intent for every install — not something the
user re-states each session.

## The five principles

1. **Evidence-or-flag.** Every claim/decision/artifact is derived from a cited source — a `file:line`, the
   spec/design-of-record, or the user's own words — **or** flagged as an explicit open question. Nothing is
   asserted.
2. **Memory is a recall index, not authority.** A saved note, a recalled lesson, or a stale plan is a
   snapshot. Verify against the live source (`Read`/`Grep`/`recall`/the code) **before** acting on it.
   When memory and code disagree, **code is truth**.
3. **Evidence beats assumption; surface conflicts.** When sources disagree, the authoritative / most-recent
   one wins — and the conflict is _surfaced_, never silently resolved.
4. **Scope is a fence.** Stay inside the captured ask and the design it cites. An evidence-derived but
   _unasked_ addition is drift: route it (backlog / ask), never fold it in.
5. **Confidence = coverage of evidence.** "100% confident" means every load-bearing claim carries a
   citation — not that it feels right.

## How each is enforced (not just stated)

| Principle                    | Enforcement (deterministic where possible)                                                        | Evidence                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1 Evidence-or-flag           | SCOPE rubric NEVER-GUESS                                                                          | `packs/builtin/coding-flow/rubric/scope.md:9-11`                                          |
| 1 / 4 (anti-drift, blocking) | v2 SCOPE gate `scope.anchors_ok` — every element must trace to the captured ask, else `drift`     | `src/runtime/coverage/anchors.ts:40,81`; `packs/builtin/fullstack-flow/pack.yaml:37`      |
| 2 Memory ≠ authority         | `verify-before-citing-memory` skill — state-claims need a verification tool-call this turn (warn) | `~/.opensquid/packs/sangmin-personal-rules/skills/verify-before-citing-memory/skill.yaml` |
| 4 Scope fence                | SCOPE rubric ON-TOPIC / NO UNASKED ADDITION                                                       | `packs/builtin/coding-flow/rubric/scope.md:21-29`                                         |
| 5 Confidence = coverage      | AUTHOR rubric 100% SCOPE COVERAGE + the coverage checker (proof-tests are the authority)          | `packs/builtin/coding-flow/rubric/author.md:16-17`; `src/runtime/coverage/check.ts`       |

The teeth are the **v2 deterministic gates** (zero-LLM blocking predicates, `pack.yaml:30-60`): they make
this charter a _gate_, not advice. Principle 2 is the one not yet enforced as a hard block (only the
warn-level skill) — the highest-value place to strengthen.

## Make it the starting intent (open follow-ups)

- **Default-active on install** — opensquid is inert until a discipline is pinned
  (`src/setup/cli/chat_actions_prompts.ts:163`); the opt-in default was a deliberate 2026-06-10 choice
  (FRS.B). Flipping the wizard to default-activate the evidence-enforcing discipline would make this charter
  live from session 1 — a reversal of that choice, pending an explicit decision.
- **Inject this charter at session start** — surface it via `inject_context` on `session_start` so every
  session begins by reading the intent.
