/** FAC-CUT.5b.2 — runV2Cartridges: in-process v2 host supply (inert / gate-fires+persist / non-trigger / fail-open). */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compilePackV2 } from '../../packs/compile_v2.js';
import { PackV2 } from '../../packs/schemas/pack_v2.js';
import type { LoadedPackV2 } from '../../packs/loader_v2.js';
import { atomicWriteFile } from '../../storage/atomic_file.js';
import { bindProject, workGraphStore } from '../../workgraph/store.js';
import { appendAsk, readCapturedAsk } from '../coverage/captured_ask.js';
import { writeGoalMap } from '../goal_map/goal_map.js';
import { readFsmStateRaw, readFsmState, fsmStateKey } from '../fsm_state.js';
import { OPENSQUID_HOME, sessionStateFile } from '../paths.js';
import {
  appendTool,
  clearActiveTask,
  recordSessionCwd,
  writeActiveTask,
} from '../session_state.js';
import { pendingLessonsDir } from '../wedge/capture.js';
import type { Event } from '../event.js';
import type { Fsm } from '../fsm.js';

// Mock the cartridge loader so each test controls the active v2 set.
vi.mock('../bootstrap.js', () => ({ loadActiveV2Cartridges: vi.fn() }));
import { loadActiveV2Cartridges } from '../bootstrap.js';
import { buildGuardCtx, runV2Cartridges } from './v2_supply.js';
import { RegistryGuardEvaluator } from './guard_evaluator.js';
import type { AuthorInputs } from './author_evidence.js';
import type { CodeEvidenceDeps } from './code_evidence.js';
import type { DeployEvidenceDeps } from './deploy_evidence.js';
import type { CodeIndex } from '../coverage/check.js';
import { Requirement } from '../coverage/schema.js';

const mockLoad = vi.mocked(loadActiveV2Cartridges);

/** Build a LoadedPackV2 from an inline PackV2 (mirrors v2_observed_actor.test.ts). */
function load(spec: unknown): LoadedPackV2 {
  const pack = PackV2.parse(spec);
  return {
    pack,
    compiled: compilePackV2(pack),
    guards: pack.guards,
    messages: pack.messages,
    skills: [],
  };
}

/** A gate triggered by tool_call whose guard is `tool == "Write"`. A `Bash` tool_call FAILS the guard →
 *  the `onFail` action fires (deterministic; `tool` is bound by buildGuardCtx, so no missing-key throw). */
const gatePack = (onFailAction: 'block' | 'warn') =>
  load({
    name: 'observed-gate',
    version: '1.0.0',
    scope: 'workflow',
    guards: { ok: 'tool == "Write"' },
    fsm: {
      initial: 'g0',
      states: {
        g0: {
          kind: 'gate',
          guard: 'ok',
          trigger: ['tool_call'],
          on_pass_emits: 'done',
          on_fail: { action: onFailAction, message: 'resolve it' },
        },
        shipped: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'g0', on: 'done', to: 'shipped' }],
    },
  });

const bashCall = (): Event => ({ kind: 'tool_call', tool: 'Bash', args: {} }) as unknown as Event;

const NOW = '2026-06-22T00:00:00.000Z';

beforeEach(() => mockLoad.mockReset());

describe('runV2Cartridges (FAC-CUT.5b.2)', () => {
  it('INERT: no active v2 cartridges → ZERO decision (the nothing-breaks path)', async () => {
    mockLoad.mockResolvedValue([]);
    const d = await runV2Cartridges('sess-inert', bashCall(), NOW);
    expect(d).toEqual({ exitCode: 0, messages: [], injections: [], boundSkills: [] });
  });

  it('gate FAIL + block → exitCode 2 + message; no advance (state stays at the gate)', async () => {
    mockLoad.mockResolvedValue([gatePack('block')]);
    const d = await runV2Cartridges('sess-block', bashCall(), NOW);
    expect(d.exitCode).toBe(2);
    expect(d.messages).toContain('resolve it');
    expect(d.injections).toEqual([]);
    expect(await readFsmStateRaw('sess-block', 'observed-gate')).toBeNull(); // block = no advance, no write
  });

  it('gate FAIL + warn → exitCode 0 + injection (nudge); advance persisted', async () => {
    mockLoad.mockResolvedValue([gatePack('warn')]);
    const d = await runV2Cartridges('sess-warn', bashCall(), NOW);
    expect(d.exitCode).toBe(0);
    expect(d.injections).toContain('resolve it');
    expect(d.messages).toEqual([]);
    expect(await readFsmStateRaw('sess-warn', 'observed-gate')).toBe('shipped'); // warn = advance + nudge
  });

  it('non-trigger event → ZERO, no state change (await-point)', async () => {
    mockLoad.mockResolvedValue([gatePack('block')]);
    const promptEvent = { kind: 'prompt_submit' } as unknown as Event;
    const d = await runV2Cartridges('sess-nt', promptEvent, NOW);
    expect(d).toEqual({ exitCode: 0, messages: [], injections: [], boundSkills: [] });
    expect(await readFsmStateRaw('sess-nt', 'observed-gate')).toBeNull();
  });

  it('FAIL-OPEN: a cartridge whose receive throws → ZERO for it, no throw escapes', async () => {
    // An fsm with NO meta for its initial state → V2ObservedActor.receive throws "no meta".
    const broken = {
      pack: { name: 'broken' },
      compiled: {
        fsm: { initial: 'x', states: ['x'], transitions: [] },
        meta: {},
        guardExprs: new Map(),
      },
      guards: {},
      messages: {},
    } as unknown as LoadedPackV2;
    mockLoad.mockResolvedValue([broken]);
    const d = await runV2Cartridges('sess-fo', bashCall(), NOW);
    expect(d).toEqual({ exitCode: 0, messages: [], injections: [], boundSkills: [] }); // swallowed, fail-open
  });
});

