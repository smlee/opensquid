# User-authored content is eviction-immune — never auto-rewrite

**Rule:** Before modifying, supersing, or deleting any opensquid lesson or memory that the user authored or endorsed, STOP. opensquid enforces this invariant at the engine level — `forget`, `supersede`, `eliminate`, and background curation all refuse user-authored content unless `force: true` is explicitly passed. Do NOT pass `force: true` without explicit user permission.

## Why

[Hermes #17583](https://github.com/NousResearch/hermes-agent/issues/17583), verbatim from a Hermes user: *"There is no distinction between 'user authored this, do not touch it' and 'agent generated this, fair game to refine.' Self-improvement overrides manual instructions — when the agent updates its knowledge base / skills, it can hallucinate corrections that overwrite user-set instructions."*

This is the exact failure mode opensquid's authorship invariant prevents. The engine tracks `authored_by: "user" | "agent" | "pack"` on every lesson. User-authored lessons:

- Cannot be evicted by `forget` without `force: true`
- Cannot be superseded by `supersede` without `force: true`
- Cannot be discarded by `eliminate` without `force: true`
- Are protected from compression / pruning / consolidation
- Have their cited memories inherit immunity (Phase G D-G1)

Pack-authored lessons (codex install) confer the same immunity — installing a codex is itself an act of user authorship.

## How to apply

When you (the agent) want to retire or revise a rule:

1. Check the `authored_by` field. If it's `user` or `pack`, **do not call mutations on it.** Surface the proposal to the user: *"I think rule X may be outdated because Y. Want me to discard it, or supersede with this new version?"*
2. Only after the user explicitly says "yes, retire it" / "yes, replace it" should you call the mutation. Pass `force: true` to bypass the immunity guard at that point — the user-explicit-intent is what `force` exists for.
3. If the rule is `authored_by: "agent"` (a candidate or auto-graduated lesson), normal mutation rules apply — you can `eliminate` or `supersede` without `force`.

When Hermes' background curation fires:

- Background curation only operates on Hermes-side skills and Hermes-side memory. opensquid lessons live in opensquid's storage and Hermes can't touch them directly. But the principle generalizes: anything the user wrote is sacred. If your code is making a destructive call on user content without explicit user intent, that's the bug.

Related: [[prefer-wedge-over-auto-skill]] (avoid the upstream pattern), [[memory-not-rule]] (immunity scope), [[beware-transient-failures]] (don't create immune-by-mistake rules).
