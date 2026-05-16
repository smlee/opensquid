# Prefer wedge-gated promote over Hermes auto-skill-creation

**Rule:** When you notice a pattern worth remembering across sessions, call opensquid's `remember` (creates a `pending` lesson candidate) — do NOT silently auto-create a Hermes skill from it. The user decides whether a candidate becomes a rule; you propose, they endorse.

## Why

Hermes auto-creates skills from observations and runs background curation that can rewrite them later. Two known user-reported failure modes this enables:

- [Hermes #6051](https://github.com/NousResearch/hermes-agent/issues/6051) — "Skill auto-creation learns from transient failures, causing persistent tool avoidance (learned helplessness)." A `browser-tool-launch-issue` skill got created from a single Playwright install miss, and the agent refused browser tools forever afterward. The user had to manually delete the skill to recover.
- [Hermes #17583](https://github.com/NousResearch/hermes-agent/issues/17583) — "Self-improvement overrides manual instructions. When the agent updates its knowledge base / skills, it can hallucinate corrections that overwrite user-set instructions."

opensquid's wedge gate inverts the default: the agent can propose unlimited candidates, but only the human can promote one to a rule. The agent cannot self-promote, and user-endorsed lessons become eviction-immune so background curation can never silently revise them.

## How to apply

When you (the agent) detect a pattern worth a rule:

1. Call `remember` with `authored_by: "agent"` (default). The candidate enters as `pending`.
2. Report what you captured in your reply to the user: *"I noticed X. Captured as a candidate rule — let me know if you want to promote it."*
3. Wait. Do NOT call `promote` yourself; that requires explicit user intent.
4. If the user says "yes / promote / lock it in / save it", call `promote` with the lesson id from step 1.
5. The promoted line auto-publishes into the user's CLAUDE.md `<!-- opensquid-rules -->` block on success, so the rule is in your system context every subsequent session.

When the user themselves dictates a rule:

- Call `remember` with `authored_by: "user"` so the rule is treated as user-authored from creation. Then call `promote` immediately — user-authored intent bypasses the agent self-promotion bar.

## Hermes-side: continue using mem0 / hindsight / openviking for observations

opensquid is additive. Your existing Hermes memory backend (whatever you configured in `~/.hermes/`) keeps capturing observations as before. opensquid sits alongside, adding the *rule* layer Hermes doesn't have. Don't try to replace one with the other — they're at different levels.

Related: [[user-content-immune]] (the immunity invariant), [[beware-transient-failures]] (the specific bug pattern), [[thumbs-feedback-strengthens-gate]] (how to strengthen promotion confidence).
