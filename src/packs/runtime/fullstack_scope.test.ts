import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClient } from '@libsql/client';
import { describe, expect, it, vi } from 'vitest';

import { FunctionRegistry } from '../../functions/registry.js';
import { loadPackV2 } from '../loader_v2.js';
import { CheckpointStore } from '../../runtime/durable/checkpoint_store.js';
import type { FsmStateFile } from '../../runtime/fsm_state.js';
import type { ActiveTask, ActiveTaskRead } from '../../runtime/session_state.js';
import type { Issue } from '../../workgraph/types.js';
import {
  classifyKnownEntry,
  createFullstackScopeCommand,
  fullstackScopeCommand,
  decideFullstackScopeWrite,
  parseFullstackScope,
  registerFullstackScopeEntry,
  resolveFullstackScopeEngagement,
  stepScopeEntryAttempt,
  type FullstackScopeDeps,
  type FullstackScopePolicy,
  type ScopeEntryAttempt,
  type ScopeEntryAttemptEvent,
} from './fullstack_scope.js';

const NOW = '2026-07-18T00:00:00.000Z';
const ITEM = 'wg-123456789abc';

const issue = (id = ITEM, status: Issue['status'] = 'open', title = 'Ship exact scope'): Issue => ({
  id,
  title,
  body: '',
  status,
  createdAt: NOW,
  updatedAt: NOW,
});

const policy: FullstackScopePolicy = {
  packId: 'fullstack-flow',
  initial: 'scope',
  states: new Set(['scope', 'scope_write', 'plan', 'author', 'code']),
  writes: (stage) => {
    if (stage === 'scope' || stage === 'scope_write') {
      return ['docs/research/*pre-research*'];
    }
    return stage === 'code' ? ['**'] : ['docs/**'];
  },
};

function harness(overrides: Partial<FullstackScopeDeps> = {}) {
  const issues = new Map<string, Issue>();
  const checkpoints = new Map<string, { stage: string; scopeArtifacts: string[] }>();
  const active = new Map<string, ActiveTaskRead>();
  const projections = new Map<string, FsmStateFile>();
  let createCount = 0;

  const writeActiveTask = vi.fn((sid: string, task: ActiveTask) => {
    active.set(sid, { kind: 'present', task });
    return Promise.resolve();
  });
  const deps: FullstackScopeDeps = {
    resolvePolicy: () => Promise.resolve(policy),
    openWorkGraph: () =>
      Promise.resolve({
        createIssue: ({ title }: { title: string }) => {
          createCount += 1;
          const created = issue(ITEM, 'open', title);
          issues.set(created.id, created);
          return Promise.resolve(created);
        },
        getIssue: (id: string) => Promise.resolve(issues.get(id) ?? null),
      }),
    readCheckpoint: (_cwd: string, id: string) => Promise.resolve(checkpoints.get(id) ?? null),
    createCheckpoint: (_cwd: string, id: string, stage: string) => {
      if (!checkpoints.has(id)) checkpoints.set(id, { stage, scopeArtifacts: [] });
      return Promise.resolve();
    },
    readActiveTask: (sid: string) =>
      Promise.resolve(active.get(sid) ?? ({ kind: 'absent' } as const)),
    writeActiveTask,
    recordSessionCwd: () => Promise.resolve(),
    initializeV2Cartridges: (sid: string) => {
      projections.set(`${sid}:${ITEM}`, {
        state: 'scope',
        started_at: NOW,
        history: [{ state: 'scope', at: NOW }],
      });
      return Promise.resolve();
    },
    readProjection: (sid: string, _pack: string, itemId: string) =>
      Promise.resolve(projections.get(`${sid}:${itemId}`) ?? null),
    buildContext: () => Promise.resolve('EXISTING SCOPE CONTEXT'),
    now: () => NOW,
    ...overrides,
  };

  return {
    deps,
    issues,
    checkpoints,
    active,
    projections,
    writeActiveTask,
    createCount: () => createCount,
  };
}

