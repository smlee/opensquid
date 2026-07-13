/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from 'vitest';

import { SubagentService } from './service.js';
import { renderSubagentRoleMarkdown } from './role_markdown.js';
import { sha256Hex } from './roles.js';
import type { RoleManifest, SubagentRunResult, ValidatedSubagentTask } from './types.js';
import {
  MAX_SUBAGENT_AGGREGATE_TASK_BYTES,
  MAX_SUBAGENT_RESULT_BYTES,
  MAX_SUBAGENT_RESULT_DETAILS_BYTES,
} from './types.js';
import { SubagentAbortError } from './supervisor.js';

const role = {
  name: 'scope-architect',
  pack: 'source-pack',
  generatedName: 'opensquid-source-pack-scope-architect',
  description: 'scope',
  systemPrompt: 'prompt',
  tools: ['read', 'bash', 'grep', 'write', 'workgraph_get', 'recall', 'read_state', 'web_fetch'],
  model: 'reasoning',
  filePath: '/pi-agent/agents/opensquid-source-pack-scope-architect.md',
  contentHash: sha256Hex(''),
};
const manifest: RoleManifest = {
  version: 1,
  generatedBy: 'opensquid',
  roles: [
    {
      ...role,
      contentHash: sha256Hex(renderSubagentRoleMarkdown(role)),
    },
  ],
};

const roleFs = {
  readText: async () => renderSubagentRoleMarkdown(role),
  realpath: async (path: string) => path,
};
const manifestPath = '/pi-agent/opensquid-subagent-roles.json';

describe('SubagentService', () => {
  it('enforces the exact 8-task bound, aggregate input bound, and caps result bytes', async () => {
    const service = new SubagentService(
      manifest,
      '/repo',
      {
        run: async (input): Promise<SubagentRunResult> => ({
          role: input.role.name,
          text: 'x'.repeat(MAX_SUBAGENT_RESULT_BYTES + 100),
          isError: false,
        }),
      },
      undefined,
      roleFs,
      manifestPath,
    );
    const ok = await service.parallel(
      Array.from({ length: 8 }, () => ({ role: 'scope-architect', task: 'do work' })),
      new AbortController().signal,
    );
    expect(ok.results).toHaveLength(8);
    expect(Buffer.byteLength(ok.results[0]!.text, 'utf8')).toBeLessThanOrEqual(
      MAX_SUBAGENT_RESULT_BYTES,
    );

    await expect(
      service.parallel(
        Array.from({ length: 9 }, () => ({ role: 'scope-architect', task: 'do work' })),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/at most 8 tasks/);

    await expect(
      service.parallel(
        [{ role: 'scope-architect', task: 'x'.repeat(MAX_SUBAGENT_AGGREGATE_TASK_BYTES + 1) }],
        new AbortController().signal,
      ),
    ).rejects.toThrow(/aggregate input exceeded/);
  });

  it('limits concurrency to four workers', async () => {
    let running = 0;
    let peak = 0;
    const service = new SubagentService(
      manifest,
      '/repo',
      {
        run: async (input: ValidatedSubagentTask): Promise<SubagentRunResult> => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
          return { role: input.role.name, text: input.task, isError: false };
        },
      },
      undefined,
      roleFs,
      manifestPath,
    );
    await expect(
      service.parallel(
        Array.from({ length: 8 }, (_, index) => ({
          role: 'scope-architect',
          task: `task-${index}`,
        })),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ results: expect.any(Array) });
    expect(peak).toBe(4);
  });

  it('propagates cancellation, surfaces a spontaneous SubagentAbortError as the first error, aborts siblings on throw, and bounds details', async () => {
    const controller = new AbortController();
    controller.abort();
    const service = new SubagentService(
      manifest,
      '/repo',
      {
        run: async () => ({ role: 'scope-architect', text: 'x', isError: false }),
      },
      undefined,
      roleFs,
      manifestPath,
    );
    await expect(
      service.parallel([{ role: 'scope-architect', task: 'do work' }], controller.signal),
    ).rejects.toBeInstanceOf(SubagentAbortError);

    const spontaneousAbort = new SubagentService(
      manifest,
      '/repo',
      {
        run: async () => {
          throw new SubagentAbortError('launcher aborted unexpectedly');
        },
      },
      undefined,
      roleFs,
      manifestPath,
    );
    await expect(
      spontaneousAbort.parallel(
        [{ role: 'scope-architect', task: 'do work' }],
        new AbortController().signal,
      ),
    ).rejects.toThrow(/launcher aborted unexpectedly/);

    const siblingSignals: AbortSignal[] = [];
    const throwingService = new SubagentService(
      manifest,
      '/repo',
      {
        run: async (
          _input: ValidatedSubagentTask,
          signal: AbortSignal,
        ): Promise<SubagentRunResult> => {
          siblingSignals.push(signal);
          if (siblingSignals.length === 1) throw new Error('boom');
          await new Promise((resolve) => setTimeout(resolve, 0));
          throwIfAborted(signal);
          return { role: 'scope-architect', text: 'x', isError: false };
        },
      },
      undefined,
      roleFs,
      manifestPath,
    );
    await expect(
      throwingService.parallel(
        [
          { role: 'scope-architect', task: 'one' },
          { role: 'scope-architect', task: 'two' },
        ],
        new AbortController().signal,
      ),
    ).rejects.toThrow(/boom/);
    expect(siblingSignals[1]?.aborted).toBe(true);

    const detailService = new SubagentService(
      manifest,
      '/repo',
      {
        run: async () => ({
          role: 'scope-architect',
          text: 'x',
          isError: false,
          details: { blob: 'x'.repeat(MAX_SUBAGENT_RESULT_DETAILS_BYTES + 1) },
        }),
      },
      undefined,
      roleFs,
      manifestPath,
    );
    await expect(
      detailService.parallel(
        [{ role: 'scope-architect', task: 'ok' }],
        new AbortController().signal,
      ),
    ).rejects.toThrow(/result details exceeded/);
  });

  it('fails clearly when result details stringify to undefined', async () => {
    const service = new SubagentService(
      manifest,
      '/repo',
      {
        run: async () => ({
          role: 'scope-architect',
          text: 'x',
          isError: false,
          details: { toJSON: () => undefined },
        }),
      },
      undefined,
      roleFs,
      manifestPath,
    );
    await expect(
      service.parallel([{ role: 'scope-architect', task: 'ok' }], new AbortController().signal),
    ).rejects.toThrow(/JSON\.stringify\(details\) returned undefined/);
  });
});

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SubagentAbortError();
}
