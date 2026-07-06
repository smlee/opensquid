/** FAC-CUT.5b.2 — runV2Cartridges: in-process v2 host supply (inert / gate-fires+persist / non-trigger / fail-open). */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
  writeClassifiedFacets,
} from '../session_state.js';
import { pendingLessonsDir } from '../wedge/capture.js';
import { withTaskCheckpointStore } from '../ralph/loop_stage.js';
import { appendPhase, REQUIRED_PHASES } from '../workflow_phases.js';
import { readinessResult } from './readiness.js';
import { recordExternalConsult } from './external_consult.js';
import { appendAcceptance, readAcceptance } from './acceptance.js';
import type { Event } from '../event.js';
import type { Fsm } from '../fsm.js';
import type { Facets } from '../classify.js';

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

/** LAYER-1 #37 — a serves-bearing FSM gate pack (`serves.domain = coding`). ORCH.8 requires a serves+fsm pack to
 *  start at a `gate` state (g0 is a gate). Its gate BLOCKS a `Bash` tool_call (guard `tool == "Write"` fails), so
 *  a block proves the cartridge was SELECTED + evaluated; a ZERO/no-advance proves it was NOT selected. */
const codingGatePack = () =>
  load({
    name: 'coding-gate',
    version: '1.0.0',
    scope: 'workflow',
    serves: { intent: 'produce', domain: 'coding' },
    guards: { ok: 'tool == "Write"' },
    fsm: {
      initial: 'g0',
      states: {
        g0: {
          kind: 'gate',
          guard: 'ok',
          trigger: ['tool_call'],
          on_pass_emits: 'done',
          on_fail: { action: 'block', message: 'coding gate' },
        },
        shipped: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'g0', on: 'done', to: 'shipped' }],
    },
  });

const bashCall = (): Event => ({ kind: 'tool_call', tool: 'Bash', args: {} }) as unknown as Event;
/** A Bash tool_call with a file-writing redirect — always mutating (isMutatingCall → true). */
const mutatingBashCall = (): Event =>
  ({
    kind: 'tool_call',
    tool: 'Bash',
    args: { command: 'echo x > /tmp/out.txt' },
  }) as unknown as Event;

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

  it('V2-ENF.2/6 (§5.4b) — a gate that HOLDS emits a SAVED + SURFACED held_gate failure report', async () => {
    const sid = 'sess-block-failrep';
    const root = await newProjectRoot(sid); // records a project-scoped cwd so the report can be SAVED
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-hold' });
    mockLoad.mockResolvedValue([gatePack('block')]);
    const d = await runV2Cartridges(sid, bashCall(), NOW); // Bash fails guard `tool=="Write"` → the gate HOLDS
    expect(d.exitCode).toBe(2); // the block decision still stands (the failure report never changes it)
    expect(d.messages).toContain('resolve it');
    // SURFACED: the failure report body is injected in-session, plain header, NEVER the reserved `🦑`.
    const inj = d.injections.join('\n');
    expect(inj).toContain('Failure report — held_gate · T-hold');
    expect(inj).toContain('Reason:');
    expect(inj).toContain('Failing criterion:');
    expect(inj).toContain('Resolving action:');
    expect(inj).not.toContain('🦑');
    // SAVED: a dated failure file under <project>/.opensquid/reports/ (NEVER the global home).
    const saved = join(root, '.opensquid', 'reports', 'failure-T-hold-2026-06-22.md');
    expect(await exists(saved)).toBe(true);
    expect(await readFile(saved, 'utf8')).toContain('Failure report — held_gate · T-hold');
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

// ── LAYER-1 #37 — serves-gated FSM selection (project-only-operation.md:139-147) ─────────────────────────────
// The FSM gate path selects a serves-bearing cartridge ONLY when the current task's classified domain is
// at-or-below the pack's served domain (hierarchical containment); a task outside that domain selects NOTHING
// (no gate, no enforcement). Domain-only (intent-agnostic). A serves-LESS FSM pack is the always-on spine.
describe('runV2Cartridges — LAYER-1 #37 serves-gated FSM selection', () => {
  const facets = (domain?: string): Facets => ({
    intent: 'produce',
    project: true,
    confidence: 'high',
    ...(domain ? { domain } : {}),
  });

  it('a CODING task selects the serves-bearing pack → its gate evaluates + BLOCKS', async () => {
    mockLoad.mockResolvedValue([codingGatePack()]);
    const sid = 'sess-l1-coding';
    await writeClassifiedFacets(sid, facets('coding'));
    const d = await runV2Cartridges(sid, bashCall(), NOW);
    expect(d.exitCode).toBe(2); // selected → the gate ran + blocked
    expect(d.messages).toContain('coding gate');
  });

  it('a FRONTEND task (coding.frontend) selects it by hierarchical containment', async () => {
    mockLoad.mockResolvedValue([codingGatePack()]);
    const sid = 'sess-l1-fe';
    await writeClassifiedFacets(sid, facets('coding.frontend'));
    const d = await runV2Cartridges(sid, bashCall(), NOW);
    expect(d.exitCode).toBe(2); // coding.frontend ⊑ coding → selected
  });

  it('a NON-coding task selects NOTHING → no gate, no enforcement (exit 0, no advance)', async () => {
    mockLoad.mockResolvedValue([codingGatePack()]);
    const sid = 'sess-l1-design';
    await writeClassifiedFacets(sid, facets('design')); // a real non-coding root
    const d = await runV2Cartridges(sid, bashCall(), NOW);
    expect(d).toEqual({ exitCode: 0, messages: [], injections: [], boundSkills: [] });
    expect(await readFsmStateRaw(sid, 'coding-gate')).toBeNull(); // never ran → no state written
  });

  it('a serves-LESS FSM pack is the always-on spine (runs + enforces even on a non-coding task)', async () => {
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-l1-spine';
    await writeClassifiedFacets(sid, facets('design'));
    const d = await runV2Cartridges(sid, bashCall(), NOW);
    expect(d.exitCode).toBe(2); // serves-less → never gated → still enforces
  });
});

// ── PART A — enforceOnly mode: gate-check-only, no state advance ─────────────────────────────────────────────
// Tests for the `enforceOnly: true` flag added to `runV2Cartridges`.
// A gate with `trigger: ['post_tool_call']` whose guard fails on a `Bash` tool_call is used throughout.
// enforceOnly bypasses the trigger filter (v2_observed_actor.ts:67) so the gate evaluates on the `tool_call`
// event from PreToolUse. Blanket-block-with-exemptions: MUTATING + no agentId → exitCode 2; read-only or
// executor (agentId) → exitCode 0. block/halt + NO state advance.
//
// NOTE: advance-only tests from a prior pass (task #33) are superseded here. That design blocked only the
// "advance-triggering action" per stage; the lane-model redesign (task #35) will handle that. The current
// design is blanket-block-mutating-with-exemptions (read-only bypass + executor exemption), which is simpler
// and correct for the automation-enforcement use case.

describe('runV2Cartridges — enforceOnly mode (PART A)', () => {
  it('enforceOnly + guard FAIL + block + MUTATING + no agentId → exitCode 2 (blanket-block)', async () => {
    // mutatingBashCall() has command: 'echo x > /tmp/out.txt' — isMutatingCall → true.
    // No agentId → no executor exemption. Failing gate + enforceOnly → exitCode 2.
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-enforce-block';
    const d = await runV2Cartridges(sid, mutatingBashCall(), NOW, { enforceOnly: true });
    expect(d.exitCode).toBe(2); // mutating + no agentId + failing gate → blocked
    expect(d.messages).toContain('resolve it');
    expect(d.injections).toEqual([]); // enforceOnly: warn injections discarded (PostToolUse owns them)
    // No state advance: enforceOnly skips write_state.
    expect(await readFsmStateRaw(sid, 'observed-gate')).toBeNull();
  });

  it('enforceOnly + guard FAIL + warn → exitCode 0, NO injection (PostToolUse owns warn), no advance', async () => {
    mockLoad.mockResolvedValue([gatePack('warn')]);
    const sid = 'sess-enforce-warn';
    const d = await runV2Cartridges(sid, bashCall(), NOW, { enforceOnly: true });
    expect(d.exitCode).toBe(0); // warn does NOT block in enforceOnly
    expect(d.injections).toEqual([]); // warn injection skipped in enforceOnly
    expect(d.messages).toEqual([]);
    // No advance: warn in enforceOnly skips write_state (PostToolUse owns the advance).
    expect(await readFsmStateRaw(sid, 'observed-gate')).toBeNull();
  });

  it('enforceOnly + guard PASS → exitCode 0, no deny, no state advance', async () => {
    // A Write event satisfies the guard (tool == "Write" → pass).
    const writeEvent = {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: '/tmp/x.ts' },
    } as unknown as Event;
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-enforce-pass';
    const d = await runV2Cartridges(sid, writeEvent, NOW, { enforceOnly: true });
    expect(d.exitCode).toBe(0); // guard passed → no deny
    expect(d.messages).toEqual([]);
    // No advance: even a passing gate skips write_state in enforceOnly.
    expect(await readFsmStateRaw(sid, 'observed-gate')).toBeNull();
  });

  it('enforceOnly false/absent → existing block behavior UNCHANGED (write_state + advance)', async () => {
    // Regression: enforceOnly:false must behave identically to the prior code path.
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-enforce-absent';
    const d = await runV2Cartridges(sid, bashCall(), NOW);
    expect(d.exitCode).toBe(2);
    expect(d.messages).toContain('resolve it');
    // Block with no enforceOnly → still no state advance (block keeps FSM at gate).
    expect(await readFsmStateRaw(sid, 'observed-gate')).toBeNull();
  });

  it('kernel.applyAction is the decision path — NOOP_BUS does not throw, action is honored', async () => {
    // Verify that routing through kernel.applyAction (PART B) produces correct pass/block/warn decisions.
    // Blanket-block: a READ-ONLY call (git status) at a failing gate is NOT mutating → exitCode 0 (read-only
    // bypass). This proves NOOP_BUS doesn't throw AND the exemption fires correctly.
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-kernel-path';
    const gitStatus = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git status' },
    } as unknown as Event;
    const d = await runV2Cartridges(sid, gitStatus, NOW, { enforceOnly: true });
    // Read-only → isMutatingCall false → NOT blocked (read-only bypass).
    expect(d.exitCode).toBe(0);
    // Confirm warn in normal (non-enforceOnly) mode still surfaces as an injection via the kernel path.
    mockLoad.mockResolvedValue([gatePack('warn')]);
    const sid2 = 'sess-kernel-warn';
    const d2 = await runV2Cartridges(sid2, bashCall(), NOW);
    expect(d2.exitCode).toBe(0);
    expect(d2.injections).toContain('resolve it'); // warn → injection via kernel.applyAction
  });
});

