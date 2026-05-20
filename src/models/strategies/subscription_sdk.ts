/**
 * `subscription + sdk` strategy: in-process Claude Agent SDK call.
 *
 * Architectural note (load-bearing):
 *   This is the ONLY mode that observes parent session state. Mode A
 *   subagents that need to inherit the parent's context (Phase 6.3) MUST
 *   route through this strategy — the other modes (cli / api / local /
 *   mcp) all run out-of-process or hit a remote endpoint and cannot see
 *   the host's running session. See `project_opensquid_team_modes` and
 *   `project_opensquid_model_neutral_subagent_primitive` memories.
 *
 * Model neutrality (per `feedback_stop_haiku_drift`): NO vendor model name
 * appears in this file. `cfg.model` is the user-supplied identifier passed
 * through to the SDK; opensquid treats it as opaque. Audit grep over
 * `src/models/strategies/*.ts` must return zero hits for `haiku|sonnet|
 * opus|gpt-[0-9]|claude-[0-9]|gemini` in runtime code.
 *
 * Lazy load:
 *   `@anthropic-ai/claude-agent-sdk` is an OPTIONAL peer dep (Phase 6.2).
 *   The dynamic import happens at first `.call()` — startup pays nothing
 *   when the SDK isn't installed. If a user wires `mode: subscription /
 *   impl: sdk` without the package present, the import throws "Cannot
 *   find module" and we re-throw with a clearer pointer.
 *
 * Test seam (`opts.sdk`):
 *   Mirrors `src/functions/subagent.ts`. Tests pass `{ sdk }` via the
 *   factory's second argument to bypass the dynamic import; production
 *   never sets it. The seam is intentionally NOT a runtime override path
 *   that pack YAML can reach.
 *
 * Imports from: ../types.js.
 * Imported by: models/dispatcher.ts.
 */

import type { ModelAliasConfig, ModelStrategy } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// SubscriptionSdk — minimal contract the SDK (or a test stub) must satisfy.
//
// Kept narrow: this strategy only needs `runAgent` to return text. The
// real SDK exposes more (streaming, tools, permissions); we don't depend
// on any of that here.
// ---------------------------------------------------------------------------

export interface SubscriptionSdkRunResult {
  text: string;
}

export interface SubscriptionSdk {
  runAgent: (opts: {
    model: string | undefined;
    prompt: string;
    timeoutMs: number;
  }) => Promise<SubscriptionSdkRunResult>;
}

export interface SubscriptionSdkOptions {
  /** Test seam: inject a stub SDK to bypass the lazy dynamic import. */
  sdk?: SubscriptionSdk;
}

async function loadSdk(packageName: string): Promise<SubscriptionSdk> {
  // Variable-string import dodges TS's compile-time module-resolution check.
  // The SDK is an OPTIONAL peer dep; users who don't enable SDK-mode model
  // aliases never install it, and that's fine — we only need it on first
  // `.call()`. A missing install will throw "Cannot find module" here and
  // surface a useful pointer rather than a silent failure.
  try {
    const mod = (await import(/* @vite-ignore */ packageName)) as unknown;
    return mod as SubscriptionSdk;
  } catch (e) {
    throw new Error(
      `subscription/sdk strategy: failed to load SDK package "${packageName}". ` +
        `Install it (e.g. \`pnpm add ${packageName}\`) or pick a different mode. ` +
        `Cause: ${String(e)}`,
    );
  }
}

export function subscriptionSdkStrategy(
  cfg: ModelAliasConfig,
  opts: SubscriptionSdkOptions = {},
): ModelStrategy {
  return {
    async call(prompt: string, callOpts?: { timeoutMs?: number }): Promise<string> {
      const packageName = cfg.sdk ?? '@anthropic-ai/claude-agent-sdk';
      const sdk = opts.sdk ?? (await loadSdk(packageName));
      const res = await sdk.runAgent({
        model: cfg.model,
        prompt,
        timeoutMs: callOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      return res.text;
    },
  };
}