describe('parseFullstackScope', () => {
  it('recognizes only the two strict pack-owned forms', () => {
    expect(parseFullstackScope('/scope preserve  "exact"  bytes')).toEqual({
      kind: 'request',
      request: { kind: 'create', title: 'preserve  "exact"  bytes' },
    });
    expect(parseFullstackScope(`/scope --item ${ITEM}`)).toEqual({
      kind: 'request',
      request: { kind: 'select', itemId: ITEM },
    });
    expect(parseFullstackScope('/scope')).toMatchObject({ kind: 'invalid' });
    expect(parseFullstackScope(`/scope --item ${ITEM} extra`)).toMatchObject({ kind: 'invalid' });
    expect(parseFullstackScope('/scope --item wg-not-an-id')).toMatchObject({ kind: 'invalid' });
    expect(parseFullstackScope('/scope-done x y')).toEqual({ kind: 'ignored' });
    expect(parseFullstackScope('/scopex x')).toEqual({ kind: 'ignored' });
    expect(parseFullstackScope('ordinary prompt')).toEqual({ kind: 'ignored' });
  });
});

describe('scope entry state classifiers', () => {
  it('classifies checkpoint, active-task, and projection without inventing another authority', () => {
    const present = (id = ITEM): ActiveTaskRead => ({
      kind: 'present',
      task: { id, subject: id, started_at: NOW },
    });
    expect(
      classifyKnownEntry(issue(), null, { kind: 'absent' }, { kind: 'absent' }, policy),
    ).toEqual({
      kind: 'item_only',
    });
    expect(
      classifyKnownEntry(
        issue(),
        { stage: 'scope', scopeArtifacts: [] },
        { kind: 'absent' },
        { kind: 'absent' },
        policy,
      ),
    ).toEqual({ kind: 'checkpoint_ready' });
    expect(
      classifyKnownEntry(
        issue(),
        { stage: 'scope', scopeArtifacts: [] },
        present(),
        { kind: 'absent' },
        policy,
      ),
    ).toEqual({ kind: 'projection_pending' });
    expect(
      classifyKnownEntry(
        issue(),
        { stage: 'scope_write', scopeArtifacts: [] },
        present(),
        { kind: 'present', state: 'scope_write' },
        policy,
      ),
    ).toEqual({ kind: 'advanced', stage: 'scope_write' });
    expect(
      classifyKnownEntry(
        issue(),
        { stage: 'scope', scopeArtifacts: [] },
        present('wg-aaaaaaaaaaaa'),
        { kind: 'present', state: 'scope' },
        policy,
      ),
    ).toEqual({ kind: 'active_conflict' });
    expect(
      classifyKnownEntry(
        issue(),
        { stage: 'scope', scopeArtifacts: [] },
        present(),
        { kind: 'present', state: 'scope' },
        policy,
      ),
    ).toEqual({
      kind: 'engaged',
      stage: 'scope',
      writes: ['docs/research/*pre-research*'],
    });
  });

  it('keeps the ephemeral attempt reducer pure and total', () => {
    const states: ScopeEntryAttempt[] = [
      { kind: 'start' },
      { kind: 'parsed' },
      { kind: 'selected' },
      { kind: 'checkpointed' },
      { kind: 'published' },
      { kind: 'projected' },
      { kind: 'context_ready' },
      {
        kind: 'done',
        result: { kind: 'rejected', message: 'done' },
      },
    ];
    const events: ScopeEntryAttemptEvent[] = [
      { kind: 'parsed' },
      { kind: 'selected' },
      { kind: 'checkpointed' },
      { kind: 'published' },
      { kind: 'projected' },
      { kind: 'context_ready' },
      { kind: 'finish', result: { kind: 'rejected', message: 'stop' } },
    ];
    for (const state of states) {
      for (const event of events) expect(() => stepScopeEntryAttempt(state, event)).not.toThrow();
    }
    expect(
      stepScopeEntryAttempt(
        { kind: 'context_ready' },
        {
          kind: 'finish',
          result: {
            kind: 'engaged',
            itemId: ITEM,
            context: 'ctx',
            continuationPrompt: 'continue',
          },
        },
      ),
    ).toMatchObject({ kind: 'done', result: { kind: 'engaged', itemId: ITEM } });
  });
});

