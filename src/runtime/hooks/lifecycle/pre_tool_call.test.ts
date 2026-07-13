import { describe, expect, it, vi } from 'vitest';

import { runPreToolCall, type PreToolCallHandlerDeps } from './pre_tool_call.js';
import type { LifecycleContext } from './types.js';
import type { SafetyPolicy } from '../../guard/safety_policy.js';

const CHILD_CTX: LifecycleContext = {
  sessionId: 'sess-child',
  cwd: '/repo',
  actor: { kind: 'executor', id: 'exec-1' },
  role: 'lap-child',
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
  projectDeclaresOrchestratorOnly: ReturnType<typeof vi.fn>;
  checkDesignDocRewrite: ReturnType<typeof vi.fn>;
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
  const projectDeclaresOrchestratorOnly = vi.fn(() => Promise.resolve(true));
  const readSettings = vi.fn(() => Promise.resolve({ allow_code_write: false }));
  const resolveProjectScopeRoot = vi.fn(() => Promise.resolve('/repo/.opensquid'));
  const checkDesignDocRewrite = vi.fn(() => Promise.resolve({ deny: false as const }));
  const readScopeAuditVerdict = vi.fn(() => Promise.resolve(undefined));
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
      projectDeclaresOrchestratorOnly,
      readSettings,
      resolveProjectScopeRoot,
      checkDesignDocRewrite,
      readScopeAuditVerdict,
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
    projectDeclaresOrchestratorOnly,
    checkDesignDocRewrite,
    loadDispatch,
    dispatchEvent,
    loadActiveV2Cartridges,
    runV2SkillHost,
    runV2Cartridges,
  };
}

describe('runPreToolCall lap-child projection', () => {
  it('runs executor calls through the same mirror, guards, dispatch, and pack skill host', async () => {
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
      CHILD_CTX,
      mocked.deps,
    );

    expect(result).toEqual({ block: false, contextInjections: [], diagnostics: [] });
    expect(mocked.appendTool).toHaveBeenCalledTimes(1);
    expect(mocked.recordSessionCwd).toHaveBeenCalledTimes(1);
    expect(mocked.loadSafetyPolicy).toHaveBeenCalledTimes(1);
    expect(mocked.mirrorActiveTask).toHaveBeenCalledOnce();
    expect(mocked.runHarnessGraphSync).toHaveBeenCalledOnce();
    expect(mocked.appendProjectDriftEvent).not.toHaveBeenCalled();
    expect(mocked.projectDeclaresOrchestratorOnly).toHaveBeenCalledOnce();
    expect(mocked.checkDesignDocRewrite).toHaveBeenCalledOnce();
    expect(mocked.loadDispatch).toHaveBeenCalledOnce();
    expect(mocked.dispatchEvent).toHaveBeenCalledOnce();
    expect(mocked.loadActiveV2Cartridges).toHaveBeenCalledOnce();
    expect(mocked.runV2SkillHost).toHaveBeenCalledOnce();
    expect(mocked.runV2Cartridges).not.toHaveBeenCalled();
  });

  it('still enforces the safety floor for a lap-child', async () => {
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
      CHILD_CTX,
      mocked.deps,
    );

    expect(result.block).toBe(true);
    expect(result.reason).toContain('[safety floor]');
    expect(mocked.appendTool).toHaveBeenCalledTimes(1);
    expect(mocked.recordSessionCwd).toHaveBeenCalledTimes(1);
    expect(mocked.mirrorActiveTask).toHaveBeenCalledOnce();
    expect(mocked.runHarnessGraphSync).toHaveBeenCalledOnce();
    expect(mocked.projectDeclaresOrchestratorOnly).not.toHaveBeenCalled();
    expect(mocked.loadDispatch).not.toHaveBeenCalled();
    expect(mocked.runV2Cartridges).not.toHaveBeenCalled();
  });
});
