import { z } from 'zod';

import { loadModelsConfig } from '../models/load_config.js';
import type { ModelsConfig } from '../packs/schemas/models.js';
import { recordSubagentDrifts } from '../runtime/drift_catalog.js';
import { err, ok } from '../runtime/result.js';
import type { FunctionRegistry } from './registry.js';

export interface SubagentDrift {
  timestamp?: string;
  pack?: string;
  ruleId?: string;
  level?: string;
  message?: string;
}

export interface SubagentSdkRunResult {
  text: string;
  drifts?: SubagentDrift[];
}

export interface SubagentSdk {
  runAgent: (opts: {
    model: string;
    prompt: string;
    context: Record<string, unknown>;
    packModels?: ModelsConfig;
  }) => Promise<SubagentSdkRunResult>;
}

const SpawnSubagentArgs = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  context: z
    .object({
      project: z.string().optional(),
      profession: z.string().optional(),
    })
    .strict()
    .optional(),
});

export interface SpawnSubagentResult {
  stdout: string;
  drifts: SubagentDrift[];
}

function textFromSdkMessage(message: unknown): string {
  if (message === null || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  if (record.type === 'result' && typeof record.result === 'string') return record.result;
  if (
    record.type !== 'assistant' ||
    record.message === null ||
    typeof record.message !== 'object'
  ) {
    return '';
  }
  const content = (record.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? (block as { text?: unknown }).text
        : undefined,
    )
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

async function resolveSdkModelAlias(
  model: string,
  packModels?: ModelsConfig,
): Promise<{ model?: string }> {
  const aliases = await loadModelsConfig(packModels);
  const alias = aliases[model];
  if (alias === undefined) return { model };
  if (alias.mode !== 'subscription') {
    throw new Error(`spawn_subagent: model alias ${model} is not a subscription alias`);
  }
  const resolvedModel = alias.model?.trim();
  return resolvedModel === undefined || resolvedModel === '' ? {} : { model: resolvedModel };
}

async function loadSdk(): Promise<SubagentSdk> {
  const moduleName = '@anthropic-ai/claude-agent-sdk';
  const mod = (await import(/* @vite-ignore */ moduleName)) as {
    query: (input: {
      prompt: string;
      options?: { cwd?: string; model?: string };
    }) => AsyncIterable<unknown> & { close?: () => void };
  };
  return {
    runAgent: async ({ model, prompt, context, packModels }) => {
      const selection = await resolveSdkModelAlias(model, packModels);
      const cwd =
        typeof context.project === 'string' && context.project.trim() !== ''
          ? context.project
          : process.cwd();
      const query = mod.query({
        prompt,
        options: {
          cwd,
          ...(selection.model === undefined ? {} : { model: selection.model }),
        },
      });
      let text = '';
      const errors: string[] = [];
      try {
        for await (const message of query) {
          const sdkError = sdkResultError(message);
          if (sdkError !== null) {
            errors.push(sdkError);
            continue;
          }
          const next = textFromSdkMessage(message);
          if (next !== '') text = next;
        }
      } finally {
        query.close?.();
      }
      if (errors.length > 0) {
        throw new Error(errors.join('; '));
      }
      return { text, drifts: [] };
    },
  };
}

function sdkResultError(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  if (record.type !== 'result') return null;
  const subtype = typeof record.subtype === 'string' ? record.subtype : undefined;
  if (record.is_error !== true && !subtype?.startsWith('error_')) {
    return null;
  }
  const messages = Array.isArray(record.errors)
    ? record.errors.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
      )
    : [];
  if (typeof record.result === 'string' && record.result.trim() !== '')
    messages.push(record.result);
  if (typeof record.error === 'string' && record.error.trim() !== '') messages.push(record.error);
  return messages.length > 0 ? messages.join('; ') : (subtype ?? 'Claude Agent SDK result error');
}

function generateSubagentId(): string {
  return `subagent-${Math.random().toString(36).slice(2, 10)}`;
}

export interface RegisterSubagentOptions {
  sdk?: SubagentSdk;
  subagentIdFactory?: () => string;
}

export function registerSubagentFunction(
  registry: FunctionRegistry,
  opts: RegisterSubagentOptions = {},
): void {
  registry.register({
    name: 'spawn_subagent',
    argSchema: SpawnSubagentArgs,
    durable: true,
    memoizable: false,
    costEstimateMs: 30_000,
    execute: async ({ model, prompt, context }, ctx) => {
      let sdk: SubagentSdk;
      try {
        sdk = opts.sdk ?? (await loadSdk());
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `spawn_subagent: failed to load SDK: ${String(e)}`,
          cause: e,
        });
      }

      let sdkResult: SubagentSdkRunResult;
      try {
        sdkResult = await sdk.runAgent({
          model,
          prompt,
          context: context ?? {},
          ...(ctx.packModels === undefined ? {} : { packModels: ctx.packModels }),
        });
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `spawn_subagent: SDK run failed: ${String(e)}`,
          cause: e,
        });
      }

      const result: SpawnSubagentResult = {
        stdout: sdkResult.text,
        drifts: sdkResult.drifts ?? [],
      };
      const subagentId = (opts.subagentIdFactory ?? generateSubagentId)();
      const professionPack = context?.profession ?? '<unspecified>';
      try {
        await recordSubagentDrifts(ctx.sessionId, subagentId, professionPack, result.drifts);
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `spawn_subagent: drift roll-up failed: ${String(e)}`,
          cause: e,
        });
      }

      return ok(result);
    },
  });
}
