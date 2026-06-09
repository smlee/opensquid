/**
 * Tests for the legacy-row scope migration (T-memory-scope-isolation S4): the pure `classifyScope`
 * mapping table + a `migrateScope` dry-run/apply on a fixture libSQL DB (counts conserved, correct
 * tier/namespace, no row dropped, idempotent).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyScope, migrateScope } from './migrate-scope.js';

describe('classifyScope (pure mapping)', () => {
  it('maps known project names to their umbrella namespace', () => {
    expect(classifyScope(['scope:!project loop'])).toEqual({ tier: 'project', namespace: 'loop' });
    expect(classifyScope(['scope:!project RaumPilates-FE'])).toEqual({
      tier: 'project',
      namespace: 'raumpilates',
    });
  });
  it('maps user / empty / bare-project / unknown → shared (safe over-share)', () => {
    expect(classifyScope(['scope:user'])).toEqual({ tier: 'shared', namespace: null });
    expect(classifyScope(["scope:!project ''"])).toEqual({ tier: 'shared', namespace: null });
    expect(classifyScope(['scope:project', 'origin:import:x'])).toEqual({
      tier: 'shared',
      namespace: null,
    });
    expect(classifyScope(['scope:!project SomeUnknownProj'])).toEqual({
      tier: 'shared',
      namespace: null,
    });
    expect(classifyScope([])).toEqual({ tier: 'shared', namespace: null });
  });
});

describe('migrateScope (dry-run + apply on a fixture DB)', () => {
  let dir: string;
  let dbUrl: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migscope-'));
    dbUrl = `file:${join(dir, 'rag.sqlite')}`;
    const c = createClient({ url: dbUrl });
    // Old-shape lessons table (no scope columns yet) + the live tag mix.
    await c.execute(`CREATE TABLE lessons (id TEXT PRIMARY KEY, content TEXT NOT NULL,
      tags TEXT NOT NULL, source TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL)`);
    const rows: [string, string][] = [
      ['a', '["scope:!project loop"]'],
      ['b', '["scope:!project RaumPilates-FE"]'],
      ['c', '["scope:user"]'],
      ['d', '["scope:!project \'\'"]'],
      ['e', '["scope:project","origin:import:x"]'],
    ];
    for (const [id, tags] of rows) {
      await c.execute({
        sql: `INSERT INTO lessons (id, content, tags, source, author, created_at) VALUES (?,?,?,?,?,?)`,
        args: [id, 'body', tags, 'memory', 'user', '2026-06-09T00:00:00Z'],
      });
    }
    c.close();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dry-run mutates nothing but reports the plan; apply migrates correctly + is idempotent', async () => {
    const dry = await migrateScope({ dbUrl, apply: false });
    expect(dry).toMatchObject({ total: 5, toProject: 2, toShared: 3, applied: false });
    expect(dry.changed).toBe(2); // a + b become project; the rest are already-shared (default)

    // Dry-run left the data untouched (tier still defaults; namespace null).
    const c = createClient({ url: dbUrl });
    const before = await c.execute(`SELECT count(*) n FROM lessons WHERE tier='project'`);
    expect(Number(before.rows[0]?.n)).toBe(0);

    const applied = await migrateScope({ dbUrl, apply: true });
    expect(applied).toMatchObject({
      total: 5,
      toProject: 2,
      toShared: 3,
      changed: 2,
      applied: true,
    });

    const a = await c.execute(`SELECT tier, namespace FROM lessons WHERE id='a'`);
    expect(a.rows[0]).toMatchObject({ tier: 'project', namespace: 'loop' });
    const b = await c.execute(`SELECT tier, namespace FROM lessons WHERE id='b'`);
    expect(b.rows[0]).toMatchObject({ tier: 'project', namespace: 'raumpilates' });
    const total = await c.execute(`SELECT count(*) n FROM lessons`);
    expect(Number(total.rows[0]?.n)).toBe(5); // zero rows dropped

    // Idempotent: a second apply changes nothing.
    const again = await migrateScope({ dbUrl, apply: true });
    expect(again.changed).toBe(0);
    c.close();
  });
});