describe('createFullstackScopeCommand', () => {
  it('creates exactly one issue, publishes canonical scope state, and returns existing context', async () => {
    const h = harness();
    const command = createFullstackScopeCommand(h.deps);
    const result = await command.execute({
      raw: '/scope Ship  the exact request',
      sessionId: 's-create',
      cwd: '/project',
    });

    expect(result).toMatchObject({
      kind: 'engaged',
      itemId: ITEM,
      context: 'EXISTING SCOPE CONTEXT',
    });
    expect(result.kind === 'engaged' && result.continuationPrompt.startsWith('/scope')).toBe(false);
    expect(h.createCount()).toBe(1);
    expect(h.issues.get(ITEM)?.title).toBe('Ship  the exact request');
    expect(h.checkpoints.get(ITEM)?.stage).toBe('scope');
    const active = h.active.get('s-create');
    expect(active).toMatchObject({
      kind: 'present',
      task: { id: ITEM, subject: ITEM },
    });
    expect(active?.kind === 'present' && Object.hasOwn(active.task, 'taskId')).toBe(false);
  });

  it('selects an existing item without creating and rejects a later-stage rewind', async () => {
    const h = harness();
    h.issues.set(ITEM, issue());
    const command = createFullstackScopeCommand(h.deps);
    await expect(
      command.execute({ raw: `/scope --item ${ITEM}`, sessionId: 's-select', cwd: '/project' }),
    ).resolves.toMatchObject({ kind: 'engaged', itemId: ITEM });
    expect(h.createCount()).toBe(0);

    const later = harness();
    later.issues.set(ITEM, issue());
    later.checkpoints.set(ITEM, { stage: 'plan', scopeArtifacts: [] });
    await expect(
      createFullstackScopeCommand(later.deps).execute({
        raw: `/scope --item ${ITEM}`,
        sessionId: 's-later',
        cwd: '/project',
      }),
    ).resolves.toMatchObject({ kind: 'failed', durableState: 'advanced', itemId: ITEM });
    expect(later.checkpoints.get(ITEM)?.stage).toBe('plan');
    expect(later.writeActiveTask).not.toHaveBeenCalled();
  });

  it('reconciles a committed active-task write whose writer rejects, without a duplicate issue', async () => {
    const h = harness();
    let first = true;
    h.deps.writeActiveTask = vi.fn((sid: string, task: ActiveTask) => {
      h.active.set(sid, { kind: 'present', task });
      if (first) {
        first = false;
        return Promise.reject(new Error('rename acknowledgement lost'));
      }
      return Promise.resolve();
    });
    const result = await createFullstackScopeCommand(h.deps).execute({
      raw: '/scope recover one item',
      sessionId: 's-reconcile',
      cwd: '/project',
    });
    expect(result).toMatchObject({ kind: 'engaged', itemId: ITEM });
    expect(h.createCount()).toBe(1);
  });

  it('uses only the invocation project local stores in the production composition', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fullstack-scope-local-'));
    const project = join(workspace, 'project-a');
    const neighbor = join(workspace, 'project-b');
    try {
      for (const root of [project, neighbor]) {
        await mkdir(join(root, '.opensquid'), { recursive: true });
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(
          join(root, '.opensquid', 'active.json'),
          JSON.stringify({ packs: ['fullstack-flow'], docsRoot: 'docs' }),
        );
      }
      const result = await fullstackScopeCommand.execute({
        raw: '/scope production local identity',
        sessionId: `scope-local-${Date.now().toString(36)}`,
        cwd: project,
      });
      expect(result).toMatchObject({ kind: 'engaged' });
      if (result.kind !== 'engaged') throw new Error('production fixture did not engage');
      await expect(access(join(neighbor, '.opensquid', 'workgraph.db'))).rejects.toThrow();

      const graphDb = createClient({ url: `file:${join(project, '.opensquid', 'workgraph.db')}` });
      const graphRows = await graphDb.execute({
        sql: 'SELECT id,title,status FROM wg_issues WHERE id=?',
        args: [result.itemId],
      });
      graphDb.close();
      expect(graphRows.rows[0]).toMatchObject({
        id: result.itemId,
        title: 'production local identity',
        status: 'open',
      });
      const checkpointDb = createClient({
        url: `file:${join(project, '.opensquid', 'opensquid.db')}`,
      });
      const checkpoint = await new CheckpointStore(checkpointDb).getTaskCheckpoint(result.itemId);
      checkpointDb.close();
      expect(checkpoint).toEqual({ stage: 'scope', scopeArtifacts: [] });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reports creation as indeterminate when create rejects before returning an id', async () => {
    const h = harness({
      openWorkGraph: () =>
        Promise.resolve({
          createIssue: () => Promise.reject(new Error('commit acknowledgement unknown')),
          getIssue: () => Promise.resolve(null),
        }),
    });
    const result = await createFullstackScopeCommand(h.deps).execute({
      raw: '/scope uncertain create',
      sessionId: 's-unknown',
      cwd: '/project',
    });
    expect(result).toMatchObject({
      kind: 'failed',
      durableState: 'creation_indeterminate',
    });
    expect(result.kind === 'failed' && Object.hasOwn(result, 'itemId')).toBe(false);
    expect(result.kind === 'failed' && Object.hasOwn(result, 'recovery')).toBe(false);
  });
});