// ── #22 — read-only bypass + executor exemption (blanket-block-with-exemptions) ──────────────────────────────
// enforceOnly mode blocks MUTATING calls at a failing gate EXCEPT: (a) read-only (isMutatingCall → false),
// (b) executor subagent (agentId present — Hole 1). Non-enforceOnly (PostToolUse) always enforces.
//
// NOTE: the advance-only design from task #33 (which blocked ONLY the stage's advance-triggering action)
// is superseded here. That design is being replaced by the lane model (task #35). The current design is
// blanket-block-mutating-with-exemptions: simpler, correct for automation enforcement, and free of the
// per-stage detection logic that couldn't handle plan/author/deploy cleanly.

describe('runV2Cartridges — enforceOnly blanket-block-with-exemptions (#22 + Hole 1)', () => {
  it('enforceOnly + failing gate + MUTATING Edit + no agentId → exitCode 2 (blocked — Hole 1 NOT exempt)', async () => {
    // Edit is always mutating; no agentId present → the executor exemption does not apply.
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-bb-edit-noagent';
    const editCall = {
      kind: 'tool_call',
      tool: 'Edit',
      args: { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' },
    } as unknown as Event;
    const d = await runV2Cartridges(sid, editCall, NOW, { enforceOnly: true });
    expect(d.exitCode).toBe(2); // mutating + no agentId → blocked
    expect(d.messages).toContain('resolve it');
  });

  it('enforceOnly + failing gate + MUTATING Edit + agentId present → exitCode 0 (executor exempt — Hole 1)', async () => {
    // Same Edit but with agentId → executor exemption fires → NOT blocked.
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-bb-edit-agent';
    const editCall = {
      kind: 'tool_call',
      tool: 'Edit',
      args: { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' },
    } as unknown as Event;
    const d = await runV2Cartridges(sid, editCall, NOW, {
      enforceOnly: true,
      agentId: 'executor-1',
    });
    expect(d.exitCode).toBe(0); // executor exempt (agentId present) → not blocked
    expect(d.messages).toEqual([]);
  });

  it('enforceOnly + failing gate + Bash "git status" → exitCode 0 (read-only bypass — #22)', async () => {
    // git status is not mutating (isMutatingCall → false) → read-only bypass → never blocked.
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-bb-git-status';
    const gitStatus = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git status' },
    } as unknown as Event;
    const d = await runV2Cartridges(sid, gitStatus, NOW, { enforceOnly: true });
    expect(d.exitCode).toBe(0); // read-only → not blocked
    expect(d.messages).toEqual([]);
  });

  it('enforceOnly + failing gate + Bash "grep -r foo ." → exitCode 0 (read-only bypass)', async () => {
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-bb-grep';
    const grepCall = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'grep -r foo .' },
    } as unknown as Event;
    const d = await runV2Cartridges(sid, grepCall, NOW, { enforceOnly: true });
    expect(d.exitCode).toBe(0); // grep is not mutating → passes
    expect(d.messages).toEqual([]);
  });

  it('enforceOnly + failing gate + MUTATING Bash "sed -i" + no agentId → exitCode 2 (blocked)', async () => {
    // sed -i is mutating (matches the file-writing deny-list); no agentId → blocked.
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-bb-sed-noagent';
    const sedCall = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: "sed -i 's/a/b/' f.ts" },
    } as unknown as Event;
    const d = await runV2Cartridges(sid, sedCall, NOW, { enforceOnly: true });
    expect(d.exitCode).toBe(2); // mutating + no agentId → blocked
    expect(d.messages).toContain('resolve it');
  });

  it('enforceOnly + failing gate + MUTATING Bash + agentId → exitCode 0 (executor exempt)', async () => {
    // Same sed -i but with agentId → executor exempt → not blocked.
    mockLoad.mockResolvedValue([gatePack('block')]);
    const sid = 'sess-bb-sed-agent';
    const sedCall = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: "sed -i 's/a/b/' f.ts" },
    } as unknown as Event;
    const d = await runV2Cartridges(sid, sedCall, NOW, {
      enforceOnly: true,
      agentId: 'executor-2',
    });
    expect(d.exitCode).toBe(0); // executor exempt → not blocked
    expect(d.messages).toEqual([]);
  });
});

