import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ExtensionAPI } from './protocol.js';
import { z } from 'zod';

import { loadModelsConfig } from '../../models/load_config.js';
import { resolveProjectRoot } from '../../runtime/paths.js';
import { loadVerifiedRoleManifest } from '../../runtime/subagents/roles.js';
import { SubagentService } from '../../runtime/subagents/service.js';
import { DEFAULT_SUBAGENT_TIMEOUT_MS, RoleManifestSchema } from '../../runtime/subagents/types.js';
import { SubagentAbortError, truncateUtf8 } from '../../runtime/subagents/supervisor.js';
import { PI_CLI_ENV, readPiExecutorWallClockMs, readPiRoleManifestEnv } from './env.js';
import { createDefaultPiHarnessRuntimeAssets } from './runtime.js';
import {
  PiSubagentLauncher,
  spawnSubagentDetails,
  usageFromResults,
} from './pi_subagent_launcher.js';

const MAX_CONTENT_BYTES = 50 * 1024;

const TaskSchema = z
  .object({
    role: z.string().min(1),
    task: z.string().min(1),
    cwd: z.string().min(1).optional(),
  })
  .strict();
const ParamsSchema = z
  .object({
    role: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    tasks: z.array(TaskSchema).min(1).max(8).optional(),
  })
  .strict();

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: {
      type: 'string',
      minLength: 1,
      description: 'Generated OpenSquid role name for single execution',
    },
    task: { type: 'string', minLength: 1, description: 'Delegated task for single execution' },
    cwd: { type: 'string', minLength: 1, description: 'Optional cwd relative to the project root' },
    tasks: {
      type: 'array',
      maxItems: 8,
      minItems: 1,
      description: 'Parallel tasks to run with bounded concurrency',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          role: { type: 'string', minLength: 1 },
          task: { type: 'string', minLength: 1 },
          cwd: { type: 'string', minLength: 1 },
        },
        required: ['role', 'task'],
      },
    },
  },
} as const;

function availableRoleDescription(env: NodeJS.ProcessEnv): string {
  try {
    const { manifestPath, manifestHash } = readPiRoleManifestEnv(env);
    const text = readFileSync(manifestPath, 'utf8');
    if (createHash('sha256').update(text).digest('hex') !== manifestHash) return '';
    const manifest = RoleManifestSchema.parse(JSON.parse(text) as unknown);
    return ` Available roles: ${manifest.roles.map((role) => role.name).join(', ')}.`;
  } catch {
    return '';
  }
}

function renderParallelSummary(
  results: readonly { role: string; text: string; isError: boolean }[],
): string {
  return results
    .map((result) => `### ${result.role} ${result.isError ? '(error)' : '(ok)'}\n\n${result.text}`)
    .join('\n\n---\n\n');
}

export default function opensquidSpawnSubagent(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'spawn_subagent',
    label: 'Spawn Subagent',
    description:
      'Delegate one generated OpenSquid role or a bounded parallel batch of generated roles. Only generated manifest roles are allowed.' +
      availableRoleDescription(process.env),
    parameters: PARAMETERS,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const parsed = ParamsSchema.safeParse(rawParams);
      if (!parsed.success) {
        return {
          content: [
            { type: 'text', text: `spawn_subagent: invalid args: ${parsed.error.message}` },
          ],
          details: {},
          isError: true,
        };
      }
      const params = parsed.data;
      const singleRequested =
        params.role !== undefined || params.task !== undefined || params.cwd !== undefined;
      const parallelRequested = params.tasks !== undefined;
      if (Number(singleRequested) + Number(parallelRequested) !== 1) {
        return {
          content: [
            {
              type: 'text',
              text: 'spawn_subagent: provide either { role, task } or { tasks: [...] }, but not both',
            },
          ],
          details: {},
          isError: true,
        };
      }
      if (params.tasks === undefined && (params.role === undefined || params.task === undefined)) {
        return {
          content: [
            { type: 'text', text: 'spawn_subagent: single execution requires both role and task' },
          ],
          details: {},
          isError: true,
        };
      }
      const cli = process.env[PI_CLI_ENV]?.trim();
      if (!cli) {
        return {
          content: [{ type: 'text', text: `spawn_subagent: ${PI_CLI_ENV} is required` }],
          details: {},
          isError: true,
        };
      }

      const projectRoot = await resolveProjectRoot(ctx.cwd);
      if (projectRoot === null) {
        return {
          content: [{ type: 'text', text: 'spawn_subagent: project root is unavailable' }],
          details: {},
          isError: true,
        };
      }

      const abort = signal ?? new AbortController().signal;

      try {
        const runtime = createDefaultPiHarnessRuntimeAssets({ env: process.env });
        const { manifestPath, manifestHash } = readPiRoleManifestEnv(process.env);
        const manifest = await loadVerifiedRoleManifest(manifestPath, manifestHash);
        const modelAliasesByRole = new Map(
          await Promise.all(
            manifest.roles.map(
              async (role) =>
                [role.generatedName, await loadModelsConfig(role.packModels)] as const,
            ),
          ),
        );
        const launcher = new PiSubagentLauncher(
          {
            cli,
            modelAliasesByRole,
            systemPromptPath: runtime.systemPromptPath,
            adapterExtensionPath: runtime.mcpAdapterExtensionPath,
            projectorExtensionPath: runtime.projectorExtensionPath,
            timeoutMs: readPiExecutorWallClockMs(process.env, DEFAULT_SUBAGENT_TIMEOUT_MS),
            // One logical executor is a bounded fresh-context Ralph loop, not a one-shot Pi subprocess.
            // Core supervision owns the limits; selected packs decide when a lap may report SHIPPED.
            executorLoop: {},
            onStderrLine: ({ childId, role, line }) => {
              process.stderr.write(`[executor ${role} · ${childId}] ${line}\n`);
            },
          },
          process.env,
        );
        const service = new SubagentService(
          manifest,
          projectRoot,
          launcher,
          undefined,
          undefined,
          manifestPath,
        );
        const batch =
          params.tasks !== undefined
            ? await service.parallel(params.tasks, abort)
            : await service.single(
                {
                  role: params.role!,
                  task: params.task!,
                  ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
                },
                abort,
              );
        const usage = usageFromResults(batch.results);
        const details = spawnSubagentDetails({
          results: batch.results.map((result) => ({
            role: result.role,
            text: result.text,
            isError: result.isError,
            ...(result.controlOutcome === undefined
              ? {}
              : { controlOutcome: result.controlOutcome }),
          })),
          usage,
        });
        const isError =
          params.tasks === undefined
            ? batch.results[0]?.isError === true
            : batch.results.every((result) => result.isError);
        return {
          content: [
            {
              type: 'text',
              text: truncateUtf8(
                params.tasks === undefined
                  ? (batch.results[0]?.text ?? '')
                  : renderParallelSummary(batch.results),
                MAX_CONTENT_BYTES,
              ),
            },
          ],
          details,
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        if (error instanceof SubagentAbortError) throw error;
        return {
          content: [
            {
              type: 'text',
              text: truncateUtf8(
                error instanceof Error ? error.message : String(error),
                MAX_CONTENT_BYTES,
              ),
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}