// ── T2.4 — the SCOPE gate over runV2Cartridges (short-circuit + block + capture) ──────────────────────────

/** A single-gate fullstack-like pack whose `scope` state carries the real T2.4 `scope_ready` guard. */
const scopeGatePack = (): LoadedPackV2 =>
  load({
    name: 'fsf-scope',
    version: '1.0.0',
    scope: 'workflow',
    guards: {
      scope_ready:
        '!scope.is_advance || (scope.anchors_ok && scope.depth >= 3 && !scope.open_question)',
    },
    fsm: {
      initial: 'scope',
      states: {
        scope: {
          kind: 'gate',
          guard: 'scope_ready',
          trigger: ['post_tool_call'],
          on_pass_emits: 'scoped',
          on_fail: { action: 'block', message: 'SCOPE: anchors∧depth≥3∧!open_question' },
        },
        scoped: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'scope', on: 'scoped', to: 'scoped' }],
    },
  });

/** A post_tool_call Write whose file_path is a pre-research artifact (the advance event). */
const advanceWrite = (filePath: string): Event =>
  ({
    kind: 'post_tool_call',
    tool: 'Write',
    args: { file_path: filePath },
    exit_code: 0,
  }) as unknown as Event;

/** A post_tool_call Bash (NOT an advance — no pre-research file_path). */
const nonAdvance = (): Event =>
  ({ kind: 'post_tool_call', tool: 'Bash', args: {}, exit_code: 0 }) as unknown as Event;

async function writePreResearch(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fsf-scope-'));
  // path must match /docs\/research\/.*-pre-research-/ to count as an advance
  const sub = join(dir, 'docs', 'research');
  const p = join(sub, 'T-x-pre-research-2026.md');
  await mkdir(sub, { recursive: true });
  await writeFile(p, body, 'utf8');
  return p;
}

describe('runV2Cartridges — T2.4 SCOPE gate', () => {
  it('non-advance event → is_advance false → guard short-circuits PASS (gate advances, no block)', async () => {
    mockLoad.mockResolvedValue([scopeGatePack()]);
    const d = await runV2Cartridges('sess-scope-na', nonAdvance(), NOW);
    expect(d.exitCode).toBe(0);
    expect(d.messages).toEqual([]);
    expect(await readFsmStateRaw('sess-scope-na', 'fsf-scope')).toBe('scoped'); // passed → advanced
  });

  it('NOT-READY advance (no captured ask, no depth) → BLOCK, no advance', async () => {
    mockLoad.mockResolvedValue([scopeGatePack()]);
    const p = await writePreResearch('1. Login [ask: "add login"]'); // off-ask (no captured ask) → drift
    const d = await runV2Cartridges('sess-scope-block', advanceWrite(p), NOW);
    expect(d.exitCode).toBe(2);
    expect(d.messages).toContain('SCOPE: anchors∧depth≥3∧!open_question');
    expect(await readFsmStateRaw('sess-scope-block', 'fsf-scope')).toBeNull(); // blocked → stayed
  });

  it('READY advance (ask resolves + depth≥3 + no open-q) → PASS, advances', async () => {
    const sid = 'sess-scope-pass';
    mockLoad.mockResolvedValue([scopeGatePack()]);
    await appendAsk(sid, 'add login screen');
    for (let i = 0; i < 3; i++) await appendTool(sid, 'Read'); // depth = 3
    const p = await writePreResearch('1. Login [ask: "add login screen"]');
    const d = await runV2Cartridges(sid, advanceWrite(p), NOW);
    expect(d.exitCode).toBe(0);
    expect(d.messages).toEqual([]);
    expect(await readFsmStateRaw(sid, 'fsf-scope')).toBe('scoped'); // ready → advanced
  });

  it('AD.1 capture: a prompt_submit populates the captured ask when a v2 cartridge is active', async () => {
    const sid = 'sess-scope-capture';
    mockLoad.mockResolvedValue([scopeGatePack()]);
    const promptEvent = { kind: 'prompt_submit', prompt: 'build the thing' } as unknown as Event;
    await runV2Cartridges(sid, promptEvent, NOW);
    expect((await readCapturedAsk(sid)).turns).toEqual(['build the thing']);
  });
});

