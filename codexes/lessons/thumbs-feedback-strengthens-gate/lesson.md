# Use capture_feedback when the user reacts to a lesson's effect

**Rule:** When the user explicitly reacts to a lesson's behavior — saying "that was wrong" / "perfect, do that again" / "stop doing that" — call opensquid's `capture_feedback` to record the thumbs_up or thumbs_down against the relevant lesson id. This feeds the wedge gate's external signal-diversity input, which strengthens future promotion decisions on related candidates.

## Why

opensquid's wedge gate is an external-evidence check: a candidate lesson can't promote without multiple distinct signal sources (`external_signal_sources` field). Without active feedback, the gate is conservative — most candidates stay pending forever. With feedback, the gate has real-world signal to evaluate against and can make confident promotion decisions.

This addresses the cold-start problem that limits Hermes-side memory hygiene per [#20595](https://github.com/NousResearch/hermes-agent/issues/20595) and [#25061](https://github.com/NousResearch/hermes-agent/issues/25061) — *"Memory hygiene checks are advisory-only — bloat recurs under completion bias"* and *"pre-turn memory health hook ... standing rules in the system prompt that require proactive LLM behavior are consistently ignored."*

The wedge gate is a system-level invariant (engine-enforced), not prompt-compliance. But it needs evidence to operate on. `capture_feedback` provides the evidence.

## How to apply

When the user explicitly reacts to your behavior on a recall:

1. Identify the lesson id you were acting on. (If you called `manifest` or `recall` to retrieve it, the id is in the response — `les-xxxxxxxx`.)
2. Call `capture_feedback` with the lesson id, the polarity (`thumbs_up` or `thumbs_down`), and an optional `source_signal_id` (lets the engine dedup repeat signals from the same source).
3. Do NOT call `promote` based on a single thumbs-up — the gate evaluates accumulated signal diversity. Trust the engine to decide when the candidate is ready.
4. Do NOT call `eliminate` based on a single thumbs-down — that's the wrong response. The lesson is user-authored if they endorsed it; surface the feedback to them and ask: *"You disagreed with the rule X — want me to discard it or supersede with a refined version?"*

When you (the agent) act on a memory or lesson and the user moves on without comment:

- Don't infer thumbs-up from silence. Silence means "fine, keep going" — not "yes, that was the right call." Capture feedback only when the user is explicit.

When the user proactively says "do X from now on" or "stop doing Y":

- That's not feedback on an existing lesson — that's authorship of a NEW rule. Call `remember` (with `authored_by: "user"`), then `promote` on user OK. Separately, if their statement contradicts an existing promoted lesson, call `capture_feedback` with thumbs_down on the old one + surface the conflict.

Related: [[prefer-wedge-over-auto-skill]] (don't bypass the gate), [[user-content-immune]] (feedback evidences; doesn't override user authorship), [[memory-not-rule]] (feedback on memories isn't the same as feedback on lessons — memories don't go through the gate).
