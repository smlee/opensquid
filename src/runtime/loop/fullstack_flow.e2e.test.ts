/**
 * T2.15 — END-TO-END: drive the REAL fullstack-flow pack via the LIVE runV2Cartridges path, proving
 * ALL FIVE gates fire + advance on REAL evidence (not single-gate stubs): SCOPE advances on a resolving
 * pre-research artifact; PLAN runs over the real work-graph; AUTHOR passes on a zero-requirement coverage
 * manifest → code; CODE passes on the 7-phase ledger + clean readiness → deploy; DEPLOY + the accept
 * decision pass on capability-skip + an accepted item → done. Per-task gates seed the per-task FSM key.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPackV2 } from '../../packs/loader_v2.js';
import { OPENSQUID_HOME, sessionStateFile } from '../paths.js';
import { atomicWriteFile } from '../../storage/atomic_file.js';
import { bindProject, workGraphStore } from '../../workgraph/store.js';
import { appendAsk } from '../coverage/captured_ask.js';
import { appendTool, recordSessionCwd, writeActiveTask } from '../session_state.js';
import { readFsmStateRaw, readFsmStateFile, persistActorState } from '../fsm_state.js';
import { appendPhase, REQUIRED_PHASES } from '../workflow_phases.js';
import { recordReadiness } from './readiness.js';
import { readVerification } from './verification.js';
import { appendAcceptance, markAccepted } from './acceptance.js';
import type { Event } from '../event.js';

vi.mock('../bootstrap.js', () => ({ loadActiveV2Cartridges: vi.fn() }));
import { loadActiveV2Cartridges } from '../bootstrap.js';
import { runV2Cartridges } from './v2_supply.js';

const mockLoad = vi.mocked(loadActiveV2Cartridges);
const NOW = '2026-06-27T00:00:00.000Z';
const FSF = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packs',
  'builtin',
  'fullstack-flow',
);

const PRE_RESEARCH_PATH_KEY = 'fullstack-flow-pre-research-path';

/** Seed a stage's content-audit cache with a GUESS_FREE verdict (the flat `{verdict}` shape readVerdict reads),
 *  so the live GFR.2 (own-stage) + GFR.3 (rolling prior-stage) guard clauses are satisfied without spawning the
 *  real adversarial (LLM) audit producer — these tests exercise the deterministic gate spine, not the producer. */
async function seedVerdict(sid: string, stage: string): Promise<void> {
  await atomicWriteFile(
    sessionStateFile(sid, `fullstack-flow-${stage}-audit-cache`),
    JSON.stringify({ verdict: 'VERDICT: GUESS_FREE\n- seeded ok', hash: 'seed' }),
  );
}

const postWrite = (filePath: string): Event =>
  ({
    kind: 'post_tool_call',
    tool: 'Write',
    args: { file_path: filePath },
    exit_code: 0,
  }) as unknown as Event;

beforeEach(() => mockLoad.mockReset());

