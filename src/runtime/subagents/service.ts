import {
  MAX_SUBAGENT_AGGREGATE_RESULT_DETAILS_BYTES,
  MAX_SUBAGENT_AGGREGATE_TASK_BYTES,
  MAX_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_RESULT_BYTES,
  MAX_SUBAGENT_RESULT_DETAILS_BYTES,
  MAX_SUBAGENT_TASK_BYTES,
  MAX_SUBAGENT_TASKS,
  type RoleManifest,
  type SubagentBatchResult,
  type SubagentLauncher,
  type SubagentTask,
  type ValidatedSubagentTask,
} from './types.js';
import { type RoleFsDeps, validateTaskAgainstManifest } from './roles.js';
import { assertUtf8Limit, runBounded, truncateUtf8, utf8Bytes } from './supervisor.js';

export interface SubagentServiceLimits {
  readonly maxTasks: typeof MAX_SUBAGENT_TASKS;
  readonly maxConcurrency: typeof MAX_SUBAGENT_CONCURRENCY;
  readonly maxResultBytes: number;
  readonly maxTaskBytes: number;
  readonly maxAggregateTaskBytes: number;
  readonly maxResultDetailsBytes: number;
  readonly maxAggregateResultDetailsBytes: number;
}

function serializeDetails(details: unknown): string | undefined {
  if (details === undefined) return undefined;
  try {
    const serialized = JSON.stringify(details);
    if (serialized === undefined) {
      throw new Error('JSON.stringify(details) returned undefined');
    }
    return serialized;
  } catch (error) {
    throw new Error(
      `subagent result details must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertSerializedDetailsLimit(details: unknown, maxBytes: number): void {
  const serialized = serializeDetails(details);
  if (serialized === undefined) return;
  assertUtf8Limit(serialized, maxBytes, 'subagent result details');
}

export class SubagentService<TDetails = unknown> {
  constructor(
    private readonly manifest: RoleManifest,
    private readonly projectRoot: string,
    private readonly launcher: SubagentLauncher<TDetails>,
    private readonly limits: SubagentServiceLimits = {
      maxTasks: MAX_SUBAGENT_TASKS,
      maxConcurrency: MAX_SUBAGENT_CONCURRENCY,
      maxResultBytes: MAX_SUBAGENT_RESULT_BYTES,
      maxTaskBytes: MAX_SUBAGENT_TASK_BYTES,
      maxAggregateTaskBytes: MAX_SUBAGENT_AGGREGATE_TASK_BYTES,
      maxResultDetailsBytes: MAX_SUBAGENT_RESULT_DETAILS_BYTES,
      maxAggregateResultDetailsBytes: MAX_SUBAGENT_AGGREGATE_RESULT_DETAILS_BYTES,
    },
    private readonly roleFs: RoleFsDeps | undefined = undefined,
    private readonly manifestPath: string | undefined = undefined,
  ) {}

  async single(task: SubagentTask, signal: AbortSignal): Promise<SubagentBatchResult<TDetails>> {
    return this.parallel([task], signal);
  }

  async parallel(
    tasks: readonly SubagentTask[],
    signal: AbortSignal,
  ): Promise<SubagentBatchResult<TDetails>> {
    if (tasks.length === 0) throw new Error('spawn_subagent requires at least one task');
    if (tasks.length > this.limits.maxTasks) {
      throw new Error(`spawn_subagent supports at most ${String(this.limits.maxTasks)} tasks`);
    }
    const aggregateTaskBytes = tasks.reduce((total, task) => total + utf8Bytes(task.task), 0);
    if (aggregateTaskBytes > this.limits.maxAggregateTaskBytes) {
      throw new Error(
        `subagent aggregate input exceeded ${String(this.limits.maxAggregateTaskBytes)} bytes (${String(aggregateTaskBytes)})`,
      );
    }
    const validated = await Promise.all(
      tasks.map(async (task) => {
        assertUtf8Limit(task.task, this.limits.maxTaskBytes, 'subagent task');
        return validateTaskAgainstManifest(
          this.manifest,
          this.projectRoot,
          task,
          this.roleFs,
          this.manifestPath,
        );
      }),
    );
    const batch = await runBounded(validated, this.limits.maxConcurrency, signal, (task, inner) =>
      this.runValidated(task, inner),
    );
    const aggregateDetailBytes = batch.results.reduce((total, result) => {
      const serialized = serializeDetails(result.details);
      return serialized === undefined ? total : total + utf8Bytes(serialized);
    }, 0);
    if (aggregateDetailBytes > this.limits.maxAggregateResultDetailsBytes) {
      throw new Error(
        `subagent aggregate result details exceeded ${String(this.limits.maxAggregateResultDetailsBytes)} bytes (${String(aggregateDetailBytes)})`,
      );
    }
    return batch;
  }

  private async runValidated(
    task: ValidatedSubagentTask,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<SubagentLauncher<TDetails>['run']>>> {
    const result = await this.launcher.run(task, signal);
    assertSerializedDetailsLimit(result.details, this.limits.maxResultDetailsBytes);
    return Object.freeze({
      ...result,
      text: truncateUtf8(result.text, this.limits.maxResultBytes),
    });
  }
}
