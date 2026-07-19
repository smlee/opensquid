import { describe, expect, it, vi } from 'vitest';

import { runPostToolCall, type PostToolCallHandlerDeps } from './post_tool_call.js';
import type { LifecycleContext } from './types.js';

const REVIEWER_CTX: LifecycleContext = {
  sessionId: 'sess-reviewer',
  cwd: '/repo',
  actor: { kind: 'reviewer', id: 'reviewer-1' },
  role: 'reviewer',
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

describe('runPostToolCall reviewer projection', () => {
  it('does not project reviewer observations into workflow state', async () => {
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
      REVIEWER_CTX,
      mocked.deps,
    );

    expect(result).toEqual({
      exitCode: 0,
      stderr: '',
      contextInjections: [],
      directives: [],
      diagnostics: [],
    });
    expect(mocked.observeCall).not.toHaveBeenCalled();
    expect(mocked.loadDispatch).not.toHaveBeenCalled();
    expect(mocked.dispatchEvent).not.toHaveBeenCalled();
    expect(mocked.runV2Cartridges).not.toHaveBeenCalled();
  });
});
