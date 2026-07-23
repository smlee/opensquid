/**
 * `cached_audit` primitive — persistent, content-hash-keyed memoization of a
 * single adversarial review or a bounded parallel audit-lens fan-out.
 *
 * WHY (F0c spawn exhaustion): the coding-flow SCOPE/AUTHOR gates run their
 * audit via `subagent_call` (llm.ts) on EVERY pre-research / spec write. Its
 * `if` keys only on the file PATH, so re-editing the SAME artifact cold-spawns
 * `claude -p` again. In a long session those spawns contend on one subscription
 * bucket and start HANGING at the 170s timeout. This primitive caches the
 * verdict keyed by the audit prompt's sha256 (the prompt embeds the artifact,
 * so identical content → identical key) in the canonical task-durable audit
 * store, which persists across turns and fresh StageProcesses. A re-fire on
 * UNCHANGED content returns the cached verdict with NO spawn.
 *
 * Cache discipline:
 *   - Single-review mode caches only a real VERDICT, preserving historical behavior.
 *   - Fan-out mode runs 2-4 pack-declared lenses concurrently, caches completed
 *     lenses after partial failure, and retries only missing lenses.
 *   - The aggregate emits the pass token only when EVERY lens passes; otherwise
 *     it merges concrete findings under one fail verdict.
 *   - Key = sha256(prompt), or sha256 of the ordered lens declarations, additionally
 *     bound to subjectHash when raw artifact bytes are supplied. Changed artifact or
 *     instructions therefore miss without reusing stale evidence.
 *
 * NOT evaluator-`memoizable` or rule-checkpoint `durable`: this primitive owns explicit task-durable
 * persistence so a fresh per-stage process can recover the same content-hash verdict from one authority.
 *
 * Imports from: zod, ../models/load_config.js, ../models/dispatcher.js,
 *   ../runtime/paths.js, ../runtime/durable/run_id.js, ../runtime/result.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { z } from 'zod';

import { resolveStrategy } from '../models/dispatcher.js';
import { loadModelsConfig } from '../models/load_config.js';
import { ModelTimeoutError } from '../models/types.js';
import { AuditVerdictTokenSchema, distinctAuditVerdicts } from '../runtime/audit_schema.js';
import { sha256Hex } from '../runtime/durable/run_id.js';
import { MAX_SUBAGENT_RESULT_BYTES } from '../runtime/subagents/types.js';
import { truncateUtf8 } from '../runtime/subagents/supervisor.js';
import { withAuditCacheKeyLock, withAuditFanoutAdmission } from '../runtime/audit_admission.js';
import {
  aggregateAuditLenses,
  deriveAuditEvidenceVerdict,
  MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES,
  parseAuditEvidenceEntry,
  type AuditEvidenceEntry,
  type AuditLensVerdict,
} from '../runtime/loop/audit_evidence.js';
import { appendAuditTelemetry, type AuditTelemetryEntry } from '../runtime/loop/audit_telemetry.js';
import { err, ok, type Result } from '../runtime/result.js';
import {
  readTaskAuditCache,
  readTaskAuditHistory,
  writeTaskAuditCache,
} from '../runtime/loop/task_audit_cache.js';

import {
  AuditFanout,
  AuditLensSetSchema,
  AuditTextSchema,
  renderAuditLensPrompt,
  type AuditFanoutResult,
  type AuditLens,
} from './audit_fanout.js';
import { FunctionRegistry, type EvalCtx, type FunctionError } from './registry.js';

export { aggregateAuditLenses } from '../runtime/loop/audit_evidence.js';

const CachedAuditArgs = z
  .object({
    cache_key: z.string().min(1),
    model: z.string().min(1),
    prompt: AuditTextSchema.refine(
      (value) => value.length > 0,
      'audit prompt must not be empty',
    ).optional(),
    lenses: AuditLensSetSchema.optional(),
    pass_verdict: AuditVerdictTokenSchema.default('GUESS_FREE'),
    fail_verdict: AuditVerdictTokenSchema.default('UNRESOLVED'),
    timeout_ms: z.number().int().min(1).max(600_000).optional(),
    // The raw ARTIFACT under audit (e.g. the staged diff), distinct from the instruction-laden prompt(s). When
    // provided, its sha256 is recorded as `subjectHash` so a DOWNSTREAM consumer can prove freshness.
    subject: AuditTextSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.prompt === undefined) === (value.lenses === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of prompt or lenses',
      });
    }
    if (!distinctAuditVerdicts(value.pass_verdict, value.fail_verdict)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pass_verdict and fail_verdict must differ',
      });
    }
  });

/** Validated fan-out policy projected from one pack-owned cached_audit declaration. */
export interface CachedAuditDeclaration {
  readonly cacheKey: string;
  readonly model: string;
  readonly lenses: readonly AuditLens[];
  readonly passVerdict: string;
  readonly failVerdict: string;
  readonly timeoutMs?: number | undefined;
  readonly subjectTemplate?: string | undefined;
}

