import { z } from 'zod';

import {
  AUDIT_LENS_MAX,
  AUDIT_LENS_MIN,
  AuditLensIdSchema,
  AuditVerdictTokenSchema,
  distinctAuditVerdicts,
} from '../audit_schema.js';
import { MAX_SUBAGENT_RESULT_BYTES } from '../subagents/types.js';
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** Leaves bounded room for verdict, lens ids, labels, separators, and counts in a 50-KiB aggregate. */
export const MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES = MAX_SUBAGENT_RESULT_BYTES - 1_024;

function utf8Bounded(minBytes: number, maxBytes: number): z.ZodEffects<z.ZodString> {
  return z.string().superRefine((value, ctx) => {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes < minBytes || bytes > maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `text must be ${String(minBytes)}-${String(maxBytes)} UTF-8 bytes`,
      });
    }
  });
}

const AuditLensVerdictSchema = z
  .object({
    id: AuditLensIdSchema,
    promptHash: Sha256,
    output: utf8Bounded(1, MAX_SUBAGENT_RESULT_BYTES),
  })
  .strict();

const AuditFailureSchema = z
  .object({
    id: AuditLensIdSchema,
    error: utf8Bounded(1, 4_096),
  })
  .strict();

export const AuditEvidenceEntrySchema = z
  .object({
    hash: Sha256,
    verdict: utf8Bounded(1, MAX_SUBAGENT_RESULT_BYTES).optional(),
    complete: z.boolean().optional(),
    lenses: z.array(AuditLensVerdictSchema).max(AUDIT_LENS_MAX).optional(),
    failures: z.array(AuditFailureSchema).max(AUDIT_LENS_MAX).optional(),
    passVerdict: AuditVerdictTokenSchema.optional(),
    failVerdict: AuditVerdictTokenSchema.optional(),
    subjectHash: Sha256.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const fanoutFields = [
      entry.complete,
      entry.lenses,
      entry.failures,
      entry.passVerdict,
      entry.failVerdict,
    ];
    if (entry.verdict !== undefined) {
      if (fanoutFields.some((field) => field !== undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'legacy verdict evidence cannot contain fan-out fields',
        });
      }
      return;
    }
    if (
      entry.complete === undefined ||
      entry.lenses === undefined ||
      entry.passVerdict === undefined ||
      entry.failVerdict === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fan-out evidence needs complete, lenses, and pass/fail verdict policy',
      });
      return;
    }
    if (!distinctAuditVerdicts(entry.passVerdict, entry.failVerdict)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass/fail verdicts must differ' });
    }
    const failures = entry.failures ?? [];
    const evidenceBytes = entry.lenses.reduce(
      (total, lens) => total + Buffer.byteLength(lens.output, 'utf8'),
      0,
    );
    if (evidenceBytes > MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fan-out lens evidence exceeds the aggregate input budget',
      });
    }
    const ids = [...entry.lenses.map((lens) => lens.id), ...failures.map((failure) => failure.id)];
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'audit evidence lens/failure ids must be unique',
      });
    }
    if (entry.complete) {
      if (entry.lenses.length < AUDIT_LENS_MIN || failures.length !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'complete fan-out evidence needs 2-4 lenses and no failures',
        });
      }
    } else if (
      failures.length === 0 ||
      ids.length < AUDIT_LENS_MIN ||
      ids.length > AUDIT_LENS_MAX
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'partial fan-out evidence needs 2-4 total unique lens outcomes and a failure',
      });
    }
  });

export type AuditEvidenceEntry = z.infer<typeof AuditEvidenceEntrySchema>;
export type AuditLensVerdict = z.infer<typeof AuditLensVerdictSchema>;
export type AuditEvidenceFailure = z.infer<typeof AuditFailureSchema>;

export interface AuditEvidencePolicyIdentity {
  readonly hash: string;
  readonly subjectHash?: string | undefined;
  readonly passVerdict: string;
  readonly failVerdict: string;
  readonly lenses: readonly { readonly id: string; readonly promptHash: string }[];
}

