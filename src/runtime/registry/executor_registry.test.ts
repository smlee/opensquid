/** T3b — RegistryBackedExecutors: fail-closed resolution over the agent registry. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeLease } from '../chat/live_session_lease.js';
import type { Executor } from '../loop/driver.js';
import { AgentRegistry, type AgentEntry } from './agent_registry.js';
import { RegistryBackedExecutors } from './executor_registry.js';

// ensureExecutor reads liveness against the REAL clock (the interface takes no `now`), so leases are written
// relative to `Date.now()`: a fresh lease is recent; a stale one is well past STALE_MS (90s).
const agoMs = (ms: number): Date => new Date(Date.now() - ms);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osq-execreg-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A trivial executor whose identity we can assert via a tagged `next`. */
function execTagged(tag: string): Executor {
  return { next: () => Promise.resolve(null), tag } as Executor & { tag: string };
}

async function entry(
  id: string,
  executor: string,
  refreshedAt: Date = agoMs(1000),
): Promise<AgentEntry> {
  const leasePath = join(dir, `${id}.json`);
  await writeLease(leasePath, id, refreshedAt);
  return {
    id,
    harness: 'unknown',
    executor,
    auth: 'host-inherited',
    capabilities: [],
    scope: 'user',
    role: '',
    leasePath,
  };
}

describe('RegistryBackedExecutors.ensureExecutor (T3b)', () => {
  it('a live agent WITH a registered factory → returns its executor', async () => {
    const reg = new AgentRegistry();
    reg.register(await entry('g', 'gpt'));
    const factories = new Map<string, () => Executor>([['g', () => execTagged('gpt-exec')]]);
    const r = new RegistryBackedExecutors(reg, factories, 'self');
    const ex = (await r.ensureExecutor('gpt')) as Executor & { tag: string };
    expect(ex.tag).toBe('gpt-exec');
  });

  it('a live agent but NO registered factory (a stub) → THROWS (fail-closed)', async () => {
    const reg = new AgentRegistry();
    reg.register(await entry('g', 'gpt')); // live, but no factory registered for 'g'
    const r = new RegistryBackedExecutors(reg, new Map(), 'self');
    await expect(r.ensureExecutor('gpt')).rejects.toThrow(
      /no connected executor for 'gpt' \(fail-closed\)/,
    );
  });

  it('an unregistered backend name → THROWS', async () => {
    const r = new RegistryBackedExecutors(new AgentRegistry(), new Map(), 'self');
    await expect(r.ensureExecutor('claude')).rejects.toThrow(/fail-closed/);
  });

  it('a STALE-lease agent is excluded by resolve → THROWS (no assume-up)', async () => {
    const reg = new AgentRegistry();
    reg.register(await entry('g', 'gpt', agoMs(200_000))); // ≫ STALE_MS
    const factories = new Map<string, () => Executor>([['g', () => execTagged('stale')]]);
    const r = new RegistryBackedExecutors(reg, factories, 'self');
    await expect(r.ensureExecutor('gpt')).rejects.toThrow(/fail-closed/);
  });

  it('two live providers of the same backend → the self factory is chosen (resolve ordering)', async () => {
    const reg = new AgentRegistry();
    reg.register(await entry('other', 'claude', agoMs(1000))); // more recent, but not self
    reg.register(await entry('self', 'claude', agoMs(5000))); // older, but it is self
    const factories = new Map<string, () => Executor>([
      ['other', () => execTagged('other-exec')],
      ['self', () => execTagged('self-exec')],
    ]);
    const r = new RegistryBackedExecutors(reg, factories, 'self');
    const ex = (await r.ensureExecutor('claude')) as Executor & { tag: string };
    expect(ex.tag).toBe('self-exec'); // self-first even though 'other' has a more recent lease
  });
});