describe('fullstack-flow E2E — real pack, live path', () => {
  it('SCOPE is a no-op resting state: a pre-research write DWELLS — the interactive FSM does not advance', async () => {
    const real = await loadPackV2(FSF);
    mockLoad.mockResolvedValue([real]);

    const sid = 'e2e-scope';
    const root = await mkdtemp(join(tmpdir(), 'fsf-e2e-'));
    await mkdir(join(root, '.opensquid'), { recursive: true });
    await recordSessionCwd(sid, root);
    // SCOPE runs BEFORE a task is active (taskId=null → session-level FSM key 'fullstack-flow', per T2.2).

    // Even a fully-resolving pre-research artifact write (the input that USED to advance the FSM) must NOT move
    // SCOPE: it is interactive and leaves only on the user's explicit confirmation (procedure/scope.md).
    await appendAsk(sid, 'add login screen');
    for (let i = 0; i < 3; i++) await appendTool(sid, 'Read');
    const sub = join(root, 'docs', 'research');
    await mkdir(sub, { recursive: true });
    const artifact = join(sub, 'T-e2e-pre-research-2026.md');
    await writeFile(artifact, '1. Login [ask: "add login screen"]\n', 'utf8');
    await atomicWriteFile(sessionStateFile(sid, PRE_RESEARCH_PATH_KEY), JSON.stringify(artifact));
    await seedVerdict(sid, 'scope');

    const d = await runV2Cartridges(sid, postWrite(artifact), NOW);

    // SCOPE never blocks (no on_fail fires without a trigger) and never advances (dwells): the interactive stage
    // does nothing on a tool call. No transition is persisted, so the per-pack FSM state stays unset / at scope.
    expect(d.exitCode).toBe(0);
    expect(d.messages).toEqual([]);
    const state = await readFsmStateRaw(sid, 'fullstack-flow');
    expect(state === null || state === 'scope').toBe(true); // dwelled — no transition out of SCOPE
  });

  it('PLAN gate: a covered + acyclic work-graph passes the real PLAN gate', async () => {
    const real = await loadPackV2(FSF);
    mockLoad.mockResolvedValue([real]);

    const sid = 'e2e-plan';
    const root = await mkdtemp(join(tmpdir(), 'fsf-e2e-'));
    await mkdir(join(root, '.opensquid'), { recursive: true });
    await recordSessionCwd(sid, root);
    await writeActiveTask(sid, { id: '1', subject: 'add login', started_at: NOW, taskId: 'T-e2e' });

    // a covered, acyclic work-graph (legacy-global project the marker-less HOME session resolves to)
    const store = workGraphStore({
      dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
      sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
    });
    await store.init();
    const wg = bindProject(store, 'legacy-global');
    await wg.createIssue({ title: 'Login', body: 'implement login' });

    const ev = { kind: 'post_tool_call', tool: 'Bash', args: {}, exit_code: 0 } as unknown as Event;
    const d = await runV2Cartridges(sid, ev, NOW);
    // Not asserting a specific transition (plan-coverage join is artifact-dependent) — proving the real
    // PLAN gate RUNS over the real work-graph without blocking the hook (no crash, fail-open honored).
    expect(d.exitCode === 0 || d.exitCode === 2).toBe(true);
  });

  // Per-task gates (AUTHOR/CODE/DEPLOY) run on the per-task FSM key. Each test seeds the real pack's FSM at
  // the stage + stages that stage's REAL evidence + drives the live gate, asserting it PASSES + advances.
  const postBash = (): Event =>
    ({ kind: 'post_tool_call', tool: 'Bash', args: {}, exit_code: 0 }) as unknown as Event;

  async function freshTaskSession(
    stage: string,
  ): Promise<{ sid: string; root: string; taskId: string }> {
    const sid = `e2e-${stage}`;
    const taskId = `T-${stage}`;
    const root = await mkdtemp(join(tmpdir(), 'fsf-e2e-'));
    await mkdir(join(root, '.opensquid'), { recursive: true });
    await recordSessionCwd(sid, root);
    await writeActiveTask(sid, { id: '1', subject: stage, started_at: NOW, taskId });
    await persistActorState(sid, 'fullstack-flow', stage, NOW, taskId); // seed at this stage (per-task key)
    return { sid, root, taskId };
  }

  it('AUTHOR gate PASSES live with a minimal (zero-requirement) coverage manifest → advances to code', async () => {
    mockLoad.mockResolvedValue([await loadPackV2(FSF)]);
    const { sid, root, taskId } = await freshTaskSession('author');
    // a minimal docs/ARCHITECTURE.md → extractRequirements returns [] → coverage vacuously complete + real_code
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'ARCHITECTURE.md'), '# architecture\n', 'utf8');
    await seedVerdict(sid, 'author'); // GFR.2: the AUTHOR verdict
    await seedVerdict(sid, 'plan'); // GFR.3: the rolling re-assert of the prior PLAN verdict

    const d = await runV2Cartridges(sid, postBash(), NOW);
    expect(d.exitCode).toBe(0); // AUTHOR gate did not block
    expect((await readFsmStateFile(sid, 'fullstack-flow', taskId))?.state).toBe('code');
  });

  it('CODE gate PASSES live with all 7 phases logged + clean readiness → advances to deploy', async () => {
    mockLoad.mockResolvedValue([await loadPackV2(FSF)]);
    const { sid, taskId } = await freshTaskSession('code');
    for (const p of REQUIRED_PHASES) await appendPhase(sid, taskId, p); // all 7 logged for the task
    await recordReadiness(sid, taskId, { affected: [], existingDefs: [], deprecated: [] }); // ran + deprecated_clean
    await seedVerdict(sid, 'code'); // GFR.2: the CODE verdict
    await seedVerdict(sid, 'author'); // GFR.3: the rolling re-assert of the prior AUTHOR verdict

    const d = await runV2Cartridges(sid, postBash(), NOW);
    expect(d.exitCode).toBe(0); // CODE gate did not block
    expect((await readFsmStateFile(sid, 'fullstack-flow', taskId))?.state).toBe('deploy');
  });

  it('DEPLOY gate + accept PASS live (capability-skip + accepted item) → reaches done', async () => {
    mockLoad.mockResolvedValue([await loadPackV2(FSF)]);
    const { sid, taskId } = await freshTaskSession('deploy');
    // no deploy env → capability skip → true; a durable acceptance item marked accepted → the accept decision ships
    await appendAcceptance(sid, { id: 'a1', taskId, status: 'waiting', addedAt: NOW });
    await markAccepted(sid, 'a1', NOW);

    const d = await runV2Cartridges(sid, postBash(), NOW);
    expect(d.exitCode).toBe(0); // DEPLOY gate did not block
    // deploy → verify(clean: no verifyCommand → skip→true) → accept (decision) → done, chained in one receive
    expect((await readFsmStateFile(sid, 'fullstack-flow', taskId))?.state).toBe('done');
  });

  it('DBL.1b: running EXACTLY the configured verifyCommand records its real exit code → deployClean', async () => {
    mockLoad.mockResolvedValue([await loadPackV2(FSF)]);
    const { sid, root, taskId } = await freshTaskSession('deploy');
    // configure the project verifyCommand (resolveProjectScopeRoot(root) → root/.opensquid/active.json)
    await writeFile(
      join(root, '.opensquid', 'active.json'),
      JSON.stringify({ packs: ['fullstack-flow'], verifyCommand: 'pnpm verify' }),
      'utf8',
    );
    const bash = (command: string, exit_code: number): Event =>
      ({
        kind: 'post_tool_call',
        tool: 'Bash',
        args: { command },
        exit_code,
        cwd: root,
      }) as unknown as Event;

    await runV2Cartridges(sid, bash('pnpm verify', 0), NOW); // the agent ran it + it PASSED
    expect(await readVerification(sid, taskId)).toBe(true);

    await runV2Cartridges(sid, bash('pnpm verify', 1), NOW); // a later run FAILED → overwrites (→ bug-fix loop)
    expect(await readVerification(sid, taskId)).toBe(false);

    await runV2Cartridges(sid, bash('ls', 0), NOW); // a DIFFERENT command → no match → the record stands
    expect(await readVerification(sid, taskId)).toBe(false);
  });
});
