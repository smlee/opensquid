import { z } from 'zod';

import { ModelsConfig } from '../../packs/schemas/models.js';

export const MAX_SUBAGENT_TASKS = 8 as const;
export const MAX_SUBAGENT_CONCURRENCY = 4 as const;
export const MAX_SUBAGENT_RESULT_BYTES = 50 * 1024;
export const MAX_SUBAGENT_TASK_BYTES = 50 * 1024;
export const MAX_SUBAGENT_AGGREGATE_TASK_BYTES = MAX_SUBAGENT_TASK_BYTES * MAX_SUBAGENT_TASKS;
export const MAX_SUBAGENT_RESULT_DETAILS_BYTES = 8 * 1024;
export const MAX_SUBAGENT_AGGREGATE_RESULT_DETAILS_BYTES =
  MAX_SUBAGENT_RESULT_DETAILS_BYTES * MAX_SUBAGENT_TASKS;
export const MAX_SUBAGENT_CAPTURE_BYTES = 256 * 1024;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;

export const SubagentRoleSchema = z
  .object({
    name: z.string().min(1),
    pack: z.string().min(1),
    generatedName: z.string().min(1),
    description: z.string().min(1),
    systemPrompt: z.string().min(1),
    tools: z.array(z.string().min(1)).min(1),
    model: z.string().min(1).optional(),
    packModels: ModelsConfig.optional(),
    filePath: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SubagentRole = z.infer<typeof SubagentRoleSchema>;

export const RoleManifestSchema = z
  .object({
    version: z.literal(1),
    generatedBy: z.literal('opensquid'),
    roles: z.array(SubagentRoleSchema).min(1),
  })
  .strict();
export type RoleManifest = z.infer<typeof RoleManifestSchema>;

export const SubagentTaskSchema = z
  .object({
    role: z.string().min(1),
    task: z.string().min(1),
    cwd: z.string().min(1).optional(),
  })
  .strict();
export type SubagentTask = z.infer<typeof SubagentTaskSchema>;

export interface ValidatedSubagentTask {
  readonly role: SubagentRole;
  readonly task: string;
  readonly cwd: string;
}

export interface SubagentControlOutcome {
  readonly kind: 'PROCESS_PAUSED' | 'CANCELLED_BY_HUMAN';
  readonly executorId: string;
  readonly action: 'graceful_stop' | 'terminate' | 'force_kill';
  readonly actionId: string;
}

export interface SubagentRunResult<TDetails = unknown> {
  readonly role: string;
  readonly text: string;
  readonly isError: boolean;
  /** Trusted launcher result propagated out-of-band from model-authored text. */
  readonly controlOutcome?: SubagentControlOutcome;
  readonly details?: TDetails;
}

export interface SubagentBatchResult<TDetails = unknown> {
  readonly results: readonly SubagentRunResult<TDetails>[];
}

export interface SubagentLauncher<TDetails = unknown> {
  run(input: ValidatedSubagentTask, signal: AbortSignal): Promise<SubagentRunResult<TDetails>>;
}