/** Parse one complete pack declaration through the exact live primitive schema. */
export function parseCachedAuditDeclaration(raw: unknown): CachedAuditDeclaration | null {
  const parsed = CachedAuditArgs.safeParse(raw);
  if (!parsed.success || parsed.data.lenses === undefined) return null;
  return {
    cacheKey: parsed.data.cache_key,
    model: parsed.data.model,
    lenses: parsed.data.lenses,
    passVerdict: parsed.data.pass_verdict,
    failVerdict: parsed.data.fail_verdict,
    ...(parsed.data.timeout_ms === undefined ? {} : { timeoutMs: parsed.data.timeout_ms }),
    ...(parsed.data.subject === undefined ? {} : { subjectTemplate: parsed.data.subject }),
  };
}

type CacheEntry = AuditEvidenceEntry;

/** Read the complete bounded immutable task history so a newer different policy cannot hide an exact hit. */
async function readCachedEntries(sessionId: string, key: string): Promise<CacheEntry[]> {
  try {
    const attempts = await readTaskAuditHistory(sessionId, key, 100);
    const entries = attempts.flatMap((attempt) => {
      const parsed = parseAuditEvidenceEntry(attempt.entry);
      return parsed === null ? [] : [parsed];
    });
    if (entries.length > 0) return entries;
    const durable = parseAuditEvidenceEntry(await readTaskAuditCache(sessionId, key));
    return durable === null ? [] : [durable];
  } catch {
    // A task-store read failure is a cache miss; no second evidence authority exists.
    return [];
  }
}

function bestExactEntry(entries: readonly CacheEntry[], hash: string): CacheEntry | null {
  return entries.find((entry) => entry.hash === hash) ?? null;
}

/** Bounded model/cache operation facts; no audit identity, evidence, or verdict policy is copied. */
async function appendLedger(sessionId: string, entry: AuditTelemetryEntry): Promise<void> {
  try {
    await appendAuditTelemetry(sessionId, {
      ...entry,
      model: truncateUtf8(entry.model, 256),
      ...(entry.lens === undefined ? {} : { lens: truncateUtf8(entry.lens, 64) }),
    });
  } catch {
    /* best-effort bounded telemetry must never break the audit gate */
  }
}

async function writeTaskCache(sessionId: string, key: string, entry: CacheEntry): Promise<boolean> {
  try {
    await writeTaskAuditCache(sessionId, key, entry);
    return true;
  } catch {
    return false;
  }
}

class AuditNoVerdictError extends Error {
  constructor(lens: string) {
    super(`audit lens ${lens} returned no VERDICT line`);
    this.name = 'AuditNoVerdictError';
  }
}

export interface AuditDeclarationHashInput {
  readonly model: string;
  readonly prompt?: string | undefined;
  readonly lenses?: readonly AuditLens[] | undefined;
  readonly passVerdict: string;
  readonly failVerdict: string;
  readonly timeoutMs?: number | undefined;
  readonly subject?: string | undefined;
}

