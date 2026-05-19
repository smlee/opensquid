/* eslint-disable @typescript-eslint/require-await */
/**
 * Stub strategy for the four modes not yet implemented in Phase 1.
 *
 * The dispatcher resolves to this strategy when the alias's `(mode, impl)`
 * combination isn't `(subscription, cli)`. Calling `.call()` on it rejects
 * with a message naming the missing mode and the LLM.1–LLM.4 task slot
 * that will implement it, so a user mis-configuring `models.yaml` gets a
 * useful pointer instead of a silent stub.
 *
 * Deferred implementations (cross-cutting LLM track):
 *   - LLM.1: subscription + sdk  (SDK-mode subagents, observes parent session)
 *   - LLM.2: api                 (direct provider HTTP API w/ user's key)
 *   - LLM.3: local               (Ollama, llama.cpp, etc. via local endpoint)
 *   - LLM.4: mcp                 (delegate to an external MCP server)
 *
 * Model neutrality: this file names no vendors. Mode names are abstract.
 *
 * Imports from: ../types.js.
 * Imported by: models/dispatcher.ts.
 */

import type { ModelMode, ModelStrategy } from '../types.js';

export function stubStrategy(alias: string, mode: ModelMode): ModelStrategy {
  return {
    async call(): Promise<string> {
      throw new Error(
        `Model alias "${alias}": mode "${mode}" strategy not yet implemented ` +
          '(deferred to cross-cutting tasks LLM.1–LLM.4)',
      );
    },
  };
}