function matchesDeclaredFanoutPolicy(
  entry: AuditEvidenceEntry,
  policy: AuditEvidencePolicyIdentity,
): boolean {
  if (
    entry.verdict !== undefined ||
    entry.hash !== policy.hash ||
    entry.subjectHash !== policy.subjectHash ||
    entry.passVerdict !== policy.passVerdict ||
    entry.failVerdict !== policy.failVerdict
  ) {
    return false;
  }
  const expected = new Map(policy.lenses.map((lens) => [lens.id, lens.promptHash]));
  const actualIds = [
    ...(entry.lenses?.map((lens) => lens.id) ?? []),
    ...(entry.failures?.map((failure) => failure.id) ?? []),
  ];
  return (
    actualIds.length === policy.lenses.length &&
    actualIds.every((id) => expected.has(id)) &&
    (entry.lenses ?? []).every((lens) => expected.get(lens.id) === lens.promptHash)
  );
}

/** Exact declared policy match for bounded complete or partial gate diagnostics. */
export function auditEvidenceMatchesPolicyForDiagnostics(
  entry: AuditEvidenceEntry,
  policy: AuditEvidencePolicyIdentity,
): boolean {
  return matchesDeclaredFanoutPolicy(entry, policy);
}

/** Exact active-policy match required before complete fan-out evidence can authorize a gate. */
export function auditEvidenceMatchesPolicy(
  entry: AuditEvidenceEntry,
  policy: AuditEvidencePolicyIdentity,
): boolean {
  return (
    entry.complete === true &&
    matchesDeclaredFanoutPolicy(entry, policy) &&
    entry.lenses?.length === policy.lenses.length &&
    policy.lenses.every((expected, index) => entry.lenses?.[index]?.id === expected.id)
  );
}

