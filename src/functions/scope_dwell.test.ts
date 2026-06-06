/**
 * Tests for `scope_dwell_tick` (T-FLOW-UNSKIPPABLE FU.2 / D2) — scope-sprawl
 * escalation. FSM state + counter isolated via OPENSQUID_HOME.
 */
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionStateFile } from '../runtime/paths.js';

import { ScopeDwellTick } from './scope_dwell.js';

const SID = 'sd-test';
const ctx = { sessionId: SID, event: { kind: 'prompt_submit' as const, prompt: 'x' } } as never;

async function setFsm(state: string): Promise<void> {
  const p = sessionStateFile(SID, 'fsm-coding-flow');
  await mkdir(dirname(p), { recursive: true });
  await writeFile(
    p,
    JSON.stringify({ state, started_at: '2026-06-06T00:00:00.000Z', history: [] }),
    'utf8',
  );
}

describe('scope_dwell_tick (FU.2)', () => {
  let home: string;
  let prior: string | undefined;

  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'sd-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('nudges at the 3rd consecutive scoping tick, not before', async () => {
    await setFsm('scoping');
    const r1 = await ScopeDwellTick.execute({}, ctx);
    const r2 = await ScopeDwellTick.execute({}, ctx);
    const r3 = await ScopeDwellTick.execute({}, ctx);
    expect(r1.ok && r1.value.nudge).toBe(false);
    expect(r2.ok && r2.value.nudge).toBe(false);
    expect(r3.ok && r3.value.nudge).toBe(true);
    expect(r3.ok && r3.value.count).toBe(3);
  });

  it('resets the counter when the FSM leaves the scope region', async () => {
    await setFsm('scoping');
    await ScopeDwellTick.execute({}, ctx);
    await ScopeDwellTick.execute({}, ctx); // count = 2
    await setFsm('spec_authored'); // advanced out of scope
    const rOut = await ScopeDwellTick.execute({}, ctx);
    expect(rOut.ok && rOut.value).toEqual({ nudge: false, count: 0 });
    // counter on disk reset to 0
    const cnt = Number(
      JSON.parse(await readFile(sessionStateFile(SID, 'coding-flow-scope-dwell'), 'utf8')),
    );
    expect(cnt).toBe(0);
    // back in scope: starts from 1 again
    await setFsm('scoping');
    const rBack = await ScopeDwellTick.execute({}, ctx);
    expect(rBack.ok && rBack.value.count).toBe(1);
  });

  it('no FSM state (idle/absent) → no nudge, no throw', async () => {
    const r = await ScopeDwellTick.execute({}, ctx);
    expect(r.ok && r.value).toEqual({ nudge: false, count: 0 });
  });
});