// ── T2.5 — the PLAN gate binding over buildGuardCtx (acyclic ∧ complete, fail-closed) ──────────────────────

const PRE_RESEARCH_PATH_KEY = 'fullstack-flow-pre-research-path';

/** Stamp the captured pre-research path (what the SCOPE advance does) for the PLAN gate to read. */
async function stampPreResearch(sessionId: string, p: string): Promise<void> {
  await atomicWriteFile(sessionStateFile(sessionId, PRE_RESEARCH_PATH_KEY), JSON.stringify(p));
}

/** Populate the HOME work-graph (legacy-global — the project a marker-less session resolves to). */
async function populateWg(
  issues: { title: string; body: string }[],
  edges: [number, number][] = [],
): Promise<void> {
  const store = workGraphStore({
    dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
    sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
  });
  await store.init();
  const wg = bindProject(store, 'legacy-global');
  const ids: string[] = [];
  for (const i of issues) ids.push((await wg.createIssue(i)).id);
  for (const [f, t] of edges) {
    const from = ids[f];
    const to = ids[t];
    if (from !== undefined && to !== undefined) await wg.addEdge(from, to, 'blocks');
  }
}

describe('buildGuardCtx — T2.5 PLAN binding', () => {
  const ev = { kind: 'post_tool_call', tool: 'Bash', args: {}, exit_code: 0 } as unknown as Event;

  it('binds plan.acyclic/plan.complete dual-shape (flat + nested)', async () => {
    const ctx = await buildGuardCtx(ev, 'sess-plan-shape', 'plan');
    expect(ctx.has('plan.acyclic')).toBe(true);
    expect(ctx.has('plan.complete')).toBe(true);
    const nested = ctx.get('plan') as { acyclic: boolean; complete: boolean };
    expect(typeof nested.acyclic).toBe('boolean');
    expect(typeof nested.complete).toBe('boolean');
  });

  it('FAIL-CLOSED: no captured pre-research path → plan.acyclic=false, plan.complete=false', async () => {
    const ctx = await buildGuardCtx(ev, 'sess-plan-noscope', 'plan');
    expect(ctx.get('plan.acyclic')).toBe(false);
    expect(ctx.get('plan.complete')).toBe(false);
  });

  it('populated + acyclic + every element covered → plan.acyclic=true, plan.complete=true', async () => {
    const sid = 'sess-plan-ok';
    const dir = await mkdtemp(join(tmpdir(), 'plan-ok-'));
    const sub = join(dir, 'docs', 'research');
    const p = join(sub, 'T-x-pre-research-2026.md');
    await mkdir(sub, { recursive: true });
    await writeFile(
      p,
      ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]'].join('\n'),
      'utf8',
    );
    await stampPreResearch(sid, p);
    await populateWg(
      [
        { title: 'scope-1', body: 'sourceElementId:scope-1' },
        { title: 'scope-2', body: 'sourceElementId:scope-2' },
      ],
      [[0, 1]],
    );
    const ctx = await buildGuardCtx(ev, sid, 'plan');
    expect(ctx.get('plan.acyclic')).toBe(true);
    expect(ctx.get('plan.complete')).toBe(true);
  });
});

// ── T2.6 — the AUTHOR gate binding over buildGuardCtx (coverage_complete ∧ real_code) ──────────────────────

const authorEv = {
  kind: 'post_tool_call',
  tool: 'Bash',
  args: {},
  exit_code: 0,
} as unknown as Event;

const idx = (o: Partial<CodeIndex>): CodeIndex => ({
  exports: [],
  modules: [],
  bindings: {},
  tests: {},
  importGraph: { reaches: () => false },
  ...o,
});
const proofReq = (id: string, test: string): Requirement =>
  Requirement.parse({ id, intent: 'x', assert: { kind: 'proof', test } });
