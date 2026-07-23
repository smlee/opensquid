import { z } from 'zod';

import type { AuditLensVerdict } from '../runtime/loop/audit_evidence.js';
import {
  AUDIT_LENS_MAX,
  AUDIT_LENS_MIN,
  AuditLensIdSchema,
  MAX_AUDIT_CRITERIA,
  MAX_AUDIT_CRITERION_BYTES,
  MAX_AUDIT_TEXT_BYTES,
} from '../runtime/audit_schema.js';

export type { AuditLensVerdict } from '../runtime/loop/audit_evidence.js';

/** Shared fixed prompt/subject bound; byte check closes the multibyte gap in z.string().max(). */
export const AuditTextSchema = z
  .string()
  .max(MAX_AUDIT_TEXT_BYTES)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_AUDIT_TEXT_BYTES, {
    message: `audit text exceeds ${String(MAX_AUDIT_TEXT_BYTES)} bytes`,
  });

const AuditCriterionSchema = z
  .string()
  .min(1)
  .max(MAX_AUDIT_CRITERION_BYTES)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_AUDIT_CRITERION_BYTES, {
    message: `audit criterion exceeds ${String(MAX_AUDIT_CRITERION_BYTES)} bytes`,
  });

function renderPrompt(lens: { prompt: string; criteria?: readonly string[] | undefined }): string {
  return lens.criteria === undefined
    ? lens.prompt
    : `${lens.prompt}\n\nCriteria:\n${lens.criteria.map((criterion) => `- ${criterion}`).join('\n')}`;
}

/** One pack-declared reviewer. IDs are bounded ASCII because they become aggregate finding prefixes. */
const AuditLensSchema = z
  .object({
    id: AuditLensIdSchema,
    prompt: AuditTextSchema.refine((value) => value.length > 0, 'audit prompt must not be empty'),
    criteria: z.array(AuditCriterionSchema).min(1).max(MAX_AUDIT_CRITERIA).optional(),
  })
  .strict()
  .superRefine((lens, ctx) => {
    if (Buffer.byteLength(renderPrompt(lens), 'utf8') > MAX_AUDIT_TEXT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: `rendered audit prompt exceeds ${String(MAX_AUDIT_TEXT_BYTES)} bytes`,
      });
    }
  });

export const AuditLensSetSchema = z
  .array(AuditLensSchema)
  .min(AUDIT_LENS_MIN)
  .max(AUDIT_LENS_MAX)
  .superRefine((lenses, ctx) => {
    const ids = lenses.map((lens) => lens.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'audit lens ids must be unique' });
    }
  });

export type AuditLens = z.infer<typeof AuditLensSchema>;

/** Render the exact bounded model prompt so criteria cannot be silently dropped by an adapter. */
export function renderAuditLensPrompt(lens: AuditLens): string {
  return renderPrompt(lens);
}

export interface AuditLensFailure {
  readonly id: string;
  readonly error: unknown;
}

export interface AuditFanoutResult {
  readonly completed: readonly AuditLensVerdict[];
  readonly failures: readonly AuditLensFailure[];
}

type AuditLensAttemptState = 'pending' | 'reused' | 'running' | 'completed' | 'failed';
type AuditLensAttemptEvent = 'reuse' | 'start' | 'resolve' | 'reject';

const LENS_ATTEMPT_NEXT: Readonly<
  Record<AuditLensAttemptState, Record<AuditLensAttemptEvent, AuditLensAttemptState>>
> = {
  pending: { reuse: 'reused', start: 'running', resolve: 'failed', reject: 'failed' },
  reused: { reuse: 'reused', start: 'reused', resolve: 'reused', reject: 'reused' },
  running: { reuse: 'failed', start: 'failed', resolve: 'completed', reject: 'failed' },
  completed: { reuse: 'completed', start: 'completed', resolve: 'completed', reject: 'completed' },
  failed: { reuse: 'failed', start: 'failed', resolve: 'failed', reject: 'failed' },
};

function stepLensAttempt(
  state: AuditLensAttemptState,
  event: AuditLensAttemptEvent,
): AuditLensAttemptState {
  return LENS_ATTEMPT_NEXT[state][event];
}

/**
 * Runs the missing audit lenses concurrently while preserving declaration order.
 * Completed results supplied by the caller are reused; persistence remains the
 * caller's responsibility so this class has no store or harness dependency.
 */
export class AuditFanout {
  async run(
    lenses: readonly AuditLens[],
    cached: ReadonlyMap<string, AuditLensVerdict>,
    lensHash: (lens: AuditLens) => string,
    review: (lens: AuditLens) => Promise<string>,
  ): Promise<AuditFanoutResult> {
    const validated = AuditLensSetSchema.safeParse(lenses);
    if (!validated.success) {
      throw new Error(`invalid audit lens set: ${validated.error.message}`);
    }

    const pending = new Map<
      string,
      Promise<{ readonly output: string } | { readonly error: unknown }>
    >();
    const states = new Map<string, AuditLensAttemptState>();
    for (const lens of validated.data) {
      const hash = lensHash(lens);
      const prior = cached.get(lens.id);
      states.set(lens.id, 'pending');
      if (prior?.promptHash === hash) {
        states.set(lens.id, stepLensAttempt('pending', 'reuse'));
        continue;
      }
      states.set(lens.id, stepLensAttempt('pending', 'start'));
      // Creating every promise before awaiting any of them is the concurrency boundary.
      pending.set(
        lens.id,
        review(lens).then(
          (output) => ({ output }),
          (error: unknown) => ({ error }),
        ),
      );
    }

    const settled = new Map<string, { readonly output: string } | { readonly error: unknown }>();
    await Promise.all(
      [...pending.entries()].map(async ([id, promise]) => {
        settled.set(id, await promise);
      }),
    );

    const completed: AuditLensVerdict[] = [];
    const failures: AuditLensFailure[] = [];
    for (const lens of validated.data) {
      const hash = lensHash(lens);
      const prior = cached.get(lens.id);
      if (prior?.promptHash === hash) {
        completed.push(prior);
        continue;
      }
      const result = settled.get(lens.id);
      if (result !== undefined && 'output' in result) {
        states.set(lens.id, stepLensAttempt(states.get(lens.id) ?? 'failed', 'resolve'));
        completed.push({ id: lens.id, promptHash: hash, output: result.output });
      } else {
        states.set(lens.id, stepLensAttempt(states.get(lens.id) ?? 'failed', 'reject'));
        failures.push({
          id: lens.id,
          error: result === undefined ? new Error('audit lens did not settle') : result.error,
        });
      }
    }
    return { completed, failures };
  }
}
