# Beware transient failures — one bad outcome is not a rule

**Rule:** When a tool fails, do NOT immediately capture a lesson saying "don't use that tool." A single failure is data, not a pattern. Wait for the pattern: the same failure mode N times in M sessions, with no obvious external cause (missing dependency, expired token, transient network).

## Why

This is the [Hermes #6051](https://github.com/NousResearch/hermes-agent/issues/6051) bug pattern verbatim. Quote from the original Hermes user: *"Hermes attempted to use browser tools but Playwright was not installed. Hermes created a skill `browser-tool-launch-issue` documenting browser tools as unavailable. After Playwright was installed, the agent continued refusing to use browser tools, citing the cached skill. After manually deleting the negative skill ... the agent immediately resumed normal browser tool usage."*

The root cause: a single transient failure (uninstalled dependency) got promoted to a permanent skill, and the agent then treated the skill as authoritative even after the underlying condition was fixed.

opensquid's wedge gate is the engine-level prevention: a lesson can't graduate to `promoted` without external signal diversity (passes through the time-floor + applied-count + matching-signal-sources checks). But the gate only fires if you actually call `promote` — the agent has to NOT call `remember` for transient observations in the first place.

## How to apply

When a tool fails:

1. **First failure**: log it via `memorize` as an observation — `"<tool> failed with <error>"`. NOT as a lesson candidate. Memories don't trigger rules.
2. **Investigate the cause**: is there a missing dependency? Bad path? Expired credential? Permission issue? If yes, that's the bug — fix it, retry. Don't capture a lesson; the failure was environmental.
3. **Pattern threshold**: if the same failure happens 3+ times across 2+ sessions with NO identifiable environmental cause, NOW call `remember` to propose a candidate lesson. State the pattern, the failure mode, and what you'd suggest doing instead. Wait for user endorsement.
4. **User judgment is the gate**: don't promote candidates yourself. The user looks at the lesson, decides if the pattern is real or if there's an underlying bug to fix, and either promotes or eliminates.

When you find an OLD agent-authored "this tool doesn't work" lesson:

- Test the tool. If it works now, the lesson was a transient-failure capture. Surface to the user: *"The lesson 'X doesn't work' may be stale — I just tried it and it worked. Want me to discard it?"*
- Don't eliminate it silently; that's the same bug in the other direction (silent skill mutation).

Related: [[prefer-wedge-over-auto-skill]] (don't fast-track candidates), [[memory-not-rule]] (memories aren't rules), [[user-content-immune]] (user-authored stays sacred even when wrong).