const authorInputs = (reqs: Requirement[], index: CodeIndex): AuthorInputs => ({
  reqs,
  opts: { gatedPrefixes: ['src/', 'packs/'], index },
});

// The real `author_ready` guard expression, evaluated over the nested `author` object buildGuardCtx binds.
const AUTHOR_GUARD = new RegistryGuardEvaluator(
  new Map([['author_ready', 'author.coverage_complete && author.real_code']]),
);

describe('buildGuardCtx — T2.6 AUTHOR binding', () => {
  it('binds author.coverage_complete/author.real_code dual-shape (flat + nested)', async () => {
    const ai = authorInputs(
      [proofReq('R-A', 'src/a.test.ts')],
      idx({ tests: { 'src/a.test.ts': { activeCount: 1 } } }),
    );
    const ctx = await buildGuardCtx(authorEv, 'sess-author-shape', 'author', ai);
    expect(ctx.has('author.coverage_complete')).toBe(true);
    expect(ctx.has('author.real_code')).toBe(true);
    const nested = ctx.get('author') as { coverage_complete: boolean; real_code: boolean };
    expect(typeof nested.coverage_complete).toBe('boolean');
    expect(typeof nested.real_code).toBe('boolean');
  });

  it('all-met + zero-orphan → both true → author_ready PASSES (gate advances)', async () => {
    const ai = authorInputs(
      [proofReq('R-A', 'src/a.test.ts')],
      idx({ tests: { 'src/a.test.ts': { activeCount: 1 } } }),
    );
    const ctx = await buildGuardCtx(authorEv, 'sess-author-pass', 'author', ai);
    expect(ctx.get('author.coverage_complete')).toBe(true);
    expect(ctx.get('author.real_code')).toBe(true);
    expect(AUTHOR_GUARD.eval('author_ready', ctx)).toBe(true); // gate would advance
  });

  it('an ORPHAN → coverage_complete:false → author_ready BLOCKS', async () => {
    const ai = authorInputs(
      [proofReq('R-A', 'src/a.test.ts')],
      idx({
        tests: { 'src/a.test.ts': { activeCount: 1 } },
        exports: [{ name: 'orphanSym', file: 'src/o.ts' }], // gated export with no requirement
      }),
    );
    const ctx = await buildGuardCtx(authorEv, 'sess-author-orphan', 'author', ai);
    expect(ctx.get('author.coverage_complete')).toBe(false);
    expect(AUTHOR_GUARD.eval('author_ready', ctx)).toBe(false); // gate would block (on_fail: block)
  });

  it('a failing/absent proof-test → real_code:false → author_ready BLOCKS (declared ≠ wired)', async () => {
    const ai = authorInputs([proofReq('R-STUB', 'src/stub.test.ts')], idx({})); // proof absent → unmet
    const ctx = await buildGuardCtx(authorEv, 'sess-author-stub', 'author', ai);
    expect(ctx.get('author.real_code')).toBe(false);
    expect(AUTHOR_GUARD.eval('author_ready', ctx)).toBe(false);
  });

  it('FAIL-CLOSED: unresolvable repo (no injected inputs, no session cwd) → both false → BLOCKS', async () => {
    const ctx = await buildGuardCtx(authorEv, 'sess-author-noscope-xyz', 'author');
    expect(ctx.get('author.coverage_complete')).toBe(false);
    expect(ctx.get('author.real_code')).toBe(false);
    expect(AUTHOR_GUARD.eval('author_ready', ctx)).toBe(false);
  });
});

// ── T2.7 — the CODE gate binding over buildGuardCtx (phases_complete ∧ readiness_ran ∧ deprecated_clean) ─────

const codeEv = {
  kind: 'post_tool_call',
  tool: 'Bash',
  args: {},
  exit_code: 0,
} as unknown as Event;

/** Injectable pure CODE deps — a fixed task + the three facets a test wants the producer to read. */
const codeDeps = (
  phasesComplete: boolean,
  ran: boolean,
  deprecatedClean: boolean,
): CodeEvidenceDeps => ({
  activeTaskId: () => Promise.resolve('T2.7'),
  // a PhaseState whose `isComplete` is `phasesComplete`: all-7 when complete, one phase when not.
  phaseState: () =>
    Promise.resolve(
      phasesComplete
        ? {
            task_id: 'T2.7',
            phases: ['pre_research', 'learn', 'code', 'test', 'audit', 'post_research', 'fix'],
          }
        : { task_id: 'T2.7', phases: ['pre_research'] },
    ),
  readiness: () => Promise.resolve({ ran, deprecatedClean }),
});

// The real `code_ready` guard expression, evaluated over the nested `code` object buildGuardCtx binds.
const CODE_GUARD = new RegistryGuardEvaluator(
  new Map([['code_ready', 'code.phases_complete && code.readiness_ran && code.deprecated_clean']]),
);