export interface AuditLensPolicyHashInput {
  readonly model: string;
  readonly lens: AuditLens;
  readonly passVerdict: string;
  readonly failVerdict: string;
  readonly timeoutMs?: number | undefined;
}

/** One exact per-lens identity shared by runtime reuse and commit-gate evidence authorization. */
export function auditLensPolicyHash(input: AuditLensPolicyHashInput): string {
  return sha256Hex(
    JSON.stringify({
      model: input.model,
      id: input.lens.id,
      prompt: input.lens.prompt,
      criteria: input.lens.criteria,
      passVerdict: input.passVerdict,
      failVerdict: input.failVerdict,
      timeoutMs: input.timeoutMs,
    }),
  );
}

/** One exact outer identity used by runtime cache classification and commit-gate policy validation. */
export function auditDeclarationCacheHash(input: AuditDeclarationHashInput): string {
  const identity =
    input.prompt === undefined
      ? JSON.stringify({
          mode: 'lenses',
          model: input.model,
          lenses: input.lenses,
          pass_verdict: input.passVerdict,
          fail_verdict: input.failVerdict,
          timeout_ms: input.timeoutMs,
        })
      : JSON.stringify({
          mode: 'prompt',
          model: input.model,
          prompt: input.prompt,
          pass_verdict: input.passVerdict,
          fail_verdict: input.failVerdict,
          timeout_ms: input.timeoutMs,
        });
  return sha256Hex(
    input.subject === undefined
      ? identity
      : JSON.stringify({ identity, subjectHash: sha256Hex(input.subject) }),
  );
}

function describeFailure(error: unknown): string {
  const description = error instanceof Error ? error.message : String(error);
  return description === '' ? 'unknown audit failure' : description;
}

