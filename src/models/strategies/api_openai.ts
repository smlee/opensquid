/**
 * `api + openai` strategy: direct provider HTTP API call via the official
 * OpenAI SDK using the user's API key.
 *
 * Model neutrality (per `feedback_stop_haiku_drift`): NO vendor model
 * identifier appears in this file. `cfg.model` is the user-supplied id
 * passed through to the SDK; opensquid treats it as opaque. If the user
 * leaves `cfg.model` unset, we throw — the source code never picks a
 * default.
 *
 * Auth: API key resolved via `SecretResolver`. Default URI is
 * `env:OPENAI_API_KEY`.
 *
 * Rate-limit retry: same shape as api_anthropic.ts — exponential backoff
 * (1s, 2s, 4s) on HTTP 429, max 3 retries.
 *
 * Lazy load: `openai` is an OPTIONAL peer dep.
 *
 * Test seam (`opts.sdkModule`): injects a stub OpenAI constructor module.
 *
 * Imports from: ../types.js, ../../secrets/types.js.
 * Imported by: models/dispatcher.ts.
 */

import type { SecretResolver } from '../../secrets/types.js';
import type { ModelAliasConfig, ModelStrategy } from '../types.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000];

// ---------------------------------------------------------------------------
// OpenAILike — minimal contract the SDK (or a test stub) must satisfy.
// Mirrors `openai`'s `client.chat.completions.create` surface, non-streaming.
// ---------------------------------------------------------------------------

export interface OpenAIChatChoice {
  message?: { content?: string | null };
}

export interface OpenAIChatResponse {
  choices: OpenAIChatChoice[];
}

export interface OpenAIClient {
  chat: {
    completions: {
      create: (req: {
        model: string;
        messages: { role: 'user'; content: string }[];
      }) => Promise<OpenAIChatResponse>;
    };
  };
}

export interface OpenAISdkModule {
  default: new (opts: { apiKey: string }) => OpenAIClient;
}

export interface ApiOpenAIOptions {
  /** Test seam: inject a stub OpenAI constructor module. */
  sdkModule?: OpenAISdkModule;
}

async function loadSdk(): Promise<OpenAISdkModule> {
  const moduleName = 'openai';
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as unknown;
    return mod as OpenAISdkModule;
  } catch (e) {
    throw new Error(
      `api/openai strategy: failed to load "${moduleName}". ` +
        `Install it (\`pnpm add ${moduleName}\`) or pick a different mode. ` +
        `Cause: ${String(e)}`,
    );
  }
}

function isRateLimitError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const obj = e as { status?: unknown; response?: { status?: unknown } };
  if (obj.status === 429) return true;
  if (obj.response?.status === 429) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apiOpenAIStrategy(
  cfg: ModelAliasConfig,
  secrets: SecretResolver,
  opts: ApiOpenAIOptions = {},
): ModelStrategy {
  return {
    async call(prompt: string): Promise<string> {
      const apiKey = await secrets.resolve('env:OPENAI_API_KEY');
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY not configured (api/openai strategy)');
      }
      if (!cfg.model) {
        throw new Error('api/openai strategy: `model` is required in alias config');
      }
      const sdkModule = opts.sdkModule ?? (await loadSdk());
      const client = new sdkModule.default({ apiKey });

      let lastErr: unknown;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const res = await client.chat.completions.create({
            model: cfg.model,
            messages: [{ role: 'user', content: prompt }],
          });
          return res.choices[0]?.message?.content ?? '';
        } catch (e) {
          lastErr = e;
          if (!isRateLimitError(e) || attempt === RETRY_DELAYS_MS.length) {
            throw e;
          }
          await sleep(RETRY_DELAYS_MS[attempt] ?? 0);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}