export function parseAuditEvidenceEntry(value: unknown): AuditEvidenceEntry | null {
  const parsed = AuditEvidenceEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function verdictLine(output: string): string {
  return output.split(/\r?\n/, 1)[0] ?? '';
}

function stripVerdictTokens(output: string): string {
  return output.replace(/VERDICT:\s*[A-Z][A-Z_]*/gu, '').trim();
}

function attributionId(lens: AuditLensVerdict, index: number): string {
  return lens.id.length <= 64 && AuditLensIdSchema.safeParse(lens.id).success
    ? lens.id
    : `lens-${String(index + 1)}`;
}

function evidenceWithinBudget(lenses: readonly AuditLensVerdict[]): boolean {
  let bytes = 0;
  for (const lens of lenses) {
    bytes += Buffer.byteLength(lens.output, 'utf8');
    if (bytes > MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES) return false;
  }
  return true;
}

function lensFindingRows(lenses: readonly AuditLensVerdict[], passLine: string): string[] {
  const ids = lenses.map(attributionId);
  return lenses.map((lens, index) => {
    if (verdictLine(lens.output) === passLine) return `- [${ids[index]!}] PASS`;
    const body = stripVerdictTokens(lens.output);
    return `- [${ids[index]!}] ${body === '' ? 'review did not return the exact pass verdict' : body}`;
  });
}

function boundedFailureAggregate(
  failVerdict: string,
  rows: readonly string[],
  boundedFallbackRows: readonly string[],
): string {
  const aggregate = [`VERDICT: ${failVerdict}`, ...rows].join('\n');
  return Buffer.byteLength(aggregate, 'utf8') <= MAX_SUBAGENT_RESULT_BYTES
    ? aggregate
    : [`VERDICT: ${failVerdict}`, ...boundedFallbackRows].join('\n');
}

/** Pure, defensive projection. Empty/reduced evidence can never pass vacuously. */
export function aggregateAuditLenses(
  lenses: readonly AuditLensVerdict[],
  passVerdict: string,
  failVerdict: string,
): string {
  if (
    !AuditVerdictTokenSchema.safeParse(passVerdict).success ||
    !AuditVerdictTokenSchema.safeParse(failVerdict).success ||
    !distinctAuditVerdicts(passVerdict, failVerdict)
  ) {
    return 'VERDICT: UNRESOLVED\n- [audit] invalid pass/fail verdict policy';
  }
  const passLine = `VERDICT: ${passVerdict}`;
  if (lenses.length < AUDIT_LENS_MIN || lenses.length > AUDIT_LENS_MAX) {
    if (lenses.length === 0) {
      return `VERDICT: ${failVerdict}\n- [audit] invalid lens evidence count (0 completed; expected ${String(AUDIT_LENS_MIN)}-${String(AUDIT_LENS_MAX)})`;
    }
    const defensivelyAttributed = lenses.slice(0, 256);
    const defensiveIds = defensivelyAttributed.map(attributionId);
    const omitted = lenses.length - defensivelyAttributed.length;
    const suffix =
      omitted === 0 ? [] : [`- [audit] ${String(omitted)} additional invalid lenses omitted`];
    const fallbackRows = [
      ...defensiveIds.map(
        (id) =>
          `- [${id}] invalid lens-set evidence (expected ${String(AUDIT_LENS_MIN)}-${String(AUDIT_LENS_MAX)})`,
      ),
      ...suffix,
    ];
    if (!evidenceWithinBudget(defensivelyAttributed)) {
      return [`VERDICT: ${failVerdict}`, ...fallbackRows].join('\n');
    }
    return boundedFailureAggregate(
      failVerdict,
      [...lensFindingRows(defensivelyAttributed, passLine), ...suffix],
      fallbackRows,
    );
  }
  const parsedIds = lenses.map((lens) => AuditLensIdSchema.safeParse(lens.id));
  const ids = lenses.map(attributionId);
  if (
    parsedIds.some((parsed) => !parsed.success) ||
    new Set(parsedIds.flatMap((parsed) => (parsed.success ? [parsed.data] : []))).size !==
      lenses.length
  ) {
    return [
      `VERDICT: ${failVerdict}`,
      ...ids.map((id) => `- [${id}] invalid or duplicate lens id`),
    ].join('\n');
  }
  if (!evidenceWithinBudget(lenses)) {
    return [
      `VERDICT: ${failVerdict}`,
      ...ids.map((id) => `- [${id}] audit output exceeded aggregate evidence bound`),
    ].join('\n');
  }
  if (lenses.every((lens) => verdictLine(lens.output) === passLine)) {
    return `${passLine}\nAUDIT FAN-OUT: ${ids.join(', ')} (${String(lenses.length)}/${String(lenses.length)})`;
  }
  return boundedFailureAggregate(
    failVerdict,
    lensFindingRows(lenses, passLine),
    ids.map((id) => `- [${id}] audit output exceeded aggregate evidence bound`),
  );
}

/** One shared read-time interpretation for primitive hits, lifecycle guards, and commit gate. */
/** Exact semantic pass check: a failure token that happens to spell GUESS_FREE can never authorize. */
export function auditVerdictMatchesPass(
  verdict: string | null | undefined,
  passVerdict: string,
): boolean {
  const parsed = AuditVerdictTokenSchema.safeParse(passVerdict);
  return parsed.success && verdict?.split(/\r?\n/u, 1)[0] === `VERDICT: ${parsed.data}`;
}

export function deriveAuditEvidenceVerdict(entry: AuditEvidenceEntry): string | undefined {
  if (entry.verdict !== undefined) return entry.verdict;
  if (
    entry.complete === true &&
    entry.lenses !== undefined &&
    entry.passVerdict !== undefined &&
    entry.failVerdict !== undefined
  ) {
    return aggregateAuditLenses(entry.lenses, entry.passVerdict, entry.failVerdict);
  }
  if (entry.failures !== undefined && entry.failures.length > 0) {
    const passVerdict = entry.passVerdict ?? 'GUESS_FREE';
    const failVerdict = entry.failVerdict ?? 'UNRESOLVED';
    const completed = entry.lenses ?? [];
    const rows = [
      ...lensFindingRows(completed, `VERDICT: ${passVerdict}`),
      ...entry.failures.map((failure) => `- [${failure.id}] ${failure.error}`),
    ];
    const fallbackRows = [
      ...completed.map(
        (lens, index) =>
          `- [${attributionId(lens, index)}] ${verdictLine(lens.output) === `VERDICT: ${passVerdict}` ? 'PASS' : 'completed review did not return the exact pass verdict'}`,
      ),
      ...entry.failures.map((failure) => `- [${failure.id}] reviewer failed`),
    ];
    return boundedFailureAggregate(failVerdict, rows, fallbackRows);
  }
  return undefined;
}
