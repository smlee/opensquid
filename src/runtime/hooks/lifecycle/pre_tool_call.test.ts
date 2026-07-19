import { describe, expect, it, vi } from 'vitest';

import { runPreToolCall, type PreToolCallHandlerDeps } from './pre_tool_call.js';
import type { LifecycleContext } from './types.js';
import type { SafetyPolicy } from '../../guard/safety_policy.js';

const REVIEWER_CTX: LifecycleContext = {
  sessionId: 'sess-reviewer',
  cwd: '/repo',
  actor: { kind: 'reviewer', id: 'reviewer-1' },
  role: 'reviewer',
  now: '2026-07-11T00:00:00.000Z',
};

const PASS_POLICY: SafetyPolicy = { allow: [], forbid: [] };
const BLOCK_POLICY: SafetyPolicy = {
  allow: [],
  forbid: [
    {
      tool: 'Bash',
      argPattern: 'rm -rf /',
      tier: 'hardline',
      message: 'nope',
    },
  ],
};

interface PreToolFixture {
  deps: PreToolCallHandlerDeps;
  appendTool: ReturnType<typeof vi.fn>;
  recordSessionCwd: ReturnType<typeof vi.fn>;
  mirrorActiveTask: ReturnType<typeof vi.fn>;
  runHarnessGraphSync: ReturnType<typeof vi.fn>;
  loadSafetyPolicy: ReturnType<typeof vi.fn>;
  appendProjectDriftEvent: ReturnType<typeof vi.fn>;
  projectDeclaresCoordinatorDocsOnly: ReturnType<typeof vi.fn>;
  checkDesignDocRewrite: ReturnType<typeof vi.fn>;
  resolveFullstackScopeEngagement: ReturnType<typeof vi.fn>;
  loadDispatch: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  loadActiveV2Cartridges: ReturnType<typeof vi.fn>;
  runV2SkillHost: ReturnType<typeof vi.fn>;
  runV2Cartridges: ReturnType<typeof vi.fn>;
}

function fixture(policy: SafetyPolicy): PreToolFixture {
  const appendTool = vi.fn(() => Promise.resolve());
  const recordSessionCwd = vi.fn(() => Promise.resolve());
  const mirrorActiveTask = vi.fn(() => Promise.resolve());
  const runHarnessGraphSync = vi.fn(() => Promise.resolve(null));
  const loadSafetyPolicy = vi.fn(() => Promise.resolve(policy));
  const isYoloMode = vi.fn(() => Promise.resolve(false));
  const appendProjectDriftEvent = vi.fn(() => Promise.resolve());
  const projectDeclaresCoordinatorDocsOnly = vi.fn(() => Promise.resolve(true));
  const readSettings = vi.fn(() => Promise.resolve({ allow_code_write: false }));
  const resolveProjectScopeRoot = vi.fn(() => Promise.resolve('/repo/.opensquid'));
  const checkDesignDocRewrite = vi.fn(() => Promise.resolve({ deny: false as const }));
  const readScopeAuditVerdict = vi.fn(() => Promise.resolve(undefined));
  const resolveFullstackScopeEngagement = vi.fn(() =>
    Promise.resolve({ kind: 'unengaged' as const }),
  );
  const loadDispatch = vi.fn(() => Promise.resolve({ packs: [], registry: {} as never }));
  const dispatchEvent = vi.fn(() =>
    Promise.resolve({
      exitCode: 0 as const,
      stderr: '',
      contextInjections: [],
      directives: [],
    }),
  );
  const loadActiveV2Cartridges = vi.fn(() => Promise.resolve([]));
  const runV2SkillHost = vi.fn(() =>
    Promise.resolve({ exitCode: 0 as const, stderr: '', contextInjections: [] }),
  );
  const runV2Cartridges = vi.fn(() =>
    Promise.resolve({ exitCode: 0 as const, messages: [], injections: [], boundSkills: [] }),
  );
  return {
    deps: {
      appendTool,
      recordSessionCwd,
      mirrorActiveTask,
      runHarnessGraphSync,
      loadSafetyPolicy,
      isYoloMode,
      appendProjectDriftEvent,
      projectDeclaresCoordinatorDocsOnly,
      readSettings,
      resolveProjectScopeRoot,
      checkDesignDocRewrite,
      readScopeAuditVerdict,
      resolveFullstackScopeEngagement,
      loadDispatch,
      dispatchEvent,
      loadActiveV2Cartridges,
      runV2SkillHost,
      runV2Cartridges,
    },
    appendTool,
    recordSessionCwd,
    mirrorActiveTask,
    runHarnessGraphSync,
    loadSafetyPolicy,
    appendProjectDriftEvent,
    projectDeclaresCoordinatorDocsOnly,
    checkDesignDocRewrite,
    resolveFullstackScopeEngagement,
    loadDispatch,
    dispatchEvent,
    loadActiveV2Cartridges,
    runV2SkillHost,
    runV2Cartridges,
  };
}

