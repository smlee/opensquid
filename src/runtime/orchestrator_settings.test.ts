/** ORCH.4 — orchestrator settings: defaults, declared domain, resolveRoute precedence + self-heal, round-trip. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readSettings,
  recordRoute,
  resolveRoute,
  setProjectDomain,
  pinRoute,
  forgetRoute,
  type Settings,
  type Route,
} from './orchestrator_settings.js';

let proj: string;
beforeEach(async () => {
  proj = await mkdtemp(join(tmpdir(), 'osq-orch-'));
});
afterEach(async () => {
  await rm(proj, { recursive: true, force: true });
});

const write = async (s: unknown): Promise<void> => {
  await mkdir(join(proj, '.opensquid'), { recursive: true });
  await writeFile(join(proj, '.opensquid', 'orchestrator.json'), JSON.stringify(s));
};

const route = (over: Partial<Route> & Pick<Route, 'match' | 'pack' | 'source' | 'at'>): Route =>
  over;
const settings = (routes: Route[], domain?: Settings['domain']): Settings => ({
  version: 1,
  ...(domain ? { domain } : {}),
  routes,
  policy: { onTie: 'ask', onLowConfidence: 'ground', onlineSearch: false },
});

describe('readSettings (ORCH.4)', () => {
  it('absent file → DEFAULTS (domain undefined, policy defaults)', async () => {
    const s = await readSettings(proj);
    expect(s.domain).toBeUndefined();
    expect(s.routes).toEqual([]);
    expect(s.policy).toEqual({ onTie: 'ask', onLowConfidence: 'ground', onlineSearch: false });
  });

  it('corrupt JSON → DEFAULTS (no throw)', async () => {
    await mkdir(join(proj, '.opensquid'), { recursive: true });
    await writeFile(join(proj, '.opensquid', 'orchestrator.json'), '{ not json');
    expect((await readSettings(proj)).routes).toEqual([]);
  });

  it('exposes the project-declared domain', async () => {
    await write({ version: 1, domain: 'coding', routes: [] });
    expect((await readSettings(proj)).domain).toBe('coding');
  });
});

describe('resolveRoute (ORCH.4)', () => {
  const facets = { intent: 'produce', domain: 'coding' };

  it('most-specific wins, then pinned over asked, then newest', () => {
    const s = settings([
      route({
        match: { intent: 'produce' },
        pack: 'broad',
        source: 'asked',
        at: '2026-06-22T03:00:00Z',
      }),
      route({
        match: { intent: 'produce', domain: 'coding' },
        pack: 'asked-pack',
        source: 'asked',
        at: '2026-06-22T01:00:00Z',
      }),
      route({
        match: { intent: 'produce', domain: 'coding' },
        pack: 'pinned-pack',
        source: 'pinned',
        at: '2026-06-22T02:00:00Z',
      }),
    ]);
    // both 2-key routes beat the 1-key 'broad'; pinned beats asked.
    expect(resolveRoute(s, facets, new Set(['broad', 'asked-pack', 'pinned-pack']))).toBe(
      'pinned-pack',
    );
  });

  it('self-heal: a route whose pack is not in the catalog is skipped', () => {
    const s = settings([
      route({
        match: { intent: 'produce', domain: 'coding' },
        pack: 'gone',
        source: 'pinned',
        at: '2026-06-22T02:00:00Z',
      }),
      route({
        match: { intent: 'produce', domain: 'coding' },
        pack: 'live',
        source: 'asked',
        at: '2026-06-22T01:00:00Z',
      }),
    ]);
    expect(resolveRoute(s, facets, new Set(['live']))).toBe('live'); // 'gone' dropped despite being pinned + newer
  });

  it('no matching route → null', () => {
    const s = settings([
      route({
        match: { intent: 'inform' },
        pack: 'p',
        source: 'asked',
        at: '2026-06-22T01:00:00Z',
      }),
    ]);
    expect(resolveRoute(s, facets, new Set(['p']))).toBeNull();
  });
});

describe('recordRoute (ORCH.4)', () => {
  it('appends an asked route and round-trips via readSettings (atomic write)', async () => {
    await recordRoute(
      proj,
      { intent: 'produce', domain: 'coding' },
      'coding-flow',
      '2026-06-22T05:00:00Z',
    );
    const s = await readSettings(proj);
    expect(s.routes).toHaveLength(1);
    expect(s.routes[0]).toMatchObject({
      pack: 'coding-flow',
      source: 'asked',
      match: { intent: 'produce', domain: 'coding' },
    });
    // the file actually exists at the project-local path (never ~/.opensquid)
    const raw = await readFile(join(proj, '.opensquid', 'orchestrator.json'), 'utf8');
    const parsed = JSON.parse(raw) as { routes: { pack: string }[] };
    expect(parsed.routes[0]?.pack).toBe('coding-flow');
  });
});

describe('control writers (ORCH.9)', () => {
  const now = '2026-06-22T07:00:00Z';
  let p: string; // a dir local to each writer test (defensive isolation)
  beforeEach(async () => {
    p = await mkdtemp(join(tmpdir(), 'osq-orch9-'));
  });
  afterEach(async () => {
    await rm(p, { recursive: true, force: true });
  });

  it('setProjectDomain round-trips a dictionary domain', async () => {
    await setProjectDomain(p, 'coding');
    expect((await readSettings(p)).domain).toBe('coding');
  });

  it('pinRoute writes a pinned route that resolveRoute prefers; replacing a same-match pin does not duplicate', async () => {
    await pinRoute(p, { intent: 'produce', domain: 'coding' }, 'pack-a', now);
    await pinRoute(p, { intent: 'produce', domain: 'coding' }, 'pack-b', now); // same match → replace
    const s = await readSettings(p);
    const pins = s.routes.filter((r) => r.source === 'pinned');
    expect(pins).toHaveLength(1);
    expect(
      resolveRoute(s, { intent: 'produce', domain: 'coding' }, new Set(['pack-a', 'pack-b'])),
    ).toBe('pack-b');
  });

  it('forgetRoute removes all routes for a pack', async () => {
    expect((await readSettings(p)).routes).toEqual([]); // fresh dir — proves isolation
    await recordRoute(p, { intent: 'produce' }, 'gone', now);
    await pinRoute(p, { intent: 'inform' }, 'gone', now);
    await recordRoute(p, { intent: 'decide' }, 'keep', now);
    await forgetRoute(p, 'gone');
    const s = await readSettings(p);
    expect(s.routes.map((r) => r.pack)).toEqual(['keep']);
  });
});
