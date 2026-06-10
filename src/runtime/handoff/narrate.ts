/**
 * T-AUTO-HANDOFF AHO.2 — the narrative layer (NEVER load-bearing).
 *
 * One bounded model call over the deterministic dump; ANY failure (unknown
 * alias, spawn error, timeout, empty output) returns null and the handoff
 * proceeds without narrative — the dump is the load-bearing record
 * (user-locked). Explicit-command-only: the SessionEnd backup and the
 * SessionStart lazy generator never call this (spawn exhaustion is exactly
 * when automatic handoffs happen).
 *
 * Imports from: ../../models/dispatcher.js, ../../models/load_config.js.
 * Imported by: handoff/index.ts.
 */

import { resolveStrategy } from '../../models/dispatcher.js';
import { loadModelsConfig } from '../../models/load_config.js';

const NARRATE_TIMEOUT_MS = 120_000;
const NARRATE_PROMPT_HEADER = [
  'You are writing the NARRATIVE layer of a session handoff for a successor agent.',
  'Below is the complete deterministic state dump (the load-bearing record — you',
  'must not contradict it). Write a tight causal narrative: what was being done,',
  'what happened, why the state is what it is, and what the successor should watch',
  'for. Max ~30 lines of markdown. No headers above ###. Do not repeat the dump.',
  '',
].join('\n');

export async function narrateHandoff(
  docBody: string,
  opts: {
    alias?: string;
    timeoutMs?: number;
    strategyCall?: (prompt: string) => Promise<string>;
  } = {},
): Promise<string | null> {
  try {
    let call = opts.strategyCall;
    if (call === undefined) {
      const cfg = await loadModelsConfig();
      const alias = opts.alias ?? 'reasoning';
      const aliasCfg = cfg[alias];
      if (!aliasCfg) return null;
      const strategy = resolveStrategy(alias, aliasCfg);
      call = (p: string) => strategy.call(p, { timeoutMs: opts.timeoutMs ?? NARRATE_TIMEOUT_MS });
    }
    const out = (await call(`${NARRATE_PROMPT_HEADER}${docBody}`)).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // timeout / spawn / config error — narrative skipped
  }
}