// ── LANE MODEL — per-stage write-lane enforcement (the #33 successor to advance-action detection) ──────────

/** A gate whose stage declares a write-lane. `ok: 'true'` so the completeness gate always PASSES — proving the
 *  lane block is INDEPENDENT of the gate (it blocks an out-of-lane write even when the gate would advance). */
const lanePack = (writes: string[]): LoadedPackV2 =>
  load({
    name: 'lane-gate',
    version: '1.0.0',
    scope: 'workflow',
    guards: { ok: 'true' },
    fsm: {
      initial: 'stage0',
      states: {
        stage0: {
          kind: 'gate',
          guard: 'ok',
          trigger: ['tool_call'],
          on_pass_emits: 'done',
          on_fail: { action: 'block', message: 'gate' },
          writes,
        },
        shipped: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'stage0', on: 'done', to: 'shipped' }],
    },
  });

const writeCallTo = (file_path: string): Event =>
  ({ kind: 'tool_call', tool: 'Write', args: { file_path } }) as unknown as Event;

describe('runV2Cartridges — LANE MODEL write-lane enforcement', () => {
  it('enforceOnly + OUT-of-lane Write + no agentId → exitCode 2 (blocked with a lane message)', async () => {
    mockLoad.mockResolvedValue([lanePack(['docs/research/*pre-research*'])]);
    const d = await runV2Cartridges('sess-lane-oob', writeCallTo('src/foo.ts'), NOW, {
      enforceOnly: true,
    });
    expect(d.exitCode).toBe(2);
    expect(d.messages.join('\n')).toContain('write-lane');
    expect(d.messages.join('\n')).toContain('src/foo.ts');
  });

  it('enforceOnly + IN-lane Write → exitCode 0 (the lane allows it; the passing gate would advance)', async () => {
    mockLoad.mockResolvedValue([lanePack(['docs/research/*pre-research*'])]);
    const d = await runV2Cartridges(
      'sess-lane-in',
      writeCallTo('docs/research/T-x-pre-research-2026.md'),
      NOW,
      { enforceOnly: true },
    );
    expect(d.exitCode).toBe(0);
    expect(d.messages).toEqual([]);
  });

  it('enforceOnly + OUT-of-lane Write + agentId → exitCode 0 (executor exempt — Hole 1)', async () => {
    mockLoad.mockResolvedValue([lanePack(['docs/research/*pre-research*'])]);
    const d = await runV2Cartridges('sess-lane-exec', writeCallTo('src/foo.ts'), NOW, {
      enforceOnly: true,
      agentId: 'executor-9',
    });
    expect(d.exitCode).toBe(0);
    expect(d.messages).toEqual([]);
  });

  it('enforceOnly + OUT-of-lane READ → exitCode 0 (reads never block)', async () => {
    mockLoad.mockResolvedValue([lanePack(['docs/research/*pre-research*'])]);
    const readCall = {
      kind: 'tool_call',
      tool: 'Read',
      args: { file_path: 'src/foo.ts' },
    } as unknown as Event;
    const d = await runV2Cartridges('sess-lane-read', readCall, NOW, { enforceOnly: true });
    expect(d.exitCode).toBe(0);
    expect(d.messages).toEqual([]);
  });

  it('laneless stage (`**`) → INERT: an out-of-scope Write passes (explicitly-unrestricted stage)', async () => {
    mockLoad.mockResolvedValue([lanePack(['**'])]);
    const d = await runV2Cartridges('sess-lane-star', writeCallTo('src/anything.ts'), NOW, {
      enforceOnly: true,
    });
    expect(d.exitCode).toBe(0);
    expect(d.messages).toEqual([]);
  });

  it('NON-enforceOnly (interactive/PostToolUse) + OUT-of-lane Write → NOT blocked by the lane', async () => {
    // The lane is agents-only: it fires only under enforceOnly (automation PreToolUse). PostToolUse observes.
    mockLoad.mockResolvedValue([lanePack(['docs/research/*pre-research*'])]);
    const d = await runV2Cartridges('sess-lane-observe', writeCallTo('src/foo.ts'), NOW);
    expect(d.exitCode).toBe(0);
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
          // LANE MODEL: `scope.is_advance` is now lane-membership (replacing PRE_RESEARCH_REGEX). The lane
          // matches the pre-research artifact `writePreResearch` creates → an advance write is is_advance:true.
          writes: ['docs/research/*pre-research*'],
        },
        scoped: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'scope', on: 'scoped', to: 'scoped' }],
    },
  });

/**
 * GS1 — a single-gate pack whose `scope_write` state carries the real T2 `scope_write_ready` guard (minus the
 * audit clause, so the test does not need to seed a content-audit cache). Used by the autoDecompose tests:
 * autoDecompose now fires on `p.from === 'scope_write'`, not `p.from === 'scope'`.
 */