describe('runPreToolCall reviewer projection', () => {
  it('allows a declared read without entering the product lifecycle', async () => {
    const mocked = fixture(PASS_POLICY);
    const result = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'Read',
          args: { file_path: '/repo/note.md' },
          cwd: '/repo',
        },
      },
      REVIEWER_CTX,
      mocked.deps,
    );

    expect(result).toEqual({ block: false, contextInjections: [], diagnostics: [] });
    expect(mocked.appendTool).not.toHaveBeenCalled();
    expect(mocked.recordSessionCwd).not.toHaveBeenCalled();
    expect(mocked.loadSafetyPolicy).not.toHaveBeenCalled();
    expect(mocked.mirrorActiveTask).not.toHaveBeenCalled();
    expect(mocked.runHarnessGraphSync).not.toHaveBeenCalled();
    expect(mocked.projectDeclaresCoordinatorDocsOnly).not.toHaveBeenCalled();
    expect(mocked.loadDispatch).not.toHaveBeenCalled();
    expect(mocked.dispatchEvent).not.toHaveBeenCalled();
    expect(mocked.runV2SkillHost).not.toHaveBeenCalled();
    expect(mocked.runV2Cartridges).not.toHaveBeenCalled();
  });

  it('blocks mutation before any product lifecycle side effect', async () => {
    const mocked = fixture(BLOCK_POLICY);
    const result = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'Bash',
          args: { command: 'rm -rf /' },
          cwd: '/repo',
        },
      },
      REVIEWER_CTX,
      mocked.deps,
    );

    expect(result.block).toBe(true);
    expect(result.reason).toContain('[reviewer guard]');
    expect(mocked.appendTool).not.toHaveBeenCalled();
    expect(mocked.recordSessionCwd).not.toHaveBeenCalled();
    expect(mocked.mirrorActiveTask).not.toHaveBeenCalled();
    expect(mocked.runHarnessGraphSync).not.toHaveBeenCalled();
    expect(mocked.projectDeclaresCoordinatorDocsOnly).not.toHaveBeenCalled();
    expect(mocked.loadDispatch).not.toHaveBeenCalled();
    expect(mocked.runV2Cartridges).not.toHaveBeenCalled();
  });
});

