import { describe, expect, it, vi } from 'vitest';

import { runPostToolCall, type PostToolCallHandlerDeps } from './post_tool_call.js';
import type { LifecycleContext } from './types.js';

const CHILD_CTX: LifecycleContext = {
  sessionId: 'sess-child',
  cwd: '/repo',
  actor: { kind: 'executor', id: 'exec-1' },
  role: 'lap-child',
  now: '2026-07-11T00:00:00.000Z',
};

interface PostToolFixture {
  deps: PostToolCallHandlerDeps;
  loadDispatch: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  runV2Cartridges: ReturnType<typeof vi.fn>;
  observeCall: ReturnType<typeof vi.fn>;
}

function fixture(): PostToolFixture {
  const loadDispatch = vi.fn(() => Promise.resolve({ packs: [], registry: {} as never }));
  const dispatchEvent = vi.fn(() =>
    Promise.resolve({
      exitCode: 0 as const,
      stderr: '',
      contextInjections: [],
      directives: [],
    }),
  );
  const runV2Cartridges = vi.fn(() =>
    Promise.resolve({ exitCode: 0 as const, messages: [], injections: [], boundSkills: [] }),
  );
  const observeCall = vi.fn(() => Promise.resolve<'warn'>('warn'));
  return {
    deps: { loadDispatch, dispatchEvent, runV2Cartridges, observeCall },
    loadDispatch,
    dispatchEvent,
    runV2Cartridges,
    observeCall,
  };
}

describe('runPostToolCall lap-child projection', () => {
  it('runs executed child tools through pack dispatch, cartridges, and observation', async () => {
    const mocked = fixture();
    const result = await runPostToolCall(
      {
        event: {
          kind: 'post_tool_call',
          tool: 'Bash',
          args: { command: 'npm test' },
          cwd: '/repo',
          exit_code: 1,
        },
      },
      CHILD_CTX,
      mocked.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Progress floor');
    expect(mocked.observeCall).toHaveBeenCalledTimes(1);
    expect(mocked.loadDispatch).toHaveBeenCalledOnce();
    expect(mocked.dispatchEvent).toHaveBeenCalledOnce();
    expect(mocked.runV2Cartridges).toHaveBeenCalledOnce();
  });
});
