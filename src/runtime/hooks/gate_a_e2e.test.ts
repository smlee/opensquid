/**
 * ASG.3 end-to-end: prove Gate A (scope-before-code) actually fires through
 * the live dispatch path. Constructs the exact rule shape the personal pack's
 * `scope-before-code` YAML compiles to, registers the real primitives it
 * needs (is_automation_mode, has_generated_spec, tool_name, tool_args,
 * verdict), seeds the on-disk state the primitives read (active-task.json)
 * + turns automation ON via the OPENSQUID_AUTOMATION env var (env-only — the
 * automation.flag file OR was retired), then dispatches a synthetic Write
 * event and asserts the verdict outcome.
 *
 * Four cases — block path + three NEGATIVE controls so we know the gate
 * isn't over-blocking:
 *   1. Write src/foo.ts + automation ON + active task w/o metadata.spec  → block (exit 2)
 *   2. Write src/foo.ts + automation ON + active task WITH metadata.spec → pass
 *   3. Write src/foo.ts + automation OFF                                  → pass
 *   4. Write docs/foo.md + automation ON + no spec                        → pass (path mismatch)
 *
 * Why dispatchEvent (not the spawned hook bin): the dispatch path is the
 * same one the live hook uses (`pre-tool-use.ts:106-108` invokes the same
 * `dispatchEvent`). Mirroring `dispatch.test.ts`'s in-process pattern keeps
 * this a focused integration assertion — not a full simulation harness
 * (that would be a separate track).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HasGeneratedSpec } from '../../functions/active_task.js';
import { registerEventFunctions } from '../../functions/event.js';
import { IsAutomationMode } from '../../functions/is_automation_mode.js';
import { FunctionRegistry } from '../../functions/registry.js';
import { registerVerdictFunctions } from '../../functions/verdict.js';
import { activeTaskFile } from '../paths.js';
import type { Pack, Rule, Skill, ToolCallEvent } from '../types.js';

import { dispatchEvent } from './dispatch.js';

let tempHome: string;
let priorHome: string | undefined;
let priorAutomation: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorAutomation = process.env.OPENSQUID_AUTOMATION;
  delete process.env.OPENSQUID_AUTOMATION;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-gate-a-e2e-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorAutomation === undefined) delete process.env.OPENSQUID_AUTOMATION;
  else process.env.OPENSQUID_AUTOMATION = priorAutomation;
  await rm(tempHome, { recursive: true, force: true });
});

/** Build the primitives registry the gate needs — mirrors `bootstrap.ts`. */
function buildRealRegistry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r); // tool_name + tool_args + neighbors
  registerVerdictFunctions(r); // verdict
  r.register(IsAutomationMode);
  r.register(HasGeneratedSpec);
  return r;
}

/**
 * The `scope-before-code` rule, hand-built to match the live YAML at
 * `~/.opensquid/packs/sangmin-personal-rules/skills/scope-decomposer/skill.yaml`
 * lines 110-130. Authored in code so the test doesn't depend on the user's
 * pack being installed (works in CI).
 */
const scopeBeforeCodeRule: Rule = {
  id: 'scope-before-code',
  kind: 'track_check',
  requires: [],
  process: [
    { call: 'tool_name', as: 'tool' },
    { call: 'tool_args', as: 'targs' },
    { call: 'is_automation_mode', as: 'auto' },
    {
      call: 'has_generated_spec',
      if: 'auto.value == true && (tool == "Write" || tool == "Edit") && contains(targs.file_path, "src/")',
      as: 'prov',
    },
    {
      call: 'verdict',
      if: 'auto.value == true && (tool == "Write" || tool == "Edit") && contains(targs.file_path, "src/") && prov.generated == false',
      args: {
        level: 'block',
        message:
          "BLOCKED: coding before scope→task. This work's active task has no generator provenance (a docs/tasks spec on disk).",
      },
    },
  ],
};

