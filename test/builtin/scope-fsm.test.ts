/**
 * Built-in `scope-fsm` pack (T-PACK-FSM-STANDARDIZATION slice C) — loads from
 * disk and ENFORCES research-before-code through the real dispatcher. Proves
 * the on-disk fsm.yaml + skill.yaml (not just an in-test pack) deliver the
 * FSM-driven guess-prevention.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../../src/functions/event.js';
import { registerFsmFunctions } from '../../src/functions/fsm.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import { registerVerdictFunctions } from '../../src/functions/verdict.js';
import { loadPack } from '../../src/packs/loader.js';
import { dispatchEvent } from '../../src/runtime/hooks/dispatch.js';
import type { ToolCallEvent } from '../../src/runtime/types.js';

function registry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerVerdictFunctions(r);
  return r;
}

const writeCode: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'src/feature.ts' },
};
const writeResearch: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/research/feature-pre-research.md' },
};

describe('builtin scope-fsm pack', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-scope-fsm-builtin-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('loads with a valid total FSM + the scope-lifecycle skill', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'scope-fsm'));
    expect(pack.name).toBe('scope-fsm');
    expect(pack.fsm?.initial).toBe('scoping');
    expect(pack.fsm?.states).toEqual(['scoping', 'researching', 'researched', 'building']);
    const skill = pack.skills.find((s) => s.name === 'scope-lifecycle');
    expect(skill?.rules.map((r) => r.id)).toEqual([
      'advance-on-research-doc',
      'research-before-code',
    ]);
  });

  it('blocks src/ writes pre-research, then allows them once the pre-research doc is written', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'scope-fsm'));
    const reg = registry();
    const sid = 'sess-builtin-scope';
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(2); // scoping → blocked
    expect((await dispatchEvent(writeResearch, [pack], reg, sid)).exitCode).toBe(0); // advance
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(0); // researched → allowed
  });
});