describe('pack-owned adapter projection', () => {
  it('ships one prompt skill that delegates command semantics to one primitive', async () => {
    const loaded = await loadPackV2(resolve('packs/builtin/fullstack-flow'));
    const skill = loaded.skills.find((candidate) => candidate.name === 'scope-entry');
    expect(skill).toBeDefined();
    expect(JSON.stringify(skill?.rules)).toContain('fullstack_scope_entry');
    expect(JSON.stringify(skill?.rules)).not.toContain('match_command');
  });

  it('keeps ignored prompts a no-op before requiring recorded cwd', async () => {
    const registry = new FunctionRegistry();
    const execute = vi.fn();
    const readCwd = vi.fn(() => Promise.resolve(null));
    registerFullstackScopeEntry(registry, {
      command: { name: 'scope', description: 'shared', execute },
      readCwd,
    });
    const ctx = {
      event: { kind: 'prompt_submit' as const, prompt: 'ordinary' },
      bindings: new Map<string, unknown>(),
      sessionId: 's-no-cwd',
      packId: 'fullstack-flow',
    };

    await expect(registry.call('fullstack_scope_entry', { raw: 'ordinary' }, ctx)).resolves.toEqual(
      {
        ok: true,
        value: null,
      },
    );
    expect(readCwd).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await expect(registry.call('fullstack_scope_entry', { raw: '/scope x' }, ctx)).resolves.toEqual(
      {
        ok: true,
        value: {
          level: 'block',
          message: 'scope entry blocked: session start did not record a project cwd',
        },
      },
    );
    expect(readCwd).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('adapts ignored, failed, and engaged results without harness-specific state writes', async () => {
    const registry = new FunctionRegistry();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'rejected', message: 'bad scope' })
      .mockResolvedValueOnce({
        kind: 'engaged',
        itemId: ITEM,
        context: 'EXISTING SCOPE CONTEXT',
        continuationPrompt: 'continue',
      });
    registerFullstackScopeEntry(registry, {
      command: { name: 'scope', description: 'shared', execute },
      readCwd: () => Promise.resolve('/project'),
    });
    const ctx = {
      event: { kind: 'prompt_submit' as const, prompt: '/scope x' },
      bindings: new Map<string, unknown>(),
      sessionId: 's-adapter',
      packId: 'fullstack-flow',
    };
    await expect(registry.call('fullstack_scope_entry', { raw: 'ordinary' }, ctx)).resolves.toEqual(
      {
        ok: true,
        value: null,
      },
    );
    expect(execute).not.toHaveBeenCalled();
    await expect(registry.call('fullstack_scope_entry', { raw: '/scope' }, ctx)).resolves.toEqual({
      ok: true,
      value: { level: 'block', message: 'bad scope' },
    });
    await expect(registry.call('fullstack_scope_entry', { raw: '/scope x' }, ctx)).resolves.toEqual(
      {
        ok: true,
        value: { kind: 'inject_context', content: 'EXISTING SCOPE CONTEXT' },
      },
    );
  });
});

