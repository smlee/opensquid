/**
 * `cached_audit` primitive — persistent, content-hash-keyed memoization of an
 * adversarial LLM audit verdict.
 *
 * WHY (F0c spawn exhaustion): the coding-flow SCOPE/AUTHOR gates run their
 * audit via `subagent_call` (llm.ts) on EVERY pre-research / spec write. Its
 * `if` keys only on the file PATH, so re-editing the SAME artifact cold-spawns
 * `claude -p` again. In a long session those spawns contend on one subscription
 * bucket and start HANGING at the 170s timeout. This primitive caches the
 * verdict keyed by the audit prompt's sha256 (the prompt embeds the artifact,
 * so identical content → identical key) in SESSION STATE — which persists
 * across turns / short-lived hook subprocesses, unlike the evaluator's per-run
 * memo. A re-fire on UNCHANGED content returns the cached verdict with NO spawn.
 *
 * Cache discipline:
 *   - Only a REAL verdict (output contains "VERDICT:") is cached. A timeout /
 *     spawn error is returned as `err` and NEVER cached — so the skill's
 *     `on_error: continue` still routes it to the AUDIT-UNAVAILABLE branch and
 *     the NEXT turn retries the spawn (F0c fresh-session recovery preserved).
 *   - Key = sha256(prompt). The prompt includes BOTH the audit instruction and
 *     the artifact, so a changed artifact OR a changed instruction → cache miss
 *     → fresh audit. No stale verdict can be reused.
 *
 * NOT `memoizable` (the evaluator memo is per-run; THIS cache is the explicit
 * cross-turn one) and NOT `durable` (the state write IS its durability).
 *
 * Imports from: zod, ../models/load_config.js, ../models/dispatcher.js,
 *   ../runtime/paths.js, ../runtime/durable/run_id.js, ../runtime/result.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { resolveStrategy } from '../models/dispatcher.js';
import { loadModelsConfig } from '../models/load_config.js';
import { sha256Hex } from '../runtime/durable/run_id.js';
import { sessionStateFile } from '../runtime/paths.js';
import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

const CachedAuditArgs = z
  .object({
    cache_key: z.string().min(1),
    model: z.string().min(1),
    prompt: z.string().min(1),
    timeout_ms: z.number().int().min(1).max(600_000).optional(),
  })
  .strict();

interface CacheEntry {
  hash: string;
  verdict: string;
}

function isCacheEntry(v: unknown): v is CacheEntry {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as CacheEntry).hash === 'string' &&
    typeof (v as CacheEntry).verdict === 'string'
  );
}

/** The cached verdict IFF a valid entry exists AND its hash matches; else null. */
async function readCachedVerdict(
  sessionId: string,
  key: string,
  hash: string,
): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(sessionStateFile(sessionId, key), 'utf8')) as unknown;
    if (isCacheEntry(parsed) && parsed.hash === hash) return parsed.verdict;
    return null;
  } catch {
    return null; // ENOENT / malformed → treat as a miss
  }
}

async function writeCache(sessionId: string, key: string, entry: CacheEntry): Promise<void> {
  const path = sessionStateFile(sessionId, key);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
    await rename(tmp, path);
  } catch {
    /* best-effort: a cache-write failure must NEVER break the audit gate */
  }
}

export function registerCachedAuditFunction(registry: FunctionRegistry): void {
  registry.register({
    name: 'cached_audit',
    argSchema: CachedAuditArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 30_000,
    execute: async ({ cache_key, model, prompt, timeout_ms }, ctx) => {
      const hash = sha256Hex(prompt);
      const hit = await readCachedVerdict(ctx.sessionId, cache_key, hash);
      if (hit !== null) {
        return ok(hit); // HIT — identical prompt → reuse, no spawn
      }
      // MISS — dispatch the model (same path as subagent_call).
      const cfg = await loadModelsConfig(ctx.packModels);
      const aliasCfg = cfg[model];
      if (!aliasCfg) {
        return err({ kind: 'arg_invalid', message: `Unknown model alias "${model}"` });
      }
      try {
        const strategy = resolveStrategy(model, aliasCfg);
        const out =
          timeout_ms === undefined
            ? await strategy.call(prompt)
            : await strategy.call(prompt, { timeoutMs: timeout_ms });
        // Cache ONLY a real verdict — never a timeout/error/empty string, so an
        // AUDIT-UNAVAILABLE result is retried next turn instead of being pinned.
        if (out.includes('VERDICT:')) {
          await writeCache(ctx.sessionId, cache_key, { hash, verdict: out });
        }
        return ok(out);
      } catch (e) {
        return err({ kind: 'runtime', message: `cached_audit(${model}): ${String(e)}`, cause: e });
      }
    },
  });
}