describe('buildGuardCtx — T2.7 CODE binding', () => {
  it('binds code.phases_complete/readiness_ran/deprecated_clean dual-shape (flat + nested)', async () => {
    const ctx = await buildGuardCtx(
      codeEv,
      'sess-code-shape',
      'code',
      undefined,
      codeDeps(true, true, true),
    );
    expect(ctx.has('code.phases_complete')).toBe(true);
    expect(ctx.has('code.readiness_ran')).toBe(true);
    expect(ctx.has('code.deprecated_clean')).toBe(true);
    const nested = ctx.get('code') as {
      phases_complete: boolean;
      readiness_ran: boolean;
      deprecated_clean: boolean;
    };
    expect(typeof nested.phases_complete).toBe('boolean');
    expect(typeof nested.readiness_ran).toBe('boolean');
    expect(typeof nested.deprecated_clean).toBe('boolean');
  });

  it('complete phases + clean readiness → all true → code_ready PASSES (gate advances)', async () => {
    const ctx = await buildGuardCtx(
      codeEv,
      'sess-code-pass',
      'code',
      undefined,
      codeDeps(true, true, true),
    );
    expect(ctx.get('code.phases_complete')).toBe(true);
    expect(ctx.get('code.readiness_ran')).toBe(true);
    expect(ctx.get('code.deprecated_clean')).toBe(true);
    expect(CODE_GUARD.eval('code_ready', ctx)).toBe(true); // gate would advance
  });

  it('a deprecated hit → deprecated_clean:false → code_ready BLOCKS (results-gating, not just "ran")', async () => {
    const ctx = await buildGuardCtx(
      codeEv,
      'sess-code-dep',
      'code',
      undefined,
      codeDeps(true, true, false),
    );
    expect(ctx.get('code.readiness_ran')).toBe(true); // it RAN…
    expect(ctx.get('code.deprecated_clean')).toBe(false); // …but a deprecated hit BLOCKS
    expect(CODE_GUARD.eval('code_ready', ctx)).toBe(false);
  });

  it('incomplete phases → phases_complete:false → code_ready BLOCKS', async () => {
    const ctx = await buildGuardCtx(
      codeEv,
      'sess-code-incomplete',
      'code',
      undefined,
      codeDeps(false, true, true),
    );
    expect(ctx.get('code.phases_complete')).toBe(false);
    expect(CODE_GUARD.eval('code_ready', ctx)).toBe(false);
  });

  it('never-run readiness → readiness_ran:false → code_ready BLOCKS (fail-closed)', async () => {
    const ctx = await buildGuardCtx(
      codeEv,
      'sess-code-norun',
      'code',
      undefined,
      codeDeps(true, false, false),
    );
    expect(ctx.get('code.readiness_ran')).toBe(false);
    expect(CODE_GUARD.eval('code_ready', ctx)).toBe(false);
  });

  it('FAIL-CLOSED: no active task (default deps, no signal) → all false → BLOCKS', async () => {
    const ctx = await buildGuardCtx(codeEv, 'sess-code-notask-xyz', 'code');
    expect(ctx.get('code.phases_complete')).toBe(false);
    expect(ctx.get('code.readiness_ran')).toBe(false);
    expect(ctx.get('code.deprecated_clean')).toBe(false);
    expect(CODE_GUARD.eval('code_ready', ctx)).toBe(false);
  });
});

// ── T2.8 — the DEPLOY gate binding over buildGuardCtx (capability_ok ∧ the durable accept decision) ──────────

const deployEv = {
  kind: 'post_tool_call',
  tool: 'Bash',
  args: {},
  exit_code: 0,
} as unknown as Event;

/** Injectable pure DEPLOY deps — a fixed task + a capability verdict (null=skip→true) + an acceptance set. */
const deployDeps = (
  capabilityCheck: boolean | null,
  acceptance: { taskId: string; status: string }[],
): DeployEvidenceDeps => ({
  activeTaskId: () => Promise.resolve('T2.8'),
  capabilityCheck: () => Promise.resolve(capabilityCheck),
  acceptance: () => Promise.resolve(acceptance),
});

// The real `deploy_ready` + `accepted` guard expressions, evaluated over the nested `deploy` object.
const DEPLOY_GUARD = new RegistryGuardEvaluator(
  new Map([
    ['deploy_ready', 'deploy.capability_ok'],
    ['accepted', 'deploy.accepted'],
  ]),
);