export function registerCachedAuditFunction(registry: FunctionRegistry): void {
  registry.register({
    name: 'cached_audit',
    argSchema: CachedAuditArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 600_000,
    execute: async (
      { cache_key, model, prompt, lenses, pass_verdict, fail_verdict, timeout_ms, subject },
      ctx,
    ) => {
      const passVerdict = pass_verdict ?? 'GUESS_FREE';
      const failVerdict = fail_verdict ?? 'UNRESOLVED';
      const subjectHash = subject === undefined ? undefined : sha256Hex(subject);
      const hash = auditDeclarationCacheHash({
        model,
        prompt,
        lenses,
        passVerdict,
        failVerdict,
        timeoutMs: timeout_ms,
        subject,
      });
      type OperationalOutcome = 'hit' | 'verdict' | 'no_verdict' | 'timeout' | 'error';
      const stamp = (
        outcome: OperationalOutcome,
        duration_ms: number,
        lens?: string,
      ): Promise<void> => {
        const operation = outcome === 'hit' ? 'cache_read' : 'model_call';
        const status =
          outcome === 'hit'
            ? 'hit'
            : outcome === 'timeout' || outcome === 'error'
              ? outcome
              : 'returned';
        return appendLedger(ctx.sessionId, {
          at: new Date().toISOString(),
          model,
          operation,
          status,
          duration_ms,
          ...(lens === undefined ? {} : { lens }),
        });
      };

      const lensPolicyHash = (lens: AuditLens): string =>
        auditLensPolicyHash({
          model,
          lens,
          passVerdict,
          failVerdict,
          timeoutMs: timeout_ms,
        });

      if (lenses !== undefined) {
        try {
          return await withAuditCacheKeyLock(ctx.sessionId, cache_key, async () => {
            // Cache classification happens only after owning the key lock, so no predecessor can publish
            // between read and acquisition and leave this attempt operating on stale evidence.
            const cacheEntries = await readCachedEntries(ctx.sessionId, cache_key);
            const authorizedEntries = cacheEntries.filter(
              (entry) => entry.subjectHash === subjectHash,
            );
            const cached = bestExactEntry(authorizedEntries, hash);
            const exactLenses =
              cached?.lenses?.length === lenses.length &&
              lenses.every((lens, index) => {
                const prior = cached.lenses?.[index];
                return prior?.id === lens.id && prior.promptHash === lensPolicyHash(lens);
              });
            if (cached?.complete === true && cached.lenses !== undefined && exactLenses) {
              // An exact historical hit becomes the latest canonical row so the commit gate observes the same
              // current-policy result that the primitive returns.
              if (!(await writeTaskCache(ctx.sessionId, cache_key, cached))) {
                return err({
                  kind: 'runtime',
                  message: `cached_audit(${model}) could not republish canonical task evidence`,
                });
              }
              await stamp('hit', 0);
              return ok(
                aggregateAuditLenses(
                  cached.lenses,
                  cached.passVerdict ?? passVerdict,
                  cached.failVerdict ?? failVerdict,
                ),
              );
            }

            const cfg = await loadModelsConfig(ctx.packModels);
            const aliasCfg = cfg[model];
            if (!aliasCfg) {
              return err({ kind: 'arg_invalid', message: `Unknown model alias "${model}"` });
            }
            const strategy = resolveStrategy(model, aliasCfg);

            // Reused output must be re-bounded for the CURRENT declaration cardinality. A two-lens result has a
            // larger historical share than a four-lens policy and cannot be persisted unchanged after expansion.
            const perLensLimit = Math.max(
              1_024,
              Math.floor(MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES / lenses.length),
            );
            // A changed lens changes the outer aggregate hash, but unchanged lenses remain individually reusable
            // for the SAME exact subject. Select only prompt-hash matches; never carry evidence across artifacts.
            const priorLenses = new Map<string, AuditLensVerdict>();
            for (const lens of lenses) {
              const promptHash = lensPolicyHash(lens);
              const prior = authorizedEntries
                .flatMap((entry) => entry.lenses ?? [])
                .find((entry) => entry.id === lens.id && entry.promptHash === promptHash);
              if (prior !== undefined) {
                priorLenses.set(lens.id, {
                  ...prior,
                  output: truncateUtf8(prior.output, perLensLimit),
                });
              }
            }
            for (const lens of lenses) {
              const prior = priorLenses.get(lens.id);
              if (prior?.promptHash === lensPolicyHash(lens)) {
                await stamp('hit', 0, lens.id);
              }
            }
            const fanout: AuditFanoutResult = await withAuditFanoutAdmission(ctx.sessionId, () =>
              new AuditFanout().run(lenses, priorLenses, lensPolicyHash, async (lens) => {
                const t0 = Date.now();
                try {
                  const out = await strategy.call(renderAuditLensPrompt(lens), {
                    ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }),
                    maxOutputBytes: MAX_SUBAGENT_RESULT_BYTES,
                  });
                  if (!out.includes('VERDICT:')) {
                    await stamp('no_verdict', Date.now() - t0, lens.id);
                    throw new AuditNoVerdictError(lens.id);
                  }
                  await stamp('verdict', Date.now() - t0, lens.id);
                  return truncateUtf8(out, perLensLimit);
                } catch (error) {
                  if (!(error instanceof AuditNoVerdictError)) {
                    await stamp(
                      error instanceof ModelTimeoutError ? 'timeout' : 'error',
                      Date.now() - t0,
                      lens.id,
                    );
                  }
                  throw error;
                }
              }),
            );
            const complete = fanout.failures.length === 0;
            const verdict = complete
              ? truncateUtf8(
                  aggregateAuditLenses(fanout.completed, passVerdict, failVerdict),
                  MAX_SUBAGENT_RESULT_BYTES,
                )
              : '';
            const failures = fanout.failures.map((failure) => ({
              id: failure.id,
              error: truncateUtf8(describeFailure(failure.error), 4_096),
            }));
            const entry: CacheEntry = {
              hash,
              complete,
              lenses: [...fanout.completed],
              failures,
              passVerdict,
              failVerdict,
              ...(subjectHash === undefined ? {} : { subjectHash }),
            };
            // Partial completion is cached too: a retry runs only failed lenses, never completed work.
            const persisted = await writeTaskCache(ctx.sessionId, cache_key, entry);
            if (!persisted) {
              return err({
                kind: 'runtime',
                message: `cached_audit(${model}) could not persist canonical task evidence`,
              });
            }
            if (!complete) {
              const details = deriveAuditEvidenceVerdict(entry) ?? `VERDICT: ${failVerdict}`;
              return err({
                kind: 'runtime',
                message: `cached_audit(${model}) fan-out incomplete:\n${details}`,
              });
            }
            return ok(verdict);
          });
        } catch (error) {
          return err({
            kind: 'runtime',
            message: `cached_audit(${model}) fan-out admission: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          });
        }
      }

      // Single-review mode uses the same key transaction and sole task-durable cache as fan-out, so mixed-mode
      // calls cannot classify or publish concurrently. Identity includes model and verdict policy; unsafe
      // historical prompt-only/session-file entries miss once rather than crossing policy or store authority.
      try {
        return await withAuditCacheKeyLock(ctx.sessionId, cache_key, async () => {
          const cacheEntries = await readCachedEntries(ctx.sessionId, cache_key);
          const cached = bestExactEntry(
            cacheEntries.filter((entry) => entry.subjectHash === subjectHash),
            hash,
          );
          if (typeof cached?.verdict === 'string' && cached.verdict !== '') {
            if (!(await writeTaskCache(ctx.sessionId, cache_key, cached))) {
              return err({
                kind: 'runtime',
                message: `cached_audit(${model}) could not republish canonical task evidence`,
              });
            }
            await stamp('hit', 0);
            return ok(cached.verdict);
          }
          const cfg = await loadModelsConfig(ctx.packModels);
          const aliasCfg = cfg[model];
          if (!aliasCfg) {
            return err({ kind: 'arg_invalid', message: `Unknown model alias "${model}"` });
          }
          const strategy = resolveStrategy(model, aliasCfg);
          const t0 = Date.now();
          try {
            const out = await strategy.call(prompt!, {
              ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }),
              maxOutputBytes: MAX_SUBAGENT_RESULT_BYTES,
            });
            const cacheableOutput = truncateUtf8(out, MAX_SUBAGENT_RESULT_BYTES);
            const hasVerdict = cacheableOutput.includes('VERDICT:');
            if (!hasVerdict && out.includes('VERDICT:')) {
              await stamp('error', Date.now() - t0);
              return err({
                kind: 'runtime',
                message: `cached_audit(${model}) verdict falls outside persisted evidence bound`,
              });
            }
            if (hasVerdict) {
              const persisted = await writeTaskCache(ctx.sessionId, cache_key, {
                hash,
                verdict: cacheableOutput,
                ...(subjectHash === undefined ? {} : { subjectHash }),
              });
              if (!persisted) {
                return err({
                  kind: 'runtime',
                  message: `cached_audit(${model}) could not persist canonical task evidence`,
                });
              }
            }
            await stamp(hasVerdict ? 'verdict' : 'no_verdict', Date.now() - t0);
            return ok(cacheableOutput);
          } catch (error) {
            await stamp(error instanceof ModelTimeoutError ? 'timeout' : 'error', Date.now() - t0);
            return err({
              kind: 'runtime',
              message: `cached_audit(${model}): ${String(error)}`,
              cause: error,
            });
          }
        });
      } catch (error) {
        return err({
          kind: 'runtime',
          message: `cached_audit(${model}) cache-key admission: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        });
      }
    },
  });
}

/**
 * Dispatch through the live cached_audit contract without reimplementing its schema,
 * cache writer, ledger, partial-resume, output bounds, or verdict aggregation.
 */
export async function dispatchCachedAudit(
  rawArgs: unknown,
  ctx: EvalCtx,
): Promise<Result<unknown, FunctionError>> {
  const registry = new FunctionRegistry();
  registerCachedAuditFunction(registry);
  return registry.call('cached_audit', rawArgs, ctx);
}
