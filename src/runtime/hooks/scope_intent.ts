/**
 * `SCOPE_INTENT_REGEX` (T-ASC, ASC.1).
 *
 * Single-source regex for detecting scope-authoring intent in a
 * UserPromptSubmit prompt. Used by:
 *   - ASC.1 UserPromptSubmit chain-state writer — transitions the chain
 *     from 'idle' to 'scoping' when the prompt matches.
 *   - ASC.4 audit step asserting the personal-pack `scope-intent-nudge`
 *     rule's patterns (verified via `scope-decomposer/skill.yaml:28-50`)
 *     are a SUBSET of this regex's matches.
 *
 * SUPERSET-of-pack-patterns by design (T-ASC ASC.1 spec, lock L4 sibling):
 *   - false positives are acceptable here (an extra 'scoping' transition
 *     that the agent doesn't act on; the chain self-corrects on the next
 *     real research/spec write);
 *   - false negatives are NOT acceptable (a missed scope-authoring intent
 *     would leave the chain stuck at 'idle' so subsequent stage-gated
 *     handoff rules never fire).
 *
 * The pack's `scope-intent-nudge` patterns are stricter (each anchors on
 * a direction object — `\bspec\s+(?:out|this|the)\b`, etc.) for the
 * narrower job of triggering a nudge verdict. This regex is broader so
 * the chain transitions reliably even when the user's phrasing differs
 * slightly from the pack's anchors. As long as the pack patterns are a
 * subset of this regex (verified by scope_intent.test.ts), the chain
 * transition is guaranteed to fire whenever the nudge does.
 *
 * Word-boundary anchored so `specifically`, `prescriptive`, etc. do not
 * false-positive on `spec` / `prescribe`. Case-insensitive.
 */
export const SCOPE_INTENT_REGEX =
  /\b(spec(?:c?ing|ced)?|scope|new\s+(?:task|track)|add\s+(?:a\s+|another\s+)?(?:task|track)|design|plan)\b/i;
