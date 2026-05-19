/**
 * Alias → strategy resolver. Branches on `(mode, impl)`; everything that
 * isn't `subscription + cli` falls through to the stub (LLM.1–LLM.4 fill
 * those in later).
 *
 * The dispatcher is a pure function — no state, no side effects. It owns
 * one decision: given a config, which strategy module handles it. Strategy
 * modules own the actual call mechanics. This keeps the model-neutrality
 * surface small: this file branches on abstract mode names, never on
 * vendor identity.
 *
 * Imports from: ./types.js, ./strategies/subscription_cli.js, ./strategies/_stub.js.
 * Imported by: functions/llm.ts.
 */

import { stubStrategy } from './strategies/_stub.js';
import { subscriptionCliStrategy } from './strategies/subscription_cli.js';
import type { ModelAliasConfig, ModelStrategy } from './types.js';

export function resolveStrategy(alias: string, config: ModelAliasConfig): ModelStrategy {
  if (config.mode === 'subscription' && config.impl === 'cli') {
    return subscriptionCliStrategy(config);
  }
  // Every other (mode, impl) combination — including subscription+sdk,
  // api, local, mcp — routes to the stub until LLM.1–LLM.4 land.
  return stubStrategy(alias, config.mode);
}