describe('buildGuardCtx — T2.8 DEPLOY binding', () => {
  it('binds deploy.capability_ok/deploy.accepted dual-shape (flat + nested)', async () => {
    const ctx = await buildGuardCtx(
      deployEv,
      'sess-deploy-shape',
      'deploy',
      undefined,
      undefined,
      deployDeps(null, []),
    );
    expect(ctx.has('deploy.capability_ok')).toBe(true);
    expect(ctx.has('deploy.accepted')).toBe(true);
    const nested = ctx.get('deploy') as { capability_ok: boolean; accepted: boolean };
    expect(typeof nested.capability_ok).toBe('boolean');
    expect(typeof nested.accepted).toBe('boolean');
  });

  it('no deploy env (skip) → capability_ok:true → deploy_ready PASSES (gate advances)', async () => {
    const ctx = await buildGuardCtx(
      deployEv,
      'sess-deploy-skip',
      'deploy',
      undefined,
      undefined,
      deployDeps(null, []),
    );
    expect(ctx.get('deploy.capability_ok')).toBe(true);
    expect(DEPLOY_GUARD.eval('deploy_ready', ctx)).toBe(true);
  });

  it('a waiting (unaccepted) item → accepted:false → the accept decision LOOPS to plan (never ships)', async () => {
    const ctx = await buildGuardCtx(
      deployEv,
      'sess-deploy-waiting',
      'accept',
      undefined,
      undefined,
      deployDeps(null, [{ taskId: 'T2.8', status: 'waiting' }]),
    );
    expect(ctx.get('deploy.accepted')).toBe(false);
    expect(DEPLOY_GUARD.eval('accepted', ctx)).toBe(false); // else branch → rejected → plan
  });

  it('a marked-accepted item → accepted:true → the accept decision SHIPS to done', async () => {
    const ctx = await buildGuardCtx(
      deployEv,
      'sess-deploy-accepted',
      'accept',
      undefined,
      undefined,
      deployDeps(null, [{ taskId: 'T2.8', status: 'accepted' }]),
    );
    expect(ctx.get('deploy.accepted')).toBe(true);
    expect(DEPLOY_GUARD.eval('accepted', ctx)).toBe(true);
  });

  it('FAIL-CLOSED: default deps (no deploy env, no acceptance) → capability_ok:true, accepted:false', async () => {
    const ctx = await buildGuardCtx(deployEv, 'sess-deploy-default-xyz', 'deploy');
    expect(ctx.get('deploy.capability_ok')).toBe(true); // no deploy env wired → skip
    expect(ctx.get('deploy.accepted')).toBe(false); // no accepted item → never auto-ship
  });
});

// ── T2.2 — per-task FSM key wired through runV2Cartridges (resolve active taskId; no cross-task rewind) ───────

const FSM_MACHINE: Fsm = {
  initial: 'g0',
  states: ['g0', 'shipped'],
  transitions: [{ from: 'g0', on: 'done', to: 'shipped' }],
};

describe('runV2Cartridges — T2.2 per-task FSM key', () => {
  it('no active task → reads/writes the null (session-level) key; per-task key stays at initial', async () => {
    const sid = 'sess-t22-null';
    await clearActiveTask(sid);
    mockLoad.mockResolvedValue([gatePack('warn')]); // warn-gate advances g0→shipped on a non-Write
    await runV2Cartridges(sid, bashCall(), NOW);
    // Persisted to the NULL key (SCOPE/PLAN-shared) — readFsmStateRaw keys fsm-<pack>.
    expect(await readFsmStateRaw(sid, 'observed-gate')).toBe('shipped');
    // A per-task read sees a FRESH machine (the null state is invisible to a task key).
    expect(await readFsmState(sid, 'observed-gate', FSM_MACHINE, 'A')).toBe('g0');
  });

  it('a SECOND task gets its OWN AUTHOR/CODE FSM; activating it does NOT rewind the first', async () => {
    const sid = 'sess-t22-twotask';
    mockLoad.mockResolvedValue([gatePack('warn')]);

    // Task A active → the cartridge resolves taskId 'A' and persists to fsm-observed-gate-A.
    await writeActiveTask(sid, { id: '1', subject: 'task A', started_at: NOW, taskId: 'A' });
    await runV2Cartridges(sid, bashCall(), NOW);
    expect(await readFsmState(sid, 'observed-gate', FSM_MACHINE, 'A')).toBe('shipped');

    // Switch to task B → a FRESH key (fsm-observed-gate-B) that STARTS at the initial state.
    await writeActiveTask(sid, { id: '2', subject: 'task B', started_at: NOW, taskId: 'B' });
    // Before B runs, B's key is unstarted (initial) — A's activation never seeded it.
    expect(await readFsmState(sid, 'observed-gate', FSM_MACHINE, 'B')).toBe('g0');
    await runV2Cartridges(sid, bashCall(), NOW);
    expect(await readFsmState(sid, 'observed-gate', FSM_MACHINE, 'B')).toBe('shipped');

    // CRITICAL: task A's FSM is UNTOUCHED by B's lifecycle — no cross-task rewind / leakage.
    expect(await readFsmState(sid, 'observed-gate', FSM_MACHINE, 'A')).toBe('shipped');
    // The two tasks occupy DISTINCT session-state keys.
    expect(fsmStateKey('observed-gate', 'A')).not.toBe(fsmStateKey('observed-gate', 'B'));
    await clearActiveTask(sid);
  });

  it('falls back to the harness numeric id when no metadata.taskId is set', async () => {
    const sid = 'sess-t22-numeric';
    mockLoad.mockResolvedValue([gatePack('warn')]);
    await writeActiveTask(sid, { id: '42', subject: 'no track id', started_at: NOW }); // no taskId
    await runV2Cartridges(sid, bashCall(), NOW);
    // taskId resolves to the numeric id '42' → keyed fsm-observed-gate-42.
    expect(await readFsmState(sid, 'observed-gate', FSM_MACHINE, '42')).toBe('shipped');
    await clearActiveTask(sid);
  });
});