describe('resolveFullstackScopeEngagement', () => {
  it('keeps the selected fullstack item engaged at its matching current stage', async () => {
    const h = harness();
    h.issues.set(ITEM, issue());
    h.active.set('s-engaged', {
      kind: 'present',
      task: { id: ITEM, subject: ITEM, started_at: NOW },
    });
    h.checkpoints.set(ITEM, { stage: 'plan', scopeArtifacts: [] });
    h.projections.set('s-engaged:' + ITEM, {
      state: 'plan',
      started_at: NOW,
      history: [{ state: 'plan', at: NOW }],
    });

    await expect(
      resolveFullstackScopeEngagement({ sessionId: 's-engaged', cwd: '/project' }, h.deps),
    ).resolves.toEqual({
      kind: 'engaged',
      itemId: ITEM,
      stage: 'plan',
      writes: ['docs/**'],
    });
  });

  it('fails closed on a missing or divergent projection, but not on an outside-pack checkpoint', async () => {
    const h = harness();
    h.issues.set(ITEM, issue());
    h.active.set('s-diverged', {
      kind: 'present',
      task: { id: ITEM, subject: ITEM, started_at: NOW },
    });
    h.checkpoints.set(ITEM, { stage: 'author', scopeArtifacts: [] });

    await expect(
      resolveFullstackScopeEngagement({ sessionId: 's-diverged', cwd: '/project' }, h.deps),
    ).resolves.toMatchObject({ kind: 'indeterminate', itemId: ITEM });

    h.projections.set('s-diverged:' + ITEM, {
      state: 'plan',
      started_at: NOW,
      history: [{ state: 'plan', at: NOW }],
    });
    await expect(
      resolveFullstackScopeEngagement({ sessionId: 's-diverged', cwd: '/project' }, h.deps),
    ).resolves.toMatchObject({ kind: 'indeterminate', itemId: ITEM });

    h.checkpoints.set(ITEM, { stage: 'other-pack-state', scopeArtifacts: [] });
    await expect(
      resolveFullstackScopeEngagement({ sessionId: 's-diverged', cwd: '/project' }, h.deps),
    ).resolves.toEqual({ kind: 'unengaged' });
  });
});

describe('engaged lane decision', () => {
  it('allows the declared scope artifact, denies source writes, and fails closed on indeterminate mutation', () => {
    expect(
      decideFullstackScopeWrite(
        { kind: 'engaged', itemId: ITEM, stage: 'scope', writes: ['docs/research/*pre-research*'] },
        'Write',
        { file_path: '/project/docs/research/x-pre-research-a.md' },
      ),
    ).toEqual({ kind: 'allow' });
    expect(
      decideFullstackScopeWrite(
        { kind: 'engaged', itemId: ITEM, stage: 'scope', writes: ['docs/research/*pre-research*'] },
        'Write',
        { file_path: '/project/src/app.ts' },
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      decideFullstackScopeWrite(
        { kind: 'indeterminate', itemId: ITEM, reason: 'checkpoint read failed' },
        'Edit',
        { file_path: '/project/src/app.ts' },
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      decideFullstackScopeWrite(
        { kind: 'indeterminate', itemId: ITEM, reason: 'checkpoint read failed' },
        'Read',
        { file_path: '/project/src/app.ts' },
      ),
    ).toEqual({ kind: 'allow' });
    expect(
      decideFullstackScopeWrite({ kind: 'unengaged' }, 'Write', {
        file_path: '/project/src/app.ts',
      }),
    ).toEqual({ kind: 'not_applicable' });
  });
});