describe('runPreToolCall engaged fullstack-flow lane', () => {
  const context: LifecycleContext = {
    sessionId: 'sess-scope',
    cwd: '/repo',
    actor: { kind: 'coordinator' },
    role: 'interactive',
    now: '2026-07-18T00:00:00.000Z',
  };

  it('allows the existing SCOPE artifact lane and denies source writes even with a standing grant', async () => {
    const allowed = fixture(PASS_POLICY);
    allowed.resolveFullstackScopeEngagement.mockResolvedValue({
      kind: 'engaged',
      itemId: 'wg-123456789abc',
      stage: 'scope',
      writes: ['docs/research/*pre-research*'],
    });
    allowed.deps.readSettings = vi.fn(() => Promise.resolve({ allow_code_write: true }));
    const artifact = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'Write',
          args: { file_path: '/repo/docs/research/x-pre-research-a.md', content: 'scope' },
          cwd: '/repo',
        },
      },
      context,
      allowed.deps,
    );
    expect(artifact.block).toBe(false);

    const denied = fixture(PASS_POLICY);
    denied.resolveFullstackScopeEngagement.mockResolvedValue({
      kind: 'engaged',
      itemId: 'wg-123456789abc',
      stage: 'scope',
      writes: ['docs/research/*pre-research*'],
    });
    denied.deps.readSettings = vi.fn(() => Promise.resolve({ allow_code_write: true }));
    const source = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'Write',
          args: { file_path: '/repo/src/app.ts', content: 'no' },
          cwd: '/repo',
        },
      },
      context,
      denied.deps,
    );
    expect(source.block).toBe(true);
    expect(source.reason).toContain('[write-lane]');
    expect(denied.loadDispatch).not.toHaveBeenCalled();
  });

  it('denies mutating calls when engagement is indeterminate but still allows reads', async () => {
    const denied = fixture(PASS_POLICY);
    denied.resolveFullstackScopeEngagement.mockResolvedValue({
      kind: 'indeterminate',
      itemId: 'wg-123456789abc',
      reason: 'checkpoint I/O failed',
    });
    const mutation = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'Edit',
          args: { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' },
          cwd: '/repo',
        },
      },
      context,
      denied.deps,
    );
    expect(mutation.block).toBe(true);
    expect(mutation.reason).toContain('indeterminate');

    const reads = fixture(PASS_POLICY);
    reads.resolveFullstackScopeEngagement.mockResolvedValue({
      kind: 'indeterminate',
      itemId: 'wg-123456789abc',
      reason: 'checkpoint I/O failed',
    });
    const read = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'Read',
          args: { file_path: '/repo/src/app.ts' },
          cwd: '/repo',
        },
      },
      context,
      reads.deps,
    );
    expect(read.block).toBe(false);
  });

  it('normalizes apply_patch once and denies any out-of-lane or unextractable target', async () => {
    const mixed = fixture(PASS_POLICY);
    mixed.resolveFullstackScopeEngagement.mockResolvedValue({
      kind: 'engaged',
      itemId: 'wg-123456789abc',
      stage: 'scope',
      writes: ['docs/research/*pre-research*'],
    });
    const result = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'apply_patch',
          args: {
            command:
              '*** Begin Patch\n*** Add File: docs/research/x-pre-research-a.md\n+ok\n*** Add File: src/app.ts\n+no\n*** End Patch',
          },
          cwd: '/repo',
        },
      },
      context,
      mixed.deps,
    );
    expect(result.block).toBe(true);
    expect(result.reason).toContain('src/app.ts');

    const empty = fixture(PASS_POLICY);
    empty.resolveFullstackScopeEngagement.mockResolvedValue({
      kind: 'engaged',
      itemId: 'wg-123456789abc',
      stage: 'scope',
      writes: ['docs/research/*pre-research*'],
    });
    const unknown = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'apply_patch',
          args: { command: 'not a patch' },
          cwd: '/repo',
        },
      },
      context,
      empty.deps,
    );
    expect(unknown.block).toBe(true);
    expect(unknown.reason).toContain('no extractable target');
  });

  it('preserves the existing grant behavior when definitely unengaged', async () => {
    const mocked = fixture(PASS_POLICY);
    mocked.deps.readSettings = vi.fn(() => Promise.resolve({ allow_code_write: true }));
    const result = await runPreToolCall(
      {
        event: {
          kind: 'tool_call',
          tool: 'Write',
          args: { file_path: '/repo/src/app.ts', content: 'allowed as before' },
          cwd: '/repo',
        },
      },
      context,
      mocked.deps,
    );
    expect(result.block).toBe(false);
    expect(mocked.dispatchEvent).toHaveBeenCalledOnce();
  });
});
