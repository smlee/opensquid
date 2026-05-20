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
 * vendor name is hardcoded in source.
 *
 * Mode coverage (post LLM.1):
 *   - (subscription, cli) → subscriptionCliStrategy
 *   - (subscription, sdk) → subscriptionSdkStrategy
 *   - everything else     → stubStrategy (LLM.2–LLM.4 fill these in)
 *
 * Imports from: ./types.js, ./strategies/*.js.
 * Imported by: functions/llm.ts.
 */

import { stubStrategy } from './strategies/_stub.js';
import { subscriptionCliStrategy } from './strategies/subscription_cli.js';
import { subscriptionSdkStrategy } from './strategies/subscription_sdk.js';
import type { ModelAliasConfig, ModelStrategy } from './types.js';

export function resolveStrategy(alias: string, config: ModelAliasConfig): ModelStrategy {
  if (config.mode === 'subscription' && config.impl === 'cli') {
    return subscriptionCliStrategy(config);
  }
  if (config.mode === 'subscription' && config.impl === 'sdk') {
    return subscriptionSdkStrategy(config);
  }
  // Every remaining (mode, impl) combination — api, local, mcp — routes
  // to the stub until LLM.2–LLM.4 land.
  return stubStrategy(alias, config.mode);
}
