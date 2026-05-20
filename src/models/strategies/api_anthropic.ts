/**
 * `api + anthropic` strategy: direct provider HTTP API call via the
 * official Anthropic SDK using the user's API key.
 *
 * Model neutrality (per `feedback_stop_haiku_drift`): NO vendor model
 * identifier appears in this file. `cfg.model` is the user-supplied id
 * passed through to the SDK; opensquid treats it as opaque. If the user
 * leaves `cfg.model` unset, we throw — the source code never picks a
 * default vendor model.
 *
 * Auth: API key resolved via `SecretResolver` (env / .env / op /
 * keychain — pluggable, see `src/secrets/`). The strategy reads
 * `env:ANTHROPIC_API_KEY` by default; the URI is a stable contract with
 * users — DO NOT bake the env var name into a vendor-coupled module.
 *
 * Rate-limit retry: exponential backoff (1s, 2s, 4s) on HTTP 429, max 3
 * retries, then propagate the underlying error. The Anthropic SDK throws
 * structured `APIError` instances with a `.status` field; we read that
 * to decide whether to retry. Other error classes fall through to the
 * caller untouched.
 *
 * Lazy load: `@anthropic-ai/sdk` is an OPTIONAL peer dep. Same rationale
 * as subscription_sdk.ts — startup pays nothing when the package isn't
 * installed; first `.call()` throws a useful pointer if it's missing.
 *
 * Test seam (`opts.sdkModule`): injects a stub Anthropic constructor so
 * tests can simulate happy path + 429 retry + missing-key without hitting
 * the network.
 *
 * Imports from: ../types.js, ../../secrets/types.js.
 * Imported by: models/dispatcher.ts.
 */

import type { SecretResolver } from '../../secrets/types.js';
import type { ModelAliasConfig, ModelStrategy } from '../types.js';

const DEFAULT_MAX_TOKENS = 1024;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// ---------------------------------------------------------------------------
// AnthropicLike — minimal contract the SDK (or a test stub) must satisfy.
//
// Mirrors the relevant slice of `@anthropic-ai/sdk`'s `Anthropic.messages
// .create` surface — non-streaming, single-block text reply. The real SDK
// supports much more (streaming, tool_use blocks, image input); we don't
// depend on any of that here.
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicMessageBlock {
  type: string;
  text?: string;
}

export interface AnthropicMessageResponse {
  content: AnthropicMessageBlock[];
}

export interface AnthropicClient {
  messages: {
    create: (req: {
      model: string;
      max_tokens: number;
      messages: { role: 'user'; content: string }[];
    }) => Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicSdkModule {
  default: new (opts: { apiKey: string }) => AnthropicClient;
}

export interface ApiAnthropicOptions {
  /** Test seam: inject a stub Anthropic constructor module. */
  sdkModule?: AnthropicSdkModule;
}

async function loadSdk(): Promise<AnthropicSdkModule> {
  const moduleName = '@anthropic-ai/sdk';
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as unknown;
    return mod as AnthropicSdkModule;
  } catch (e) {
    throw new Error(
      `api/anthropic strategy: failed to load "${moduleName}". ` +
        `Install it (\`pnpm add ${moduleName}\`) or pick a different mode. ` +
        `Cause: ${String(e)}`,
    );
  }
}

function isRateLimitError(e: unknown): boolean {
  // Anthropic SDK throws `APIError` with a `.status` numeric field; some
  // wrappers stash the same value at `.response.status` or carry a
  // `retry-after` header. Read defensively — the SDK surface can shift.
  if (typeof e !== 'object' || e === null) return false;
  const obj = e as { status?: unknown; response?: { status?: unknown } };
  if (obj.status === 429) return true;
  if (obj.response?.status === 429) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apiAnthropicStrategy(
  cfg: ModelAliasConfig,
  secrets: SecretResolver,
  opts: ApiAnthropicOptions = {},
): ModelStrategy {
  return {
    async call(prompt: string): Promise<string> {
      const apiKey = await secrets.resolve('env:ANTHROPIC_API_KEY');
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not configured (api/anthropic strategy)');
      }
      if (!cfg.model) {
        throw new Error('api/anthropic strategy: `model` is required in alias config');
      }
      const sdkModule = opts.sdkModule ?? (await loadSdk());
      const client = new sdkModule.default({ apiKey });

      let lastErr: unknown;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const res = await client.messages.create({
            model: cfg.model,
            max_tokens: DEFAULT_MAX_TOKENS,
            messages: [{ role: 'user', content: prompt }],
          });
          const textBlock = res.content.find(
            (c): c is AnthropicTextBlock => c.type === 'text' && typeof c.text === 'string',
          );
          return textBlock?.text ?? '';
        } catch (e) {
          lastErr = e;
          if (!isRateLimitError(e) || attempt === RETRY_DELAYS_MS.length) {
            throw e;
          }
          await sleep(RETRY_DELAYS_MS[attempt] ?? 0);
        }
      }
      // Unreachable — the loop either returns or throws.
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}
