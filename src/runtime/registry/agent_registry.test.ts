/** T3a — agent registry: model-agnostic WHO, lease-fresh resolve, self-first ordering, seed assembly. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeLease } from '../chat/live_session_lease.js';
import {
  AgentRegistry,
  buildSelfEntry,
  discoverLiveStubs,
  seedAgentRegistry,
  type AgentEntry,
} from './agent_registry.js';

const NOW = new Date('2026-06-19T12:00:00.000Z');
const STALE = new Date('2026-06-19T11:00:00.000Z'); // 1h old ≫ STALE_MS (90s)

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osq-agentreg-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A live (fresh) lease + an AgentEntry that points at it. */
async function liveEntry(id: string, executor: string, refreshedAt = NOW): Promise<AgentEntry> {
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

describe('AgentRegistry.resolve (T3a)', () => {
  it('returns a fresh entry providing the backend; excludes a STALE-lease entry (no assume-up)', async () => {
    const r = new AgentRegistry();
    r.register(await liveEntry('a', 'gpt', NOW)); // fresh
    r.register(await liveEntry('b', 'gpt', STALE)); // stale lease
    const out = await r.resolve('gpt', 'self', NOW);
    expect(out.map((e) => e.id)).toEqual(['a']); // only the fresh one
  });

  it('model-agnostic: a gpt and a claude entry coexist; resolve filters by backend name', async () => {
    const r = new AgentRegistry();
    r.register(await liveEntry('g', 'gpt'));
    r.register(await liveEntry('c', 'claude'));
    expect((await r.resolve('gpt', 'self', NOW)).map((e) => e.id)).toEqual(['g']);
    expect((await r.resolve('claude', 'self', NOW)).map((e) => e.id)).toEqual(['c']);
  });

  it('orders self-first, then most-recent refreshed_at', async () => {
    const r = new AgentRegistry();
    r.register(await liveEntry('old', 'claude', new Date('2026-06-19T11:59:30.000Z')));
    r.register(await liveEntry('new', 'claude', new Date('2026-06-19T11:59:59.000Z')));
    r.register(await liveEntry('self', 'claude', new Date('2026-06-19T11:59:10.000Z')));
    expect((await r.resolve('claude', 'self', NOW)).map((e) => e.id)).toEqual([
      'self',
      'new',
      'old',
    ]);
  });

  it('no live provider → [] (the caller fail-closes)', async () => {
    const r = new AgentRegistry();
    expect(await r.resolve('gpt', 'self', NOW)).toEqual([]);
  });
});

describe('AgentRegistry.liveness (T3a)', () => {
  it('connected on a fresh lease, disconnected on a stale one or an unknown id', async () => {
    const r = new AgentRegistry();
    r.register(await liveEntry('fresh', 'claude', NOW));
    r.register(await liveEntry('stale', 'claude', STALE));
    expect(await r.liveness('fresh', NOW)).toBe('connected');
    expect(await r.liveness('stale', NOW)).toBe('disconnected');
    expect(await r.liveness('nope', NOW)).toBe('disconnected');
  });
});

describe('buildSelfEntry (T3a)', () => {
  it('maps claimAudience.source → harness, sessionId → id, register payload → the four fields', () => {
    const e = buildSelfEntry(
      { source: 'claudecode', version: 'x' },
      '/leases/self.json',
      { executor: 'claude', capabilities: ['edit', 'bash'], scope: 'user', role: 'coder' },
      'sid-1',
    );
    expect(e).toEqual({
      id: 'sid-1',
      harness: 'claudecode',
      executor: 'claude',
      auth: 'host-inherited',
      capabilities: ['edit', 'bash'],
      scope: 'user',
      role: 'coder',
      leasePath: '/leases/self.json',
    });
  });

  it('an unknown harness source → harness: "unknown"', () => {
    const e = buildSelfEntry(
      { source: 'unknown' },
      '/l.json',
      { executor: 'gpt', capabilities: [], scope: 'project', role: 'r' },
      'sid-2',
    );
    expect(e.harness).toBe('unknown');
    expect(e.executor).toBe('gpt');
  });
});

describe('discoverLiveStubs (T3a)', () => {
  it('enumerates fresh leases → id+liveness stubs (executor:""); excludes self + stale', async () => {
    await writeLease(join(dir, 'a.json'), 'a', NOW); // fresh
    await writeLease(join(dir, 'b.json'), 'b', NOW); // fresh
    await writeLease(join(dir, 'self.json'), 'self', NOW); // self → excluded
    await writeLease(join(dir, 'old.json'), 'old', STALE); // stale → excluded
    const stubs = await discoverLiveStubs(dir, 'self', NOW);
    expect(stubs.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(stubs.every((s) => s.executor === '')).toBe(true); // stubs are not executor-resolvable
  });

  it('a stub is NOT returned by resolve() (executor "" ≠ a real backend name)', async () => {
    const stubs = await discoverLiveStubs(dir, 'self', NOW); // empty dir → []
    const r = seedAgentRegistry(await liveEntry('self', 'claude'), stubs);
    expect((await r.resolve('claude', 'self', NOW)).map((e) => e.id)).toEqual(['self']);
    expect(await r.resolve('', 'self', NOW)).toEqual([]); // an empty backend never resolves
  });

  it('a missing lease dir → [] (fail-soft, never throws)', async () => {
    expect(await discoverLiveStubs(join(dir, 'nope'), 'self', NOW)).toEqual([]);
  });
});