// ── T2.3 — buildGuardCtx binds the nested `verdict` object beside the shipped flat `verdict.guess` ───────────
// R-AUDIT-CTX (ARCHITECTURE.md:290) requires the FLAT `verdict.guess` key stays bound; T2.3 ADDS a nested
// `verdict` object so `verdict.guess` path-resolves both ways (dual-shape, additive — pre-research §6).
describe('buildGuardCtx — T2.3 verdict dual-shape', () => {
  const ev = { kind: 'post_tool_call', tool: 'Bash', args: {}, exit_code: 0 } as unknown as Event;

  it('binds the flat verdict.guess/verdict.spec keys (R-AUDIT-CTX stays MET)', async () => {
    const ctx = await buildGuardCtx(ev, 'sess-verdict-flat-xyz', 'scope');
    expect(ctx.has('verdict.guess')).toBe(true);
    expect(ctx.has('verdict.spec')).toBe(true);
  });

  it('also binds a nested verdict object whose .guess/.spec equal the flat keys', async () => {
    const ctx = await buildGuardCtx(ev, 'sess-verdict-nested-xyz', 'scope');
    const nested = ctx.get('verdict') as { guess: unknown; spec: unknown };
    expect(nested).toBeTypeOf('object');
    expect(nested.guess).toBe(ctx.get('verdict.guess'));
    expect(nested.spec).toBe(ctx.get('verdict.spec'));
  });

  it('a guard expression resolves verdict.guess via the nested path', async () => {
    const ctx = await buildGuardCtx(ev, 'sess-verdict-guard-xyz', 'scope');
    // no audit-cache for this fresh session → fail-open undefined → the guard is falsy, but it RESOLVES (no throw).
    const guard = new RegistryGuardEvaluator(new Map([['has_guess', 'verdict.guess == "PASS"']]));
    expect(() => guard.eval('has_guess', ctx)).not.toThrow();
  });
});

// ── T2.12 — the LIVE per-stage report trigger (leaving SCOPE/PLAN/AUTHOR/DEPLOY emits its report) ──────────
// runV2Cartridges, on each FSM transition leaving SCOPE/PLAN/AUTHOR/DEPLOY, emits a dated docs/reports/ file
// under the SESSION CWD + mirrors the body into the session memory buffer. CODE is NOT emitted here (T2.9's
// loop_driver owns it). All deterministic: iso (NOW) injected, unique session ids, a temp project root.

/** A one-state gate pack whose state is named `<stage>` and PASSES (advances to terminal) on a tool_call.
 *  Leaving `<stage>` is the transition the T2.12 trigger reports on. */
const stageGatePack = (stage: string): LoadedPackV2 =>
  load({
    name: `fsf-${stage}`,
    version: '1.0.0',
    scope: 'workflow',
    guards: { always: 'tool == "Write"' },
    fsm: {
      initial: stage,
      states: {
        [stage]: {
          kind: 'gate',
          guard: 'always',
          trigger: ['tool_call'],
          on_pass_emits: 'next',
          on_fail: { action: 'warn', message: 'n/a' },
        },
        done: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: stage, on: 'next', to: 'done' }],
    },
  });

const writeCall = (): Event =>
  ({ kind: 'tool_call', tool: 'Write', args: { file_path: '/tmp/x.ts' } }) as unknown as Event;

