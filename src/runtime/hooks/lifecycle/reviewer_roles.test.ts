import { describe, expect, it, vi } from 'vitest';

import { runPromptSubmit, type PromptSubmitHandlerDeps } from './prompt_submit.js';
import {
  extractExistingHostLifecycleCarrier,
  formatDirectiveBlock,
  projectExistingHostActorAndRole,
  projectExistingHostLifecycleContext,
} from './projector.js';
import { runSessionEnd, type SessionEndHandlerDeps } from './session_end.js';
import { runSessionStart, type SessionStartHandlerDeps } from './session_start.js';
import { runStop, type StopHandlerDeps } from './stop.js';
import type { LifecycleContext } from './types.js';

const REVIEWER_CTX: LifecycleContext = {
  sessionId: 'sess-reviewer',
  cwd: '/repo',
  actor: { kind: 'reviewer', id: 'reviewer-1' },
  role: 'reviewer',
  now: '2026-07-11T00:00:00.000Z',
};

const resolved = <T>(value: T) => vi.fn(() => Promise.resolve(value));

describe('existing-host lifecycle projector', () => {
  it('projects native helper identity as a bounded reviewer across hosts', () => {
    expect(extractExistingHostLifecycleCarrier('{"agent_id":" reviewer-1 "}')).toEqual({
      agent_id: 'reviewer-1',
    });
    expect(projectExistingHostActorAndRole({ agent_id: 'reviewer-1' })).toEqual({
      actor: { kind: 'reviewer', id: 'reviewer-1' },
      role: 'reviewer',
    });
    expect(
      projectExistingHostLifecycleContext({
        sessionId: 'sess-1',
        cwd: '/repo',
        raw: '{"agent_id":"reviewer-2"}',
        now: 'now',
      }),
    ).toEqual({
      sessionId: 'sess-1',
      cwd: '/repo',
      actor: { kind: 'reviewer', id: 'reviewer-2' },
      role: 'reviewer',
      now: 'now',
    });
  });

  it('preserves the directive block contract byte-for-byte', () => {
    expect(
      formatDirectiveBlock([
        { next_action: { profession: 'scope-architect', rationale: 'continue' } },
      ]),
    ).toBe(
      '⛔ DIRECTIVE — next action required:\n```json\n' +
        JSON.stringify(
          [{ next_action: { profession: 'scope-architect', rationale: 'continue' } }],
          null,
          2,
        ) +
        '\n```',
    );
  });
});