const scopeWriteGatePack = (): LoadedPackV2 =>
  load({
    name: 'fsf-scope-write',
    version: '1.0.0',
    scope: 'workflow',
    guards: {
      scope_write_ready: 'scope.is_advance && scope.anchors_ok && !scope.open_question',
    },
    fsm: {
      initial: 'scope_write',
      states: {
        scope_write: {
          kind: 'gate',
          guard: 'scope_write_ready',
          trigger: ['post_tool_call'],
          on_pass_emits: 'scope_written',
          on_fail: { action: 'block', message: 'SCOPE_WRITE: write the scope artifact' },
          // LANE MODEL: the scope-artifact lane feeds `scope.is_advance` (see scopeGatePack).
          writes: ['docs/research/*pre-research*'],
        },
        plan: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'scope_write', on: 'scope_written', to: 'plan' }],
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

  it('GS1: the FSM write-through creates the task checkpoint keyed by the wg issue id (stage + scope proof)', async () => {
    const prevItem = process.env.OPENSQUID_ITEM_ID;
    const prevHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = await mkdtemp(join(tmpdir(), 'osq-cp-mirror-'));
    process.env.OPENSQUID_ITEM_ID = 'wg-mirror-1'; // the wg issue id the ralph loop publishes at spawn
    try {
      const sid = 'sess-mirror';
      mockLoad.mockResolvedValue([scopeGatePack()]);
      await appendAsk(sid, 'add login screen');
      for (let i = 0; i < 3; i++) await appendTool(sid, 'Read'); // depth = 3
      const p = await writePreResearch('1. Login [ask: "add login screen"]');
      const d = await runV2Cartridges(sid, advanceWrite(p), NOW);
      expect(d.exitCode).toBe(0);
      // The single writer created the durable task checkpoint keyed by the CANONICAL wg id (OPENSQUID_ITEM_ID):
      // the advanced FSM stage + the on-disk scope-proof artifact (PRE_RESEARCH_PATH_KEY) the orchestrator reads.
      const cp = await withTaskCheckpointStore((s) => s.getTaskCheckpoint('wg-mirror-1'));
      expect(cp).toEqual({ stage: 'scoped', scopeArtifacts: [p] });
    } finally {
      if (prevItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = prevItem;
      if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = prevHome;
    }
  });

  it('GS1: NO OPENSQUID_ITEM_ID and no active task → null-skip (no checkpoint fabricated)', async () => {
    const prevItem = process.env.OPENSQUID_ITEM_ID;
    const prevHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = await mkdtemp(join(tmpdir(), 'osq-cp-none-'));
    delete process.env.OPENSQUID_ITEM_ID;
    try {
      const sid = 'sess-no-item';
      mockLoad.mockResolvedValue([scopeGatePack()]);
      await appendAsk(sid, 'add login screen');
      for (let i = 0; i < 3; i++) await appendTool(sid, 'Read'); // depth = 3
      const p = await writePreResearch('1. Login [ask: "add login screen"]');
      const d = await runV2Cartridges(sid, advanceWrite(p), NOW); // FSM advances, but no active task → no key
      expect(d.exitCode).toBe(0);
      // resolveCheckpointKey → no OPENSQUID_ITEM_ID + no active task → null → the checkpoint write is SKIPPED
      // (never a fabricated checkpoint). The task_checkpoints table stays empty.
      const cp = await withTaskCheckpointStore((s) => s.getTaskCheckpoint('sess-no-item'));
      expect(cp).toBeNull();
    } finally {
      if (prevItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = prevItem;
      if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = prevHome;
    }
  });

  it('AD.1 capture: a prompt_submit populates the captured ask when a v2 cartridge is active', async () => {
    const sid = 'sess-scope-capture';
    mockLoad.mockResolvedValue([scopeGatePack()]);
    const promptEvent = { kind: 'prompt_submit', prompt: 'build the thing' } as unknown as Event;
    await runV2Cartridges(sid, promptEvent, NOW);
    expect((await readCapturedAsk(sid)).turns).toEqual(['build the thing']);
  });

  // T2.5 LIVE WIRING (the fix for "FSM stalls at PLAN"): the SCOPE→PLAN transition must auto-populate the
  // work-graph from the captured artifact, so plan_ready can later pass. Before this wiring autoDecompose had no
  // live caller and the work-graph stayed empty → plan never completed.
  async function readWgIssues(): Promise<{ id: string; body: string }[]> {
    const store = workGraphStore({
      dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
      sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
    });
    await store.init();
    return bindProject(store, 'legacy-global').listIssues();
  }

  // Isolate OPENSQUID_HOME per test (the file otherwise shares one HOME → the work-graph leaks across tests).
  async function withFreshHome<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = await mkdtemp(join(tmpdir(), 'osq-decomp-'));
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = prev;
    }
  }
  const countScope1 = async (): Promise<number> =>
    (await readWgIssues()).filter((i) => i.body.includes('sourceElementId:scope-1')).length;

  // GS1: autoDecompose now fires on `p.from === 'scope_write'` (not `p.from === 'scope'`). These tests use
  // `scopeWriteGatePack` (starts at scope_write, transitions to plan on pass) to trigger the right side-effect.
  it('READY advance AUTO-DECOMPOSES: SCOPE_WRITE→PLAN populates the work-graph (autoDecompose live caller)', async () => {
    await withFreshHome(async () => {
      const sid = 'sess-scope-decompose';
      mockLoad.mockResolvedValue([scopeWriteGatePack()]);
      await appendAsk(sid, 'add login screen'); // still needed: scope.anchors_ok checks against captured ask
      expect(await countScope1()).toBe(0); // clean baseline
      const p = await writePreResearch('1. Login [ask: "add login screen"]');
      await runV2Cartridges(sid, advanceWrite(p), NOW);
      // the artifact's element (scope-1) was stamped into a work-graph issue → plan.complete can now hold
      expect(await countScope1()).toBe(1);
    });
  });

  it('auto-decompose is IDEMPOTENT: a SCOPE_WRITE pass over an already-covered element does not duplicate', async () => {
    await withFreshHome(async () => {
      const sid = 'sess-scope-idem';
      mockLoad.mockResolvedValue([scopeWriteGatePack()]);
      await appendAsk(sid, 'add login screen');
      await populateWg([{ title: 'pre', body: 'sourceElementId:scope-1' }]); // already covered
      const before = await countScope1();
      const p = await writePreResearch('1. Login [ask: "add login screen"]');
      await runV2Cartridges(sid, advanceWrite(p), NOW);
      expect(await countScope1()).toBe(before); // skipped (guard saw it covered) — not re-populated
    });
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

// ── T2.6 — the AUTHOR gate binding over buildGuardCtx (manifest_complete ∧ real_code) ──────────────────────

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
  new Map([['author_ready', 'author.manifest_complete && author.real_code']]),
);

describe('buildGuardCtx — T2.6 AUTHOR binding', () => {
  it('binds author.manifest_complete/author.real_code dual-shape (flat + nested)', async () => {
    const ai = authorInputs(
      [proofReq('R-A', 'src/a.test.ts')],
      idx({ tests: { 'src/a.test.ts': { activeCount: 1 } } }),
    );
    const ctx = await buildGuardCtx(authorEv, 'sess-author-shape', 'author', ai);
    expect(ctx.has('author.manifest_complete')).toBe(true);
    expect(ctx.has('author.real_code')).toBe(true);
    const nested = ctx.get('author') as { manifest_complete: boolean; real_code: boolean };
    expect(typeof nested.manifest_complete).toBe('boolean');
    expect(typeof nested.real_code).toBe('boolean');
  });

  it('all-met + zero-orphan → both true → author_ready PASSES (gate advances)', async () => {
    const ai = authorInputs(
      [proofReq('R-A', 'src/a.test.ts')],
      idx({ tests: { 'src/a.test.ts': { activeCount: 1 } } }),
    );
    const ctx = await buildGuardCtx(authorEv, 'sess-author-pass', 'author', ai);
    expect(ctx.get('author.manifest_complete')).toBe(true);
    expect(ctx.get('author.real_code')).toBe(true);
    expect(AUTHOR_GUARD.eval('author_ready', ctx)).toBe(true); // gate would advance
  });

  it('an ORPHAN → manifest_complete:false → author_ready BLOCKS', async () => {
    const ai = authorInputs(
      [proofReq('R-A', 'src/a.test.ts')],
      idx({
        tests: { 'src/a.test.ts': { activeCount: 1 } },
        exports: [{ name: 'orphanSym', file: 'src/o.ts' }], // gated export with no requirement
      }),
    );
    const ctx = await buildGuardCtx(authorEv, 'sess-author-orphan', 'author', ai);
    expect(ctx.get('author.manifest_complete')).toBe(false);
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
    expect(ctx.get('author.manifest_complete')).toBe(false);
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

// ── GFR.4 / E2 — the CONDITIONAL external-consultation binding over buildGuardCtx (E2a/E2c/E2d) ──────────────
// The external rung is a SUPPLEMENT that fires ONLY WHEN NECESSARY: `external_needed` (diff-derived) decides
// whether a consult is required at all, and the `consult` buckets (windowed before/after CODE) are the "did it
// happen" signal. These tests bind the facets through buildGuardCtx (dual-shape) and evaluate the pack's real
// external sub-clauses. `external_needed` is FAIL-OPEN false here (no session cwd recorded → git read exempt),
// which is exactly the "only when necessary" default — a change with no proven external dependency never demands
// a web consult. The consult buckets flip true only after a recorded WebSearch/WebFetch (recordExternalConsult).

// The external sub-clauses lifted VERBATIM from pack.yaml's author_ready / code_ready (the conditional rung).
const EXTERNAL_GUARD = new RegistryGuardEvaluator(
  new Map([
    ['ext_author', '!author.external_needed || author.searched_existing'], // E2d
    ['ext_code_before', '!code.external_needed || code.consulted_before'], // E2c
    ['ext_code_audited', '!code.external_needed || code.audited'], // E2a
  ]),
);

describe('buildGuardCtx — E2 external-consultation binding (GFR.4)', () => {
  it('binds author/code external facets dual-shape (flat + nested)', async () => {
    const aCtx = await buildGuardCtx(authorEv, 'sess-ext-shape-a', 'author');
    expect(aCtx.has('author.searched_existing')).toBe(true);
    expect(aCtx.has('author.external_needed')).toBe(true);
    const aNested = aCtx.get('author') as { searched_existing: boolean; external_needed: boolean };
    expect(typeof aNested.searched_existing).toBe('boolean');
    expect(typeof aNested.external_needed).toBe('boolean');

    const cCtx = await buildGuardCtx(codeEv, 'sess-ext-shape-c', 'code');
    expect(cCtx.has('code.consulted_before')).toBe(true);
    expect(cCtx.has('code.audited')).toBe(true);
    expect(cCtx.has('code.external_needed')).toBe(true);
    const cNested = cCtx.get('code') as {
      consulted_before: boolean;
      audited: boolean;
      external_needed: boolean;
    };
    expect(typeof cNested.consulted_before).toBe('boolean');
    expect(typeof cNested.audited).toBe('boolean');
    expect(typeof cNested.external_needed).toBe('boolean');
  });

  it('ONLY WHEN NECESSARY: no external dependency → external_needed:false → clauses PASS with NO consult', async () => {
    // No session cwd recorded ⇒ externalNeededForSession fail-opens to false ⇒ the rung is exempt. A trivial
    // internal change must NOT be forced to consult the web — the sub-clauses pass despite no recorded consult.
    const aCtx = await buildGuardCtx(authorEv, 'sess-ext-exempt-a', 'author');
    expect(aCtx.get('author.external_needed')).toBe(false);
    expect(aCtx.get('author.searched_existing')).toBe(false); // no consult recorded…
    expect(EXTERNAL_GUARD.eval('ext_author', aCtx)).toBe(true); // …yet the clause PASSES (exempt)

    const cCtx = await buildGuardCtx(codeEv, 'sess-ext-exempt-c', 'code');
    expect(cCtx.get('code.external_needed')).toBe(false);
    expect(EXTERNAL_GUARD.eval('ext_code_before', cCtx)).toBe(true);
    expect(EXTERNAL_GUARD.eval('ext_code_audited', cCtx)).toBe(true);
  });

  it('a recorded consult flips the buckets: before→searched_existing/consulted_before, after→audited', async () => {
    const sid = 'sess-ext-recorded';
    await writeActiveTask(sid, { id: '1', subject: 'x', started_at: NOW, taskId: 'T-ext' });
    await recordExternalConsult(sid, 'T-ext', 'before');
    await recordExternalConsult(sid, 'T-ext', 'after');

    const aCtx = await buildGuardCtx(authorEv, sid, 'author');
    expect(aCtx.get('author.searched_existing')).toBe(true);
    const cCtx = await buildGuardCtx(codeEv, sid, 'code');
    expect(cCtx.get('code.consulted_before')).toBe(true); // the `before` bucket (E2c)
    expect(cCtx.get('code.audited')).toBe(true); // the `after` bucket (E2a)
  });

  it('CONDITIONAL semantics: external_needed:true + no consult BLOCKS; + consult PASSES (synthetic ctx)', () => {
    // The diff-derived external_needed is not injectable into buildGuardCtx, so drive the pack sub-clauses over a
    // synthetic ctx to prove the block-when-required half (the exempt/recorded halves above cover the wiring).
    const needMissing = new Map<string, unknown>([
      ['author', { external_needed: true, searched_existing: false }],
      ['code', { external_needed: true, consulted_before: false, audited: false }],
    ]);
    expect(EXTERNAL_GUARD.eval('ext_author', needMissing)).toBe(false); // needed + unproven ⇒ BLOCK
    expect(EXTERNAL_GUARD.eval('ext_code_before', needMissing)).toBe(false);
    expect(EXTERNAL_GUARD.eval('ext_code_audited', needMissing)).toBe(false);

    const needSatisfied = new Map<string, unknown>([
      ['author', { external_needed: true, searched_existing: true }],
      ['code', { external_needed: true, consulted_before: true, audited: true }],
    ]);
    expect(EXTERNAL_GUARD.eval('ext_author', needSatisfied)).toBe(true); // needed + proven ⇒ PASS
    expect(EXTERNAL_GUARD.eval('ext_code_before', needSatisfied)).toBe(true);
    expect(EXTERNAL_GUARD.eval('ext_code_audited', needSatisfied)).toBe(true);
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
  verificationResult: () => Promise.resolve(null), // DBL.1 — no verification configured → skip → deployClean:true
  suiteResult: () => Promise.resolve(null), // scope-1 — no suite declared → floor off (legacy project)
  reversible: () => Promise.resolve(false), // REVERSIBLE-DEPLOY — fail-closed default (irreversible)
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

// ── T2.12 — the LIVE per-stage report trigger (leaving any of the 5 stages emits its report) ──────────────
// runV2Cartridges, on each FSM transition leaving SCOPE/PLAN/AUTHOR/CODE/DEPLOY, emits a dated
// <project>/.opensquid/reports/ file (V2-ENF.2/4, never the legacy docs/reports/) + memory mirror +
// in-session injection + best-effort chat. CODE fires here too (loop_driver was never
// wired). All deterministic: iso (NOW) injected, unique session ids, a temp project root.

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
        // CADENCE-IN-PACK — the fixture declares its reporting cadence (`report:`) exactly as the real
        // fullstack-flow pack.yaml does; v2_supply reads it (the hardcoded core STAGE map is gone).
        [stage]: {
          kind: 'gate',
          guard: 'always',
          trigger: ['tool_call'],
          on_pass_emits: 'next',
          on_fail: { action: 'warn', message: 'n/a' },
          report: stage.toUpperCase(),
          reads: ['scope.is_advance'], // EVIDENCE-DECLARATION: the report's proof-line keys (pack data)
        },
        done: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: stage, on: 'next', to: 'done' }],
    },
  });

const writeCall = (): Event =>
  ({ kind: 'tool_call', tool: 'Write', args: { file_path: '/tmp/x.ts' } }) as unknown as Event;

/** A temp project root recorded as the session cwd. Its `.opensquid` marker makes it project-SCOPED, so SAVED
 *  reports land under `<root>/.opensquid/reports/` (V2-ENF.2/4) AND per-test goal maps (goalMapPath →
 *  resolveProjectScopeRoot) don't collide on the shared user-scope fallback. */
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
  // The interactive-CODE cases assert v2_supply IS the CODE emitter — true only OUTSIDE an autonomous lap
  // (under OPENSQUID_AUTOMATION=1 loop_driver owns the CODE report, so v2_supply skips it, T2.9). vitest inherits
  // the ambient env, and a ralph lap runs with OPENSQUID_AUTOMATION=1 — so pin the interactive default here (each
  // test that needs automation, e.g. T2.9, sets it explicitly) and restore the ambient value after. Makes the
  // block deterministic regardless of who runs it (CI, an interactive dev, or a self-verifying lap).
  let priorAutomation: string | undefined;
  beforeEach(() => {
    priorAutomation = process.env.OPENSQUID_AUTOMATION;
    delete process.env.OPENSQUID_AUTOMATION;
  });
  afterEach(() => {
    if (priorAutomation === undefined) delete process.env.OPENSQUID_AUTOMATION;
    else process.env.OPENSQUID_AUTOMATION = priorAutomation;
  });
  for (const [stateName, stageUpper] of [
    ['scope', 'SCOPE'],
    ['plan', 'PLAN'],
    ['author', 'AUTHOR'],
    ['code', 'CODE'], // CODE now fires HERE too (loop_driver was never wired) — the report's live emitter
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

      // 1) the dated file under the SESSION CWD's .opensquid/reports/ (NOT the real repo).
      const reportPath = join(root, '.opensquid', 'reports', `${stateName}-T-rep-2026-06-22.md`);
      expect(await exists(reportPath)).toBe(true);
      const body = await readFile(reportPath, 'utf8');
      expect(body).toContain(`After-stage report — ${stageUpper} complete · T-rep ·`);
      expect(body).toContain('Summary:');
      expect(body).toContain('Evidence:'); // the gate predicates that backed the phase
      expect(body).toContain('Next →');

      // 2) the memory mirror — a pending lesson whose content is the report body.
      const lessonsDir = join(pendingLessonsDir(sid), 'potential-lessons');
      const files = await readdir(lessonsDir);
      expect(files.length).toBe(1);
      const mirror = await readFile(join(lessonsDir, files[0]!), 'utf8');
      expect(mirror).toContain(`After-stage report — ${stageUpper} complete · T-rep ·`);
    });
  }

  it('CODE report fires from v2_supply INTERACTIVELY — with the 7-phase chart', async () => {
    const sid = 'sess-t212-code-chart';
    const root = await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-rep' });
    mockLoad.mockResolvedValue([stageGatePack('code')]);

    await runV2Cartridges(sid, writeCall(), NOW);

    const body = await readFile(
      join(root, '.opensquid', 'reports', 'code-T-rep-2026-06-22.md'),
      'utf8',
    );
    expect(body).toContain('After-stage report — CODE complete · T-rep ·');
    expect(body).toContain('Phases:'); // the long, stand-out 7-step chart
    expect(body).toContain('[x] pre_research');
    expect(body).toContain('[x] fix');
    expect(body).toContain('Evidence:'); // the CODE gate predicates
  });

  it('#12 — CODE report fires on a COMPLETING log_phase (in-band fallback), ONCE per task', async () => {
    const sid = 'sess-12-fallback';
    await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-fb' });
    for (const p of REQUIRED_PHASES) await appendPhase(sid, '1', p); // complete (keyed on active.id='1')
    mockLoad.mockResolvedValue([gatePack('warn')]); // a cartridge so the loop runs; inert on a log_phase event
    const logDone = {
      kind: 'post_tool_call',
      tool: 'mcp__opensquid__log_phase',
      args: { phase: 'fix' },
    } as unknown as Event;

    const d = await runV2Cartridges(sid, logDone, NOW);
    const body = d.injections.join('\n');
    // label is the TRACK id (T-fb), proving isComplete keyed on active.id ('1') while the report uses the track id
    expect(body).toContain('After-stage report — CODE complete · T-fb');
    expect(body).toContain('Evidence:'); // full-fidelity: the CODE gate proof line (not a reduced report)
    expect(body).toContain('[x] fix'); // the 7-phase chart

    // cross-event dedup: a SECOND completing log_phase → NO second report (durable claim marker)
    const d2 = await runV2Cartridges(sid, logDone, NOW);
    expect(d2.injections.join('\n')).not.toContain('After-stage report');
  });

  it('#12 — no completion report when the task is INCOMPLETE', async () => {
    const sid = 'sess-12-incomplete';
    await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-inc' });
    await appendPhase(sid, '1', 'pre_research'); // only 1 of 7 → incomplete
    mockLoad.mockResolvedValue([gatePack('warn')]);
    const logEv = {
      kind: 'post_tool_call',
      tool: 'mcp__opensquid__log_phase',
      args: { phase: 'pre_research' },
    } as unknown as Event;
    const d = await runV2Cartridges(sid, logEv, NOW);
    expect(d.injections.join('\n')).not.toContain('After-stage report');
  });

  it('T2.9 double-emit guard: in an autonomous lap (OPENSQUID_AUTOMATION=1) v2_supply SKIPS the CODE report (loop_driver owns it)', async () => {
    const prev = process.env.OPENSQUID_AUTOMATION;
    process.env.OPENSQUID_AUTOMATION = '1';
    try {
      const sid = 'sess-t212-code-auto';
      const root = await newProjectRoot(sid);
      await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-auto' });
      mockLoad.mockResolvedValue([stageGatePack('code')]);
      await runV2Cartridges(sid, writeCall(), NOW);
      // the CODE report is NOT written here (the orchestrator's onPhasesComplete emits it autonomously)
      await expect(
        readFile(join(root, '.opensquid', 'reports', 'code-T-auto-2026-06-22.md'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.OPENSQUID_AUTOMATION;
      else process.env.OPENSQUID_AUTOMATION = prev;
    }
  });

  // T2.10 — the SCOPE report's goal-alignment line is now the LIVE consumer of goalConsult.
  it('SCOPE report carries the goal-alignment line (no goal map → on the captured goal)', async () => {
    const sid = 'sess-t210-scope-nogoal';
    const root = await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-rep' });
    mockLoad.mockResolvedValue([stageGatePack('scope')]);

    await runV2Cartridges(sid, writeCall(), NOW);

    const body = await readFile(
      join(root, '.opensquid', 'reports', 'scope-T-rep-2026-06-22.md'),
      'utf8',
    );
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

    const body = await readFile(
      join(root, '.opensquid', 'reports', 'scope-T-rep-2026-06-22.md'),
      'utf8',
    );
    expect(body).toContain('OFF the captured goal — destination drift');
  });

  it('a non-SCOPE stage report carries NO goal-alignment line (the check belongs at scope-time)', async () => {
    const sid = 'sess-t210-plan-noline';
    const root = await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-rep' });
    mockLoad.mockResolvedValue([stageGatePack('plan')]);

    await runV2Cartridges(sid, writeCall(), NOW);

    const body = await readFile(
      join(root, '.opensquid', 'reports', 'plan-T-rep-2026-06-22.md'),
      'utf8',
    );
    expect(body).not.toContain('## Goal alignment');
  });

  // CADENCE-IN-PACK — the before-stage SUMMARY fires on the ENTRY-EDGE of a transition (once per stage entry),
  // NOT on every event. A two-gate fixture: leaving `plan` ENTERS `author` (which declares `summary: true`).
  it('the before-stage SUMMARY fires ONCE on stage ENTRY (entry-edge), not per event', async () => {
    const sid = 'sess-cadence-summary';
    await newProjectRoot(sid); // records the session cwd (side-effect); the returned root is unused here
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-sum' });
    const pack = load({
      name: 'fsf-summary',
      version: '1.0.0',
      scope: 'workflow',
      guards: { always: 'tool == "Write"' },
      fsm: {
        initial: 'plan',
        states: {
          plan: {
            kind: 'gate',
            guard: 'always',
            trigger: ['tool_call'],
            on_pass_emits: 'next',
            on_fail: { action: 'warn', message: 'n/a' },
            report: 'PLAN',
          },
          author: {
            kind: 'gate',
            guard: 'always',
            trigger: ['tool_call'],
            on_pass_emits: 'done_ev',
            on_fail: { action: 'warn', message: 'n/a' },
            report: 'AUTHOR',
            summary: true, // ← the ENTRY-edge summary declared in the pack
            does: 'author the spec + real code covering every scoped element', // ← the summary's Will-text (pack data)
          },
          done: { kind: 'terminal', outcome: 'shipped' },
        },
        transitions: [
          { from: 'plan', on: 'next', to: 'author' },
          { from: 'author', on: 'done_ev', to: 'done' },
        ],
      },
    });
    mockLoad.mockResolvedValue([pack]);

    // event 1: a Write advances plan → author. Entering author fires its before-summary exactly once.
    const d1 = await runV2Cartridges(sid, writeCall(), NOW);
    expect(d1.injections.join('\n')).toContain('Starting AUTHOR · T-sum');
    expect(d1.injections.join('\n')).toContain('Will: author the spec'); // from the pack's author `does:`
    // V2-ENF.2/7 — the follow-instructions anti-drift nudge rides the same stage-ENTRY boundary (§5.4c),
    // re-asserting the injected procedure. SURFACED-only, no `🦑`, and never the literal "undefined".
    expect(d1.injections.join('\n')).toContain('Stay on the AUTHOR procedure');
    expect(d1.injections.join('\n')).toContain('Procedure: author the spec');
    expect(d1.injections.join('\n')).not.toContain('Procedure: undefined');
    // exactly one entry-edge summary this event (not duplicated).
    const starts1 = d1.injections.join('\n').match(/Starting AUTHOR/g) ?? [];
    expect(starts1.length).toBe(1);

    // event 2: a Bash FAILS the `author` gate (guard `tool=="Write"`) → NO transition → the actor STAYS in
    // author. Proof the summary is per-ENTRY, not per-event: no second "Starting AUTHOR" fires while parked.
    const d2 = await runV2Cartridges(sid, bashCall(), NOW);
    expect(d2.injections.join('\n')).not.toContain('Starting AUTHOR');
  });

  // CADENCE-IN-PACK — the cadence is PACK DATA: a gate state that declares NO `report:` emits nothing on leave
  // (the old hardcoded core STAGE map is gone — no report is fabricated for an undeclared state).
  it('a stage with NO `report:` in the pack emits NO after-report (cadence is pack-driven)', async () => {
    const sid = 'sess-cadence-noreport';
    const root = await newProjectRoot(sid);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-nr' });
    const pack = load({
      name: 'fsf-noreport',
      version: '1.0.0',
      scope: 'workflow',
      guards: { always: 'tool == "Write"' },
      fsm: {
        initial: 'silent',
        states: {
          silent: {
            kind: 'gate',
            guard: 'always',
            trigger: ['tool_call'],
            on_pass_emits: 'next',
            on_fail: { action: 'warn', message: 'n/a' },
            // NO `report:` and NO `summary:` — the pack declares this stage is not a reporting boundary.
          },
          done: { kind: 'terminal', outcome: 'shipped' },
        },
        transitions: [{ from: 'silent', on: 'next', to: 'done' }],
      },
    });
    mockLoad.mockResolvedValue([pack]);

    const d = await runV2Cartridges(sid, writeCall(), NOW); // FSM DOES advance (silent → done)
    expect(d.exitCode).toBe(0);
    expect(d.injections.join('\n')).not.toContain('After-stage report'); // no after-report
    expect(d.injections.join('\n')).not.toContain('Starting'); // no before-summary
    expect(await exists(join(root, '.opensquid', 'reports'))).toBe(false); // no dated report file at all
  });
});

describe('runV2Cartridges — T2.7 readiness live wiring', () => {
  const execFileP = promisify(execFile);
  async function repo(file: string, content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'osq-rdy-'));
    await execFileP('git', ['init', '-q'], { cwd: dir });
    await execFileP('git', ['config', 'user.email', 't@t'], { cwd: dir });
    await execFileP('git', ['config', 'user.name', 't'], { cwd: dir });
    await writeFile(join(dir, file), content, 'utf8');
    await execFileP('git', ['add', file], { cwd: dir });
    return dir;
  }
  const postIn = (cwd: string): Event =>
    ({ kind: 'post_tool_call', tool: 'Bash', args: {}, cwd, exit_code: 0 }) as unknown as Event;

  it('RECORDS readiness when the active task 7 phases are complete + clean staged code', async () => {
    const s = 'sess-rdy-clean';
    mockLoad.mockResolvedValue([scopeGatePack()]);
    await writeActiveTask(s, { id: 'T-r', subject: 'r', started_at: NOW, taskId: 'T-r' });
    for (const p of REQUIRED_PHASES) await appendPhase(s, 'T-r', p);
    const dir = await repo('a.ts', 'export const x = "abc".slice(1);');
    await runV2Cartridges(s, postIn(dir), NOW);
    expect(await readinessResult(s, 'T-r')).toEqual({ ran: true, deprecatedClean: true });
  });

  it('records deprecated_clean:false when staged code carries a deprecated pattern (CODE gate will block)', async () => {
    const s = 'sess-rdy-dep';
    mockLoad.mockResolvedValue([scopeGatePack()]);
    await writeActiveTask(s, { id: 'T-d', subject: 'd', started_at: NOW, taskId: 'T-d' });
    for (const p of REQUIRED_PHASES) await appendPhase(s, 'T-d', p);
    const dir = await repo('a.ts', 'export const x = "abc".substr(1);');
    await runV2Cartridges(s, postIn(dir), NOW);
    const r = await readinessResult(s, 'T-d');
    expect(r.ran).toBe(true);
    expect(r.deprecatedClean).toBe(false);
  });

  it('does NOT record before the 7 phases are complete (fail-closed stays blocking)', async () => {
    const s = 'sess-rdy-incomplete';
    mockLoad.mockResolvedValue([scopeGatePack()]);
    await writeActiveTask(s, { id: 'T-i', subject: 'i', started_at: NOW, taskId: 'T-i' });
    await appendPhase(s, 'T-i', 'pre_research'); // only 1 of 7
    const dir = await repo('a.ts', 'export const x = 1;');
    await runV2Cartridges(s, postIn(dir), NOW);
    expect((await readinessResult(s, 'T-i')).ran).toBe(false);
  });
});

describe('runV2Cartridges — T2.8 acceptance live wiring', () => {
  // A pack whose gate transitions code → deploy (so the p.to === 'deploy' append fires).
  const toDeployPack = (): LoadedPackV2 =>
    load({
      name: 'fsf-todeploy',
      version: '1.0.0',
      scope: 'workflow',
      guards: { always: 'tool == "Write"' },
      fsm: {
        initial: 'code',
        states: {
          code: {
            kind: 'gate',
            guard: 'always',
            trigger: ['tool_call'],
            on_pass_emits: 'coded',
            on_fail: { action: 'warn', message: 'n/a' },
          },
          deploy: { kind: 'terminal', outcome: 'shipped' },
        },
        transitions: [{ from: 'code', on: 'coded', to: 'deploy' }],
      },
    });
  const writeC = (): Event =>
    ({ kind: 'tool_call', tool: 'Write', args: { file_path: '/tmp/x.ts' } }) as unknown as Event;

  it('entering DEPLOY creates the durable "waiting for your OK" acceptance item', async () => {
    const sid = 'sess-accept-create';
    mockLoad.mockResolvedValue([toDeployPack()]);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-acc' });
    await runV2Cartridges(sid, writeC(), NOW); // code → deploy transition
    const items = await readAcceptance(sid);
    expect(items.some((i) => i.taskId === 'T-acc' && i.status === 'waiting')).toBe(true);
  });

  it('IDEMPOTENT: does not overwrite an already-accepted item back to waiting', async () => {
    const sid = 'sess-accept-idem';
    mockLoad.mockResolvedValue([toDeployPack()]);
    await writeActiveTask(sid, { id: '1', subject: 's', started_at: NOW, taskId: 'T-acc2' });
    await appendAcceptance(sid, {
      id: 'T-acc2',
      taskId: 'T-acc2',
      status: 'accepted',
      addedAt: NOW,
    });
    await runV2Cartridges(sid, writeC(), NOW); // transition to deploy — must SKIP (item exists)
    const item = (await readAcceptance(sid)).find((i) => i.id === 'T-acc2');
    expect(item?.status).toBe('accepted'); // not clobbered back to waiting
  });
});
