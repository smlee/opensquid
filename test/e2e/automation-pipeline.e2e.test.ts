/**
 * AP.6 — end-to-end automation pipeline integration (the must-WORK gate).
 *
 * Chains the WHOLE 7-layer automation against the REAL loop-engine (not stubs —
 * the MAU.1 lesson): an active task + `log_phase` ×7 through the real engine
 * ledger → the workflow gate (rule #8) actually PASSES the `git commit`; with
 * only 6 phases it BLOCKS. This is the explicit chain the per-piece tests prove
 * in aggregate (AP.1 mirror vs the real store, AP.3 log_phase vs the real
 * engine, AP.4/AP.5 gate behavior); AP.6 runs them as one flow.
 *
 * Gated by E2E=1 + an engine binary (skip-if-absent for CI), same pattern as
 * drift-prevention.e2e.test.ts / log_phase.test.ts.
 */

import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HasActiveTask, WorkflowPhasesComplete } from '../../src/functions/active_task.js';
import { registerEventFunctions } from '../../src/functions/event.js';
import { IsAutomationMode } from '../../src/functions/is_automation_mode.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import { registerVerdictFunctions } from '../../src/functions/verdict.js';
import { handleLogPhase } from '../../src/mcp/tools/log_phase.js';
import { loadPack } from '../../src/packs/loader.js';
import { setAutomationFlag } from '../../src/runtime/automation_state.js';
import { EngineClient } from '../../src/engine/client.js';
import type { Event } from '../../src/runtime/event.js';
import { evaluateProcess } from '../../src/runtime/evaluator.js';
import { recordCurrentSession } from '../../src/runtime/hooks/session_id.js';
import { writeActiveTask } from '../../src/runtime/session_state.js';
import { REQUIRED_PHASES } from '../../src/runtime/workflow_phases.js';
import type { ProcessStep } from '../../src/runtime/types.js';

const HERE = fileURLToPath(import.meta.url);
const GATE_FIXTURE = resolve(HERE, '../../fixtures/workflow-gate-pack');
const DEV_BINARY = join(
  process.env.HOME ?? '/tmp',
  'projects/loop/engine/target/release/loop-engine',
);

function isExec(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
const ENV_BIN = process.env.OPENSQUID_ENGINE_BIN?.trim();
const ENGINE_BIN = ENV_BIN !== undefined && ENV_BIN.length > 0 ? ENV_BIN : DEV_BINARY;
const SKIP = process.env.E2E !== '1' || !isExec(ENGINE_BIN);

const SID = 'ap6-e2e-sess';
const commit: Event = {
  kind: 'tool_call',
  tool: 'Bash',
  args: { command: 'git commit -m x' },
  cwd: '/tmp',
};

describe.skipIf(SKIP)('AP.6 — automation pipeline e2e (real engine)', () => {
  let home: string;
  let engine: EngineClient;
  let gateSteps: ProcessStep[];
  let prior: Record<string, string | undefined> = {};

  beforeAll(async () => {
    prior = {
      OPENSQUID_HOME: process.env.OPENSQUID_HOME,
      LOOP_HOME: process.env.LOOP_HOME,
      OPENSQUID_ENGINE_BIN: process.env.OPENSQUID_ENGINE_BIN,
      OPENSQUID_AUTOMATION: process.env.OPENSQUID_AUTOMATION,
    };
    delete process.env.OPENSQUID_AUTOMATION;
    home = await mkdtemp(join(tmpdir(), 'ap6-'));
    process.env.OPENSQUID_HOME = home;
    process.env.LOOP_HOME = home;
    process.env.OPENSQUID_ENGINE_BIN = ENGINE_BIN;

    const pack = await loadPack(GATE_FIXTURE);
    const rule = pack.skills
      .find((s) => s.name === 'workflow')
      ?.rules.find((r) => r.id === 'workflow-phases-required');
    if (rule?.kind !== 'track_check') throw new Error('workflow gate rule missing');
    gateSteps = rule.process;

    engine = new EngineClient();
    await engine.ping();
  }, 30_000);

  afterAll(async () => {
    await engine.close().catch(() => undefined);
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  });

  function buildRegistry(): FunctionRegistry {
    const reg = new FunctionRegistry();
    registerEventFunctions(reg);
    registerVerdictFunctions(reg);
    reg.register(IsAutomationMode);
    reg.register(HasActiveTask);
    reg.register(WorkflowPhasesComplete);
    return reg;
  }
  async function gateVerdict(): Promise<string> {
    const r = await evaluateProcess(
      gateSteps,
      { event: commit, bindings: new Map(), sessionId: SID, packId: 'ap6' },
      buildRegistry(),
    );
    return r.kind;
  }

  it('full chain: active task + log_phase ×7 (real engine) → workflow gate PASSES the commit', async () => {
    await setAutomationFlag(SID);
    await recordCurrentSession(SID); // log_phase resolves the session via .current-session
    await writeActiveTask(SID, {
      id: 'ap6-task',
      subject: 'pipeline',
      started_at: new Date().toISOString(),
    });

    // 6 of 7 → gate BLOCKS.
    for (const phase of REQUIRED_PHASES.slice(0, 6)) {
      await handleLogPhase({ phase }, engine);
    }
    expect(await gateVerdict()).toBe('verdict'); // blocked

    // the 7th → gate PASSES.
    await handleLogPhase({ phase: 'fix' }, engine);
    expect(await gateVerdict()).toBe('no_verdict'); // passes

    // and the engine ledger really holds all 7 (read back, MAU.1 bar).
    const ledger = await engine.taskGetLedger({ task_id: 'ap6-task' });
    expect(ledger.phases_logged.sort()).toEqual([...REQUIRED_PHASES].sort());
  });

  it('T-ATSC L6: automation ON + no active task → gate BLOCKS commit with the remedy message', async () => {
    // SID for this case lives under the same OPENSQUID_HOME so the fixture pack's
    // dispatcher routes here. Distinct from the main case so the active-task
    // signal absence is clean (writeActiveTask above wrote for 'ap6-task' under
    // SID; for L6 we use a fresh session id with no active-task.json on disk).
    const L6_SID = 'ap6-e2e-l6-sess';
    await setAutomationFlag(L6_SID);
    await recordCurrentSession(L6_SID);
    // CRITICAL: no writeActiveTask call → has_active_task returns
    // {present: false, ...} → per-rule guard fires → BLOCK with L3 remedy.

    const r = await evaluateProcess(
      gateSteps,
      { event: commit, bindings: new Map(), sessionId: L6_SID, packId: 'ap6' },
      buildRegistry(),
    );
    expect(r.kind).toBe('verdict');
    // The L3 remedy message names the next step verbatim (must teach the fix).
    if (r.kind === 'verdict') {
      expect(r.verdict.message).toMatch(/cannot git commit in automation mode with no active task/);
      expect(r.verdict.message).toMatch(/TaskUpdate.*in_progress.*after TaskCreate/);
    }
  });
});
