/**
 * `check_destination` primitive — LLM-judged goal-alignment check.
 *
 * The second anti-drift category (per `docs/opensquid-real-design.md`
 * §"Anti-drift split"): a periodic check that compares the agent's recent
 * actions to the pack's declared goal and surfaces a `block` verdict when
 * the agent has drifted off-mission. Distinct from track_check (which is
 * deterministic regex / state matching) — this one delegates the judgement
 * to a classifier LLM via the model-aliased subprocess primitive.
 *
 * Model neutrality (per the "stop drifting on model names" feedback memory
 * + the model-neutral subagent-primitive memory): this file names NO
 * vendor model. The default alias is `'reasoning'` — a task-purpose label
 * that the user maps to a concrete backend in `models.yaml`. A vendor-name
 * grep over this file should return zero hits; treat any future addition
 * as a regression.
 *
 * Failure semantics:
 *
 *   - `llm_classify` clamps every classifier error to `'UNCERTAIN'` (see
 *     `src/functions/llm.ts` header). The one exception is `arg_invalid`
 *     for an unknown alias — that's a config error and surfaces as an `err`
 *     here so the user fixes their `models.yaml`.
 *
 *   - Label policy:
 *       'DRIFTING'          → block verdict, message names the goal
 *       'ON_GOAL'           → pass verdict, empty message
 *       'UNCERTAIN' / other → pass verdict (conservative — never block on
 *                             classifier confusion; auditors track the
 *                             'UNCERTAIN' rate as a misconfiguration signal)
 *
 * This is registered via `registerDestinationCheckFunction(registry)` and
 * not auto-bundled into `registerLlmFunctions` because (a) it's a composite
 * primitive (it calls `llm_classify` underneath) and (b) callers may want
 * to wire it conditionally once Phase 4.3 ships the scheduler.
 *
 * Phase 4.2 imports it into `runtime/bootstrap.ts` so the standard runtime
 * registry includes `check_destination` alongside the other primitives.
 *
 * Imports from: zod, ../runtime/result.js, ./registry.js.
 * Imported by: src/functions/index.ts, src/runtime/bootstrap.ts.
 */

import { z } from 'zod';

import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// CheckDestinationArgs — Zod schema for `check_destination` args.
//
// `goal`           — pack goal string, propagated into the prompt + verdict
//                    message. Required `min(1)` so a pack with no goal at
//                    all surfaces as arg_invalid rather than silently
//                    generating a useless prompt ("Pack goal: \nRecent...").
// `recent_actions` — list of tool-call summaries from the active session.
//                    An empty array is valid (first-tick edge case): the
//                    prompt still goes to the classifier, which can
//                    reasonably return UNCERTAIN.
// `model`          — model alias. Defaults to 'reasoning' (task-purpose
//                    label, not a vendor model id — see file header). Pack
//                    YAML can override per-rule (e.g. fast_classifier for
//                    rough triage, reasoning for the careful check).
// ---------------------------------------------------------------------------

const CheckDestinationArgs = z.object({
  goal: z.string().min(1),
  recent_actions: z.array(z.string()),
  model: z.string().min(1).default('reasoning'),
});

// ---------------------------------------------------------------------------
// CheckDestinationResult — the primitive's return shape.
//
// Matches the `Verdict` shape (level + message) but typed narrowly here:
// only 'pass' and 'block' are ever produced. The dispatcher (Phase 4.3)
// turns this into a Verdict before handing it to the drift-response layer.
// ---------------------------------------------------------------------------

export interface CheckDestinationResult {
  level: 'pass' | 'block';
  message: string;
}

// ---------------------------------------------------------------------------
// ALLOWED_LABELS — the three responses the classifier must pick from.
//
// Constant (not a parameter) because the primitive's policy mapping
// (DRIFTING → block, ON_GOAL/UNCERTAIN → pass) is hard-coded below. Adding
// a fourth label requires updating that mapping in lockstep, so the labels
// stay private to this primitive rather than being pack-author-tunable.
// ---------------------------------------------------------------------------

const ALLOWED_LABELS = ['ON_GOAL', 'DRIFTING', 'UNCERTAIN'] as const;

// ---------------------------------------------------------------------------
// registerDestinationCheckFunction — register `check_destination` against a
// registry that ALREADY has `llm_classify` registered (the LLM primitive
// family is bundled into the runtime via `registerLlmFunctions` upstream).
//
// `registry.call('llm_classify', ...)` is dispatched in-process — no IPC,
// no subprocess from this primitive's perspective. The downstream
// `llm_classify` primitive then dispatches through the model strategy.
//
// If `llm_classify` is not registered (degenerate runtime), `registry.call`
// returns `err({ kind: 'not_found' })` which propagates back to the caller.
// This is intentional: it means a misconfigured pack can't silently bypass
// the classifier.
// ---------------------------------------------------------------------------

export function registerDestinationCheckFunction(registry: FunctionRegistry): void {
  // DURABLE.2 — composes `llm_classify` under the hood; same expense profile.
  // `durable: true` so resume restores the verdict instead of re-paying the
  // classifier call. `memoizable: true` because the prompt is constructed
  // deterministically from `(goal, recent_actions, model)` and the
  // `ALLOWED_LABELS` set is closed — identical inputs give identical labels
  // within the classifier's temperature, matching `llm_classify`'s memo
  // policy.
  registry.register({
    name: 'check_destination',
    argSchema: CheckDestinationArgs,
    durable: true,
    memoizable: true,
    costEstimateMs: 5000,
    execute: async ({ goal, recent_actions, model }, ctx) => {
      // Prompt construction — kept simple + deterministic. Pack authors who
      // need a richer prompt should compose their own process via direct
      // `llm_classify` calls. The point of `check_destination` is the
      // pre-packaged label policy, not a templating engine.
      const actionLines =
        recent_actions.length === 0
          ? ['(no actions recorded yet)']
          : recent_actions.map((a, i) => `${String(i + 1)}. ${a}`);
      const prompt = [
        `Pack goal: ${goal}`,
        `Recent actions:`,
        ...actionLines,
        ``,
        `Has the agent drifted from the goal? Answer ON_GOAL or DRIFTING.`,
      ].join('\n');

      const result = await registry.call(
        'llm_classify',
        { model, prompt, allowed_labels: [...ALLOWED_LABELS] },
        ctx,
      );
      if (!result.ok) return err(result.error);

      // `llm_classify` returns a string label (the matched allowed_label, or
      // 'UNCERTAIN' on no-match / failure). String() narrows the registry's
      // `unknown` value back to a string before equality — safer than `as`.
      const label = String(result.value);

      if (label === 'DRIFTING') {
        return ok<CheckDestinationResult>({
          level: 'block',
          message: `Drifted from goal: ${goal}`,
        });
      }
      // ON_GOAL or UNCERTAIN (or any unexpected label) → pass.
      return ok<CheckDestinationResult>({ level: 'pass', message: '' });
    },
  });
}
