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
 * Mode coverage (post LLM.2):
 *   - (subscription, cli)            → subscriptionCliStrategy
 *   - (subscription, sdk)            → subscriptionSdkStrategy
 *   - (api, *), provider=anthropic   → apiAnthropicStrategy (needs secrets)
 *   - (api, *), provider=openai      → apiOpenAIStrategy    (needs secrets)
 *   - everything else                → stubStrategy (LLM.3–LLM.4 fill in)
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
import { stubStrategy } from './strategies/_stub.js';
import { subscriptionCliStrategy } from './strategies/subscription_cli.js';
import { subscriptionSdkStrategy } from './strategies/subscription_sdk.js';
import type { ModelAliasConfig, ModelStrategy } from './types.js';

export function resolveStrategy(
  alias: string,
  config: ModelAliasConfig,
  secrets?: SecretResolver,
): ModelStrategy {
  if (config.mode === 'subscription' && config.impl === 'cli') {
    return subscriptionCliStrategy(config);
  }
  if (config.mode === 'subscription' && config.impl === 'sdk') {
    return subscriptionSdkStrategy(config);
  }
  if (config.mode === 'api') {
    if (!secrets) {
      throw new Error(
        `Model alias "${alias}": api mode requires a SecretResolver to read the API key`,
      );
    }
    if (config.provider === 'anthropic') {
      return apiAnthropicStrategy(config, secrets);
    }
    if (config.provider === 'openai') {
      return apiOpenAIStrategy(config, secrets);
    }
    throw new Error(
      `Model alias "${alias}": api mode requires \`provider\` to be one of "anthropic" | "openai" ` +
        `(got ${config.provider === undefined ? 'undefined' : `"${config.provider}"`})`,
    );
  }
  // local / mcp / anything else falls through to the stub until LLM.3–LLM.4.
  return stubStrategy(alias, config.mode);
}