/** A temp project root recorded as the session cwd (where docs/reports/ is written). The `.opensquid` marker
 *  makes it project-SCOPED so per-test goal maps (goalMapPath → resolveProjectScopeRoot) don't collide on the
 *  shared user-scope fallback. */
async function newProjectRoot(sessionId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 't212-root-'));
  await mkdir(join(root, '.opensquid'), { recursive: true });
  await recordSessionCwd(sessionId, root);
  return root;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('runV2Cartridges — T2.12 per-stage report trigger', () => {
  for (const [stateName, stageUpper] of [
    ['scope', 'SCOPE'],
    ['plan', 'PLAN'],
    ['author', 'AUTHOR'],
    ['deploy', 'DEPLOY'],
  ] as const) {
    it(`leaving ${stageUpper} emits its dated report file + a memory mirror`, async () => {
      const sid = `sess-t212-${stateName}`;
      const root = await newProjectRoot(sid);
      await writeActiveTask(sid, {
        id: '1',
        subject: 's',
        started_at: NOW,
        taskId: 'T-rep',
      });
      mockLoad.mockResolvedValue([stageGatePack(stateName)]);

      const d = await runV2Cartridges(sid, writeCall(), NOW);
      expect(d.exitCode).toBe(0);

      // 1) the dated file under the SESSION CWD docs/reports/ (NOT the real repo).
      const reportPath = join(root, 'docs', 'reports', `${stateName}-T-rep-2026-06-22.md`);
      expect(await exists(reportPath)).toBe(true);
      const body = await readFile(reportPath, 'utf8');
      expect(body).toContain(`🦑 Phase report — ${stageUpper} complete · T-rep ·`);
      expect(body).toContain('Summary:');
      expect(body).toContain('Next →');

      // 2) the memory mirror — a pending lesson whose content is the report body.
      const lessonsDir = join(pendingLessonsDir(sid), 'potential-lessons');
      const files = await readdir(lessonsDir);
      expect(files.length).toBe(1);
      const mirror = await readFile(join(lessonsDir, files[0]!), 'utf8');
      expect(mirror).toContain(`🦑 Phase report — ${stageUpper} complete · T-rep ·`);
    });
  }

  it('CODE is NOT emitted here (a transition leaving `code` writes no report) — T2.9 owns it', async () => {
    const sid = 'sess-t212-code';
    const root = await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-rep' });
    mockLoad.mockResolvedValue([stageGatePack('code')]);

    await runV2Cartridges(sid, writeCall(), NOW);

    // no docs/reports/ dir created at all (CODE not in the STAGE map).
    expect(await exists(join(root, 'docs', 'reports'))).toBe(false);
    // and no memory mirror was written.
    expect(await exists(join(pendingLessonsDir(sid), 'potential-lessons'))).toBe(false);
  });

  // T2.10 — the SCOPE report's goal-alignment line is now the LIVE consumer of goalConsult.
  it('SCOPE report carries the goal-alignment line (no goal map → on the captured goal)', async () => {
    const sid = 'sess-t210-scope-nogoal';
    const root = await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-rep' });
    mockLoad.mockResolvedValue([stageGatePack('scope')]);

    await runV2Cartridges(sid, writeCall(), NOW);

    const body = await readFile(join(root, 'docs', 'reports', 'scope-T-rep-2026-06-22.md'), 'utf8');
    expect(body).toContain('Goal: on the captured goal'); // absent goal → aligned:true (not a drift signal)
  });

  it('SCOPE report surfaces destination drift when the goal is disjoint from the captured ask', async () => {
    const sid = 'sess-t210-scope-drift';
    const root = await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-rep' });
    await writeGoalMap(root, {
      goal: 'Migrate the billing subsystem to Stripe',
      createdAt: NOW,
      claim: null,
      worksheets: [],
    });
    await appendAsk(sid, 'tweak the homepage banner colors'); // disjoint from the goal
    mockLoad.mockResolvedValue([stageGatePack('scope')]);

    await runV2Cartridges(sid, writeCall(), NOW);

    const body = await readFile(join(root, 'docs', 'reports', 'scope-T-rep-2026-06-22.md'), 'utf8');
    expect(body).toContain('OFF the captured goal — destination drift');
  });

  it('a non-SCOPE stage report carries NO goal-alignment line (the check belongs at scope-time)', async () => {
    const sid = 'sess-t210-plan-noline';
    const root = await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-rep' });
    mockLoad.mockResolvedValue([stageGatePack('plan')]);

    await runV2Cartridges(sid, writeCall(), NOW);

    const body = await readFile(join(root, 'docs', 'reports', 'plan-T-rep-2026-06-22.md'), 'utf8');
    expect(body).not.toContain('## Goal alignment');
  });
});
