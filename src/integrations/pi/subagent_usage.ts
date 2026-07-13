import { z } from 'zod';

const ControlOutcomeSchema = z
  .object({
    kind: z.enum(['PROCESS_PAUSED', 'CANCELLED_BY_HUMAN']),
    executorId: z.string().min(1),
    action: z.enum(['graceful_stop', 'terminate', 'force_kill']),
    actionId: z.string().min(1),
  })
  .strict();

const ChildResultSchema = z
  .object({
    role: z.string().min(1),
    text: z.string(),
    isError: z.boolean(),
    controlOutcome: ControlOutcomeSchema.optional(),
  })
  .strict();

export const OpenSquidSubagentUsageSchema = z
  .object({
    version: z.literal(1),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .strict();

export type OpenSquidSubagentUsageV1 = z.infer<typeof OpenSquidSubagentUsageSchema>;

export const PiSubagentChildDetailsSchema = z
  .object({
    usage: OpenSquidSubagentUsageSchema,
  })
  .strict();

export type PiSubagentChildDetails = z.infer<typeof PiSubagentChildDetailsSchema>;

export const SpawnSubagentDetailsSchema = z
  .object({
    results: z.array(ChildResultSchema),
    opensquidSubagentUsage: OpenSquidSubagentUsageSchema,
    controlOutcome: ControlOutcomeSchema.optional(),
  })
  .strict();

export type SpawnSubagentDetails = z.infer<typeof SpawnSubagentDetailsSchema>;

export function decodeSubagentUsage(details: unknown): OpenSquidSubagentUsageV1 | null {
  const parsed = SpawnSubagentDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.opensquidSubagentUsage : null;
}

export function decodeSubagentControlOutcome(
  details: unknown,
): z.infer<typeof ControlOutcomeSchema> | null {
  const parsed = SpawnSubagentDetailsSchema.safeParse(details);
  return parsed.success ? (parsed.data.controlOutcome ?? null) : null;
}

export function decodeChildRunDetails(details: unknown): PiSubagentChildDetails | null {
  const parsed = PiSubagentChildDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
}

export function decodeChildRunUsage(details: unknown): OpenSquidSubagentUsageV1 | null {
  const child = decodeChildRunDetails(details);
  if (child !== null) return child.usage;
  const legacy = OpenSquidSubagentUsageSchema.safeParse(details);
  return legacy.success ? legacy.data : null;
}
