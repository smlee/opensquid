/**
 * LLM primitives: `subagent_call` + `llm_classify`. Skills compose these
 * into rule processes via YAML; the runtime dispatches each call through
 * the model dispatcher to whichever backend the user's `models.yaml`
 * mapped the alias to.
 *
 * Model neutrality (per `project_opensquid_model_neutral_subagent_primitive`
 * and the model-name-drift feedback memory): packs say `model:
 * fast_classifier`, never a vendor model id. Vendor identity lives in
 * user config. This file names no vendors and the dispatch path is
 * identical for every backend.
 *
 * Primitives:
 *
 *   subagent_call({ model, prompt, timeout_ms? }) → ok(stdout) | err
 *     Calls the strategy and returns its raw output. The only failure
 *     surfaces are `arg_invalid` (unknown alias) and `runtime` (spawn /
 *     timeout / non-zero exit). Use this when the pack needs the full
 *     model response — narrative generation, structured-output tasks,
 *     long-form reasoning.
 *
 *   llm_classify({ model, prompt, allowed_labels, timeout_ms? }) → ok(label)
 *     Wraps `prompt` with a "respond with exactly one of …" suffix, calls
 *     the strategy, takes the first whitespace-delimited token of the
 *     output, and case-insensitively matches it against `allowed_labels`.
 *     Returns `ok('UNCERTAIN')` if no match — and crucially, also clamps
 *     to `'UNCERTAIN'` on EVERY thrown error (timeout, spawn failure,
 *     non-zero exit). A classifier that throws would force every caller
 *     to wrap try/catch; clamping keeps the pack YAML simple. The cost
 *     is that real misconfiguration (alias points at a dead binary)
 *     looks the same as "model couldn't decide" — auditors should grep
 *     for the `'UNCERTAIN'` rate to catch that.
 *
 *   The one `arg_invalid` exception (unknown alias) is intentional:
 *   that's a config error, not a classifier judgment, and it should
 *   surface loudly so the user fixes their `models.yaml`.
 *
 * Imports from: zod, ../runtime/result.js, ../models/dispatcher.js,
 *   ../models/load_config.js, ./registry.js.
 * Imported by: src/functions/index.ts.
 */

import { z } from 'zod';

import { loadModelsConfig } from '../models/load_config.js';
import { resolveStrategy } from '../models/dispatcher.js';
import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Zod arg schemas.
//
// `model` / `prompt` get `min(1)` to block empty-string foot-guns; the empty
// prompt is almost certainly a YAML typo (someone referenced a binding that
// hadn't been set yet). `allowed_labels` requires ≥ 1 so the classifier has
// something to match against.
//
// `timeout_ms` is bounded (1..600_000): the upper bound matches Node's
// setTimeout int32 sanity range and prevents pathological YAML like
// `timeout_ms: 9999999999999`. The lower bound stops a "0 ms" misconfiguration
// from looking like "no timeout" to the strategy (which defaults to 30 s).
// ---------------------------------------------------------------------------

const SubagentCallArgs = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
});

const LlmClassifyArgs = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  allowed_labels: z.array(z.string().min(1)).min(1),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
});

export function registerLlmFunctions(registry: FunctionRegistry): void {
  // DURABLE.2 — both primitives in this file dispatch through a model
  // strategy (subprocess CLI or HTTP-API client). Either path is slow + has
  // a token cost, so we ALWAYS checkpoint: re-running on resume would
  // double-charge the user's subscription / API quota. `subagent_call` is
  // `memoizable: false` because its outputs are non-deterministic (model
  // temperature, narrative generation); `llm_classify` IS memoizable because
  // the pack-supplied `allowed_labels` clamps the output space and the
  // classifier prompt is intentionally low-temp.
  registry.register({
    name: 'subagent_call',
    argSchema: SubagentCallArgs,
    durable: true,
    memoizable: false,
    costEstimateMs: 30_000,
    execute: async ({ model, prompt, timeout_ms }, ctx) => {
      // PR-followup: thread pack-shipped `models.yaml` through the resolver
      // so a pack's declared alias works out of the box without a user-level
      // `~/.opensquid/models.yaml`. `ctx.packModels` is `undefined` for
      // packs that ship no `models.yaml` and for legacy non-pack call sites.
      const cfg = await loadModelsConfig(ctx.packModels);
      const aliasCfg = cfg[model];
      if (!aliasCfg) {
        return err({
          kind: 'arg_invalid',
          message: `Unknown model alias "${model}"`,
        });
      }
      try {
        const strategy = resolveStrategy(model, aliasCfg);
        // Pass timeout only when defined — exactOptionalPropertyTypes
        // forbids forwarding `undefined` into an optional slot.
        const out =
          timeout_ms === undefined
            ? await strategy.call(prompt)
            : await strategy.call(prompt, { timeoutMs: timeout_ms });
        return ok(out);
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `subagent_call(${model}): ${String(e)}`,
          cause: e,
        });
      }
    },
  });

  registry.register({
    name: 'llm_classify',
    argSchema: LlmClassifyArgs,
    durable: true,
    // NOT memoizable (FAC.1): reads ctx.packModels (pack-scoped model
    // aliases) — outside the memo key; a cached result would cross
    // pack alias configs.
    memoizable: false,
    costEstimateMs: 3000,
    execute: async ({ model, prompt, allowed_labels, timeout_ms }, ctx) => {
      // PR-followup: same `ctx.packModels` thread-through as `subagent_call`.
      const cfg = await loadModelsConfig(ctx.packModels);
      const aliasCfg = cfg[model];
      if (!aliasCfg) {
        return err({
          kind: 'arg_invalid',
          message: `Unknown model alias "${model}"`,
        });
      }
      // Prompt-engineering note: " | " separator + explicit "No other words"
      // suffix is the lowest-temp shape we found that works across both
      // subscription-CLI hosts and direct-API mid-size models. Don't change
      // this without re-validating against the classifier eval set.
      const wrappedPrompt = `${prompt}\n\nRespond with exactly one of: ${allowed_labels.join(' | ')}.\nNo other words.`;
      try {
        const strategy = resolveStrategy(model, aliasCfg);
        const raw =
          timeout_ms === undefined
            ? await strategy.call(wrappedPrompt)
            : await strategy.call(wrappedPrompt, { timeoutMs: timeout_ms });
        // First whitespace-delimited token of the trimmed output. Some
        // models append a trailing "." or chatter despite "No other words";
        // we keep only the first token so "ONE_LOGICAL_UNIT." still matches
        // "ONE_LOGICAL_UNIT" (after a final character-class strip below
        // could be added in Phase 2 if eval data warrants it).
        const trimmed = raw.trim();
        const firstToken = trimmed.split(/\s+/)[0] ?? '';
        const match = allowed_labels.find(
          (l) => l === firstToken || l.toLowerCase() === firstToken.toLowerCase(),
        );
        return ok(match ?? 'UNCERTAIN');
      } catch {
        // Clamp every classifier failure to UNCERTAIN. See header comment
        // for the rationale and the audit knob ("UNCERTAIN rate").
        return ok('UNCERTAIN');
      }
    },
  });
}