describe('bounded reviewer lifecycle handlers', () => {
  it('keeps session start outside workflow ownership and state', async () => {
    const recordCurrentSession = resolved(undefined);
    const recordSessionCwd = resolved(undefined);
    const claimUmbrellaLeaseForSession = resolved(undefined);
    const ensureLapActiveTask = resolved(undefined);
    const initializeV2 = resolved(undefined);
    const loadDispatch = resolved({ packs: [], registry: {} as never });
    const dispatchEvent = resolved({
      exitCode: 0 as const,
      stderr: '',
      contextInjections: [],
      directives: [],
    });
    const mocked: SessionStartHandlerDeps = {
      recordCurrentSession,
      recordSessionCwd,
      claimUmbrellaLeaseForSession,
      ensureLapActiveTask,
      initializeV2,
      loadDispatch,
      dispatchEvent,
    };
    expect(
      await runSessionStart(
        { event: { kind: 'session_start', source: 'startup', cwd: '/repo' } },
        REVIEWER_CTX,
        mocked,
      ),
    ).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [], diagnostics: [] });
    expect(recordCurrentSession).not.toHaveBeenCalled();
    expect(recordSessionCwd).not.toHaveBeenCalled();
    expect(claimUmbrellaLeaseForSession).not.toHaveBeenCalled();
    expect(ensureLapActiveTask).not.toHaveBeenCalled();
    expect(initializeV2).not.toHaveBeenCalled();
    expect(loadDispatch).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('keeps prompt submission outside workflow dispatch and classification', async () => {
    const recordCurrentSession = resolved(undefined);
    const claimUmbrellaLeaseForSession = resolved(undefined);
    const resetTurnLedger = resolved(undefined);
    const writeRequestType = resolved(undefined);
    const detectNewProject = resolved(null);
    const drainUmbrellaInbox = resolved('');
    const listInstalledV2Packs = resolved([]);
    const orchestrate = resolved({ injections: [], ground: false });
    const readSettings = resolved({});
    const writeClassifiedFacets = resolved(undefined);
    const loadDispatch = resolved({ packs: [], registry: {} as never });
    const dispatchEvent = resolved({
      exitCode: 0 as const,
      stderr: '',
      contextInjections: [],
      directives: [],
    });
    const runV2Cartridges = resolved({
      exitCode: 0 as const,
      messages: [],
      injections: [],
      boundSkills: [],
    });
    const mocked: PromptSubmitHandlerDeps = {
      recordCurrentSession,
      claimUmbrellaLeaseForSession,
      resetTurnLedger,
      writeRequestType,
      detectNewProject,
      drainUmbrellaInbox,
      listInstalledV2Packs,
      orchestrate,
      readSettings,
      writeClassifiedFacets,
      loadDispatch,
      dispatchEvent,
      runV2Cartridges,
    };
    expect(
      await runPromptSubmit(
        { event: { kind: 'prompt_submit', prompt: 'hi' } },
        REVIEWER_CTX,
        mocked,
      ),
    ).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [], diagnostics: [] });
    expect(recordCurrentSession).not.toHaveBeenCalled();
    expect(claimUmbrellaLeaseForSession).not.toHaveBeenCalled();
    expect(resetTurnLedger).not.toHaveBeenCalled();
    expect(loadDispatch).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(runV2Cartridges).not.toHaveBeenCalled();
  });

  it('keeps stop and session end outside workflow dispatch and cleanup', async () => {
    const maybeIngestTurn = resolved(undefined);
    const stopLoadDispatch = resolved({ packs: [], registry: {} as never });
    const stopDispatchEvent = resolved({
      exitCode: 0 as const,
      stderr: '',
      contextInjections: [],
      directives: [],
    });
    const claimUmbrellaLeaseForSession = resolved(undefined);
    const maybePeekInbound = resolved(null);
    const maybeStreamOutput = resolved(undefined);
    const maybeDriveInbound = resolved(null);
    const stopDeps: StopHandlerDeps = {
      maybeIngestTurn,
      loadDispatch: stopLoadDispatch,
      dispatchEvent: stopDispatchEvent,
      claimUmbrellaLeaseForSession,
      maybePeekInbound,
      maybeStreamOutput,
      maybeDriveInbound,
    };
    const endLoadDispatch = resolved({ packs: [], registry: {} as never });
    const endDispatchEvent = resolved({
      exitCode: 0 as const,
      stderr: '',
      contextInjections: [],
      directives: [],
    });
    const readActiveTask = resolved(null);
    const reconcileMemoryOnSessionEnd = resolved(undefined);
    const emitProbe = resolved(undefined);
    const runCompression = resolved([]);
    const runnerClose = resolved(undefined);
    const makeConsolidateRunner = vi.fn(() =>
      Promise.resolve({
        run: vi.fn(),
        close: runnerClose,
        gistAndRetire: resolved(undefined),
        client: {} as never,
      } as never),
    );
    const liveTurnIngestIds = resolved([]);
    const createBackend = vi.fn(() => ({ init: vi.fn(() => Promise.resolve(undefined)) }) as never);
    const resolveBackendConfig = resolved({} as never);
    const sweepRetiredIfAllowed = resolved([]);
    const notifyRetentionSweep = resolved(undefined);
    const resolveLocalStoreDir = resolved('/repo/.opensquid');
    const resolveActorId = resolved('actor-1');
    const workGraphStore = vi.fn(
      () => ({ init: vi.fn(() => Promise.resolve(undefined)) }) as never,
    );
    const reapOrphansIfAllowed = resolved([]);
    const commitMemoryStore = resolved(null);
    const archiveActiveTask = resolved(undefined);
    const endDeps: SessionEndHandlerDeps = {
      loadDispatch: endLoadDispatch,
      dispatchEvent: endDispatchEvent,
      readActiveTask,
      reconcileMemoryOnSessionEnd,
      emitProbe,
      runCompression,
      makeConsolidateRunner,
      liveTurnIngestIds,
      createBackend,
      resolveBackendConfig,
      sweepRetiredIfAllowed,
      notifyRetentionSweep,
      resolveLocalStoreDir,
      resolveActorId,
      workGraphStore,
      reapOrphansIfAllowed,
      commitMemoryStore,
      archiveActiveTask,
    };

    expect(
      await runStop(
        { event: { kind: 'stop', assistantText: 'done' }, isLoopLap: true },
        REVIEWER_CTX,
        stopDeps,
      ),
    ).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [], diagnostics: [] });
    expect(maybeIngestTurn).not.toHaveBeenCalled();
    expect(claimUmbrellaLeaseForSession).not.toHaveBeenCalled();
    expect(stopLoadDispatch).not.toHaveBeenCalled();
    expect(stopDispatchEvent).not.toHaveBeenCalled();

    expect(
      await runSessionEnd(
        { event: { kind: 'session_end', sessionId: 'sess-reviewer' }, isLoopLap: true },
        REVIEWER_CTX,
        endDeps,
      ),
    ).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [], diagnostics: [] });
    expect(endLoadDispatch).not.toHaveBeenCalled();
    expect(endDispatchEvent).not.toHaveBeenCalled();
    expect(reconcileMemoryOnSessionEnd).not.toHaveBeenCalled();
    expect(archiveActiveTask).not.toHaveBeenCalled();
  });
});
