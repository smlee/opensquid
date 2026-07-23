/**
 * Alias → strategy resolver. Branches on `(mode, impl)` and dispatches to
 * the matching strategy module. The dispatcher is a pure function: no
 * state, no side effects. It owns ONE decision — given a config, which
 * strategy handles it. Strategy modules own the actual call mechanics.
 *
 * Model neutrality surface: this file branches on abstract mode names
 * (`subscription`, `api`, `local`, `mcp`) and abstract impl names
 * (`cli`, `sdk`), never on vendor identity. The provider split for `api`
 * mode reads `cfg.provider` (a user-supplied string), so even there no
 * vendor name is hardcoded — providers compare against the abstract
 * label users wrote in `models.yaml`.
 *
 * Mode coverage (post LLM.4 — all five modes now concrete):
 *   - (subscription, cli)            → subscriptionCliStrategy
 *   - (subscription, sdk)            → subscriptionSdkStrategy
 *   - (api, *), provider=anthropic   → apiAnthropicStrategy (needs secrets)
 *   - (api, *), provider=openai      → apiOpenAIStrategy    (needs secrets)
 *   - (local, *)                     → localOllamaStrategy (Ollama is the
 *                                       only Phase-1 local impl)
 *   - (mcp, *)                       → mcpStrategy (fail-fasts on missing
 *                                       server/tool at factory time)
 *
 * Secrets dependency:
 *   API strategies need a `SecretResolver` to read the user's API key.
 *   `resolveStrategy` accepts it as an optional second parameter so the
 *   existing (subscription, cli) and (subscription, sdk) callers don't
 *   have to thread it. If a user picks api mode without passing secrets,
 *   the resolver throws at resolve time — a config error, not a runtime
 *   surprise on first call.
 *
 * Imports from: ./types.js, ./strategies/*.js, ../secrets/types.js.
 * Imported by: functions/llm.ts.
 */

import type { SecretResolver } from '../secrets/types.js';

import { apiAnthropicStrategy } from './strategies/api_anthropic.js';
import { apiOpenAIStrategy } from './strategies/api_openai.js';
import { localOllamaStrategy } from './strategies/local_ollama.js';
import { mcpStrategy } from './strategies/mcp.js';
import { stubStrategy } from './strategies/_stub.js';
import { subscriptionCliStrategy } from './strategies/subscription_cli.js';
import { subscriptionSdkStrategy } from './strategies/subscription_sdk.js';
import type { ModelAliasConfig, ModelStrategy } from './types.js';

/** Refuse a bounded call before dispatch unless the strategy enforces the byte cap at capture. */
function withOutputBound(strategy: ModelStrategy, captureBounded: boolean): ModelStrategy {
  return {
    async call(prompt, opts) {
      if (opts?.maxOutputBytes !== undefined && !captureBounded) {
        throw new Error('model strategy does not support capture-bounded output');
      }
      const output = await strategy.call(prompt, opts);
      if (
        opts?.maxOutputBytes !== undefined &&
        Buffer.byteLength(output, 'utf8') > opts.maxOutputBytes
      ) {
        throw new Error(`model output exceeded ${String(opts.maxOutputBytes)} bytes`);
      }
      return output;
    },
  };
}

export function resolveStrategy(
  alias: string,
  config: ModelAliasConfig,
  secrets?: SecretResolver,
): ModelStrategy {
  if (config.mode === 'subscription' && config.impl === 'cli') {
    return withOutputBound(subscriptionCliStrategy(config), true);
  }
  if (config.mode === 'subscription' && config.impl === 'sdk') {
    return withOutputBound(subscriptionSdkStrategy(config), false);
  }
  if (config.mode === 'api') {
    if (!secrets) {
      throw new Error(
        `Model alias "${alias}": api mode requires a SecretResolver to read the API key`,
      );
    }
    if (config.provider === 'anthropic') {
      return withOutputBound(apiAnthropicStrategy(config, secrets), false);
    }
    if (config.provider === 'openai') {
      return withOutputBound(apiOpenAIStrategy(config, secrets), false);
    }
    throw new Error(
      `Model alias "${alias}": api mode requires \`provider\` to be one of "anthropic" | "openai" ` +
        `(got ${config.provider === undefined ? 'undefined' : `"${config.provider}"`})`,
    );
  }
  if (config.mode === 'local') {
    // Phase 1: Ollama is the only `local` implementation. Future engines
    // (llama.cpp, vLLM, MLX) would branch on cfg.provider here.
    return withOutputBound(localOllamaStrategy(config), false);
  }
  if (config.mode === 'mcp') {
    // mcp strategy fail-fasts on missing server/tool at factory time —
    // resolve here surfaces config errors at pack-load.
    return withOutputBound(mcpStrategy(config), false);
  }
  // Unknown mode (shouldn't be reachable given ModelMode union, but the
  // stub is a safe fallback).
  return withOutputBound(stubStrategy(alias, config.mode), false);
}