function packWithGateA(): Pack {
  const skill: Skill = {
    name: 'scope-decomposer',
    load: 'preload',
    when_to_load: [],
    requires: [],
    unloads_when: [],
    triggers: [{ kind: 'tool_call' }],
    rules: [scopeBeforeCodeRule],
  };
  return {
    name: 'asg3-fixture-pack',
    version: '0.0.0',
    scope: 'workflow',
    goal: 'gate-a-e2e',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [skill],
    activationScope: 'project',
    detectedBy: [],
  };
}

/**
 * Seed an active-task.json. The on-disk shape (per ActiveTask in
 * `runtime/session_state.ts:175-185`) has `spec` at top level — NOT under a
 * nested `metadata`. The AP.1 mirror flattens `metadata.spec` to top-level
 * `spec` when it copies the harness task store. `HasGeneratedSpec` reads the
 * top-level field directly. When `withSpec` is true, also write a real file
 * at the spec path so the primitive's `pathExistsAbs` check passes.
 */
async function seedActiveTask(
  sessionId: string,
  withSpec: boolean,
  specPath: string,
): Promise<void> {
  const path = activeTaskFile(sessionId);
  await mkdir(dirname(path), { recursive: true });
  const body: Record<string, unknown> = {
    id: 't-asg3',
    subject: 'e2e probe task',
    started_at: new Date().toISOString(),
  };
  if (withSpec) {
    body.spec = specPath;
    body.taskId = 'T-ASG';
    // Create the on-disk spec so HasGeneratedSpec.pathExistsAbs returns true.
    await mkdir(dirname(specPath), { recursive: true });
    await writeFile(specPath, '# fake spec for ASG.3 e2e\n', 'utf8');
  }
  await writeFile(path, JSON.stringify(body), 'utf8');
}

function writeSrcEvent(): ToolCallEvent {
  return {
    kind: 'tool_call',
    tool: 'Write',
    args: { file_path: 'src/foo.ts', content: 'export const x = 1;' },
  };
}

function writeDocsEvent(): ToolCallEvent {
  return {
    kind: 'tool_call',
    tool: 'Write',
    args: { file_path: 'docs/foo.md', content: '# hi' },
  };
}

describe('Gate A (scope-before-code) end-to-end through dispatchEvent', () => {
  it('BLOCKS a Write to src/ when automation is ON + active task has NO spec', async () => {
    const sessionId = 'asg3-block';
    await seedActiveTask(sessionId, false, '');
    process.env.OPENSQUID_AUTOMATION = '1'; // automation ON (env-only signal)

    const result = await dispatchEvent(
      writeSrcEvent(),
      [packWithGateA()],
      buildRealRegistry(),
      sessionId,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('BLOCKED: coding before scope');
  });

  it('PASSES a Write to src/ when active task has spec pointing at a real file', async () => {
    const sessionId = 'asg3-pass-spec';
    const specPath = join(tempHome, 'docs', 'tasks', 'T-asg3.md');
    await seedActiveTask(sessionId, true, specPath);
    process.env.OPENSQUID_AUTOMATION = '1'; // automation ON (env-only signal)

    const result = await dispatchEvent(
      writeSrcEvent(),
      [packWithGateA()],
      buildRealRegistry(),
      sessionId,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('PASSES a Write to src/ when automation is OFF (gate precondition not met)', async () => {
    const sessionId = 'asg3-auto-off';
    await seedActiveTask(sessionId, false, '');
    // intentionally do NOT call setAutomationFlag

    const result = await dispatchEvent(
      writeSrcEvent(),
      [packWithGateA()],
      buildRealRegistry(),
      sessionId,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('PASSES a Write to docs/ (path mismatch — gate scoped to src/ only)', async () => {
    const sessionId = 'asg3-non-src';
    await seedActiveTask(sessionId, false, '');
    process.env.OPENSQUID_AUTOMATION = '1'; // automation ON (env-only signal)

    const result = await dispatchEvent(
      writeDocsEvent(),
      [packWithGateA()],
      buildRealRegistry(),
      sessionId,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });
});
