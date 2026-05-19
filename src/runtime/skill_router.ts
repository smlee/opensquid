/**
 * Model-aliased skill router (Phase 3 Task 3.4).
 *
 * Purpose: take the embedder-shortlisted candidate skills (output of
 * `prefilterSkills`) and ask a fast classifier LLM which subset is
 * actually needed for the current task. Returns the filtered skill
 * list. This is the second tier of the two-tier dynamic-load pipeline
 * — the embedder is high-recall / low-precision; the classifier is
 * the precision step.
 *
 * Model neutrality (per `feedback_stop_haiku_drift` +
 * `project_opensquid_model_neutral_subagent_primitive`): we route via
 * the `fast_classifier` ALIAS, never a vendor model name. The user's
 * `models.yaml` maps the alias to whichever subscription CLI or API
 * binding they prefer. No model id ever appears in this file.
 *
 * Prompt shape — a tight classification prompt with three rules:
 *   1. Task subject up front (top-of-context bias).
 *   2. Skills listed with `name: prose` so the classifier sees what
 *      each skill is FOR, not just the bare ids.
 *   3. Output instruction is comma-separated names OR the `NONE` token.
 *      `llm_classify` itself clamps unknown outputs to `UNCERTAIN`, so
 *      we treat both `UNCERTAIN` and `NONE` as the safety fallback.
 *
 * Failure ladder ("fail safe-ward" — toward more skills, never fewer):
 *   - classifier errors / not-ok      → return ALL candidates
 *   - classifier returns UNCERTAIN    → return ALL candidates
 *   - classifier returns NONE         → return ALL candidates
 *   - classifier returns "a, b, c"    → return matching candidates
 *
 * The NONE/UNCERTAIN cases biasing toward "load everything" matches
 * the prefilter's fail-open contract: this layer is an optimization,
 * never a gate. A drifting classifier should never lock the agent out
 * of a needed skill. The cost of a false-positive (loading a skill
 * we didn't strictly need) is context dilution; the cost of a
 * false-negative (omitting a needed skill) is a missed verification
 * pass. Phase 3 picks the former.
 *
 * Imports from: ../functions/registry.js (FunctionRegistry + EvalCtx),
 *   ./types.js (Skill).
 * Imported by: src/runtime/index.ts (re-exported as `routeSkills`)
 *   and the dispatcher pipeline once Phase 3 wiring lands.
 */

import type { EvalCtx, FunctionRegistry } from '../functions/registry.js';

import type { Skill } from './types.js';

/**
 * Ask the `fast_classifier`-aliased LLM which of `candidates` are
 * needed for `taskSubject`. Returns a filtered subset of `candidates`,
 * or — under any fallback condition — the full `candidates` list.
 *
 * `registry` must have `llm_classify` registered (the LLM primitive
 * from `src/functions/llm.ts`). `ctx` is forwarded verbatim; the
 * primitive uses only its model dispatcher, not the bindings or event,
 * so any well-formed `EvalCtx` works.
 */
export async function routeSkills(
  taskSubject: string,
  candidates: Skill[],
  registry: FunctionRegistry,
  ctx: EvalCtx,
): Promise<Skill[]> {
  if (candidates.length === 0) return [];

  // Allowed labels = the candidate names plus NONE. `llm_classify`
  // already injects UNCERTAIN as the clamp value for unmatched output,
  // so we don't list it in allowed_labels (the underlying primitive
  // returns 'UNCERTAIN' literally when nothing matches).
  const labels = [...candidates.map((s) => s.name), 'NONE'];

  // Prompt shape: subject first, candidate list with `name: prose`,
  // strict output instruction at the bottom. `prose ?? name` mirrors
  // the prefilter's weak-fallback path so descriptions stay consistent
  // across the two-tier pipeline.
  const prompt = [
    `Task: ${taskSubject}`,
    `Which of the following skills are needed?`,
    `Skills:\n${candidates.map((s) => `${s.name}: ${s.prose ?? s.name}`).join('\n')}`,
    `Respond with comma-separated skill names, or NONE.`,
  ].join('\n');

  const result = await registry.call(
    'llm_classify',
    {
      model: 'fast_classifier',
      prompt,
      allowed_labels: labels,
    },
    ctx,
  );

  // Classifier errored at the primitive level (unknown alias, etc.) —
  // fall through to all candidates. `llm_classify` itself never throws,
  // but it CAN return `err({kind:'arg_invalid'})` if `fast_classifier`
  // isn't mapped in the user's models.yaml.
  if (!result.ok) return candidates;

  const choice = String(result.value);

  // Both safety sentinels collapse to "load everything." UNCERTAIN
  // comes from the llm_classify clamp on unmatched output; NONE comes
  // from the model itself saying "I see no fit". Either way, do not
  // strand the agent without skills.
  if (choice === 'UNCERTAIN' || choice === 'NONE') return candidates;

  // Parse the comma-separated list, trim each token, and intersect
  // with the candidate set by `name`. Tokens that don't match a
  // candidate are silently dropped — the classifier may hallucinate a
  // name and we'd rather return nothing-extra than crash.
  const names = new Set(choice.split(',').map((s) => s.trim()));
  return candidates.filter((s) => names.has(s.name));
}
