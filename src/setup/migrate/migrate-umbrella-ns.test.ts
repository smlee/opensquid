/**
 * UCC.3 — migrate-umbrella-ns: re-namespace project-tier rows from the umbrella string to the
 * per-repo marker UUID. Covers the migration logic (dry-run / apply / idempotency / never-delete /
 * shared-untouched) with an injected map, plus buildUmbrellaUuidMap against a stub channels.json.
 */
import { createClient } from '@libsql/client';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildUmbrellaUuidMap, migrateUmbrellaNs } from './migrate-umbrella-ns.js';

describe('migrateUmbrellaNs (injected map)', () => {
  let dir: string;
  let dbUrl: string;
  const MAP = { loop: 'uuid-loop', raumpilates: 'uuid-raum' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'umb-ns-'));
    dbUrl = `file:${join(dir, 's.db')}`;
    const c = createClient({ url: dbUrl });
    await c.execute(`CREATE TABLE lessons (id TEXT PRIMARY KEY, tier TEXT, namespace TEXT)`);
    await c.batch([
      `INSERT INTO lessons VALUES ('l1','project','loop')`,
      `INSERT INTO lessons VALUES ('l2','project','loop')`,
      `INSERT INTO lessons VALUES ('r1','project','raumpilates')`,
      `INSERT INTO lessons VALUES ('s1','shared',NULL)`,
      `INSERT INTO lessons VALUES ('u1','project','uuid-loop')`, // already migrated
    ]);
    c.close();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const nsOf = async (): Promise<Record<string, string | null>> => {
    const c = createClient({ url: dbUrl });
    const rs = await c.execute(`SELECT id, namespace FROM lessons ORDER BY id`);
    c.close();
    return Object.fromEntries(rs.rows.map((r) => [r.id as string, r.namespace as string | null]));
  };

  it('dry-run reports the change set without mutating', async () => {
    const res = await migrateUmbrellaNs({ dbUrl, apply: false, umbrellaToUuid: MAP });
    expect(res).toEqual({ total: 4, changed: 3, applied: false }); // 4 project rows; 3 need change (u1 already)
    expect(await nsOf()).toEqual({
      l1: 'loop',
      l2: 'loop',
      r1: 'raumpilates',
      s1: null,
      u1: 'uuid-loop',
    });
  });

  it('apply re-namespaces project rows; shared + already-UUID untouched; count conserved', async () => {
    const res = await migrateUmbrellaNs({ dbUrl, apply: true, umbrellaToUuid: MAP });
    expect(res.changed).toBe(3);
    expect(await nsOf()).toEqual({
      l1: 'uuid-loop',
      l2: 'uuid-loop',
      r1: 'uuid-raum',
      s1: null, // shared never touched
      u1: 'uuid-loop',
    });
    const c = createClient({ url: dbUrl });
    const count = (await c.execute(`SELECT COUNT(*) AS n FROM lessons`)).rows[0]!.n;
    c.close();
    expect(Number(count)).toBe(5); // never-delete: row count conserved
  });

  it('idempotent: a second apply changes 0 rows', async () => {
    await migrateUmbrellaNs({ dbUrl, apply: true, umbrellaToUuid: MAP });
    const again = await migrateUmbrellaNs({ dbUrl, apply: true, umbrellaToUuid: MAP });
    expect(again.changed).toBe(0);
  });

  it('an unmapped umbrella namespace is left untouched (never guessed)', async () => {
    const res = await migrateUmbrellaNs({
      dbUrl,
      apply: true,
      umbrellaToUuid: { other: 'uuid-z' },
    });
    expect(res.changed).toBe(0);
    expect((await nsOf()).l1).toBe('loop');
  });
});

describe('buildUmbrellaUuidMap (channels.json → root marker UUID)', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'umb-home-'));
    prevHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  const marker = async (root: string, uuid: string): Promise<void> => {
    await mkdir(join(root, '.opensquid'), { recursive: true });
    await writeFile(
      join(root, '.opensquid', 'project.json'),
      JSON.stringify({ version: 1, id: uuid, uuid }),
      'utf8',
    );
  };

  it('maps each umbrella id → its ROOT member (shortest path) marker UUID', async () => {
    const loopRoot = join(home, 'loop');
    const sub = join(loopRoot, 'opensquid');
    const raumRoot = join(home, 'raum');
    await marker(loopRoot, 'uuid-loop');
    await marker(sub, 'uuid-sub'); // a longer member — must NOT win
    await marker(raumRoot, 'uuid-raum');
    await writeFile(
      join(home, 'channels.json'),
      JSON.stringify({
        v: 1,
        umbrellas: [
          { id: 'loop', members: [sub, loopRoot] }, // unsorted: root is the shortest
          { id: 'raumpilates', members: [raumRoot] },
        ],
      }),
      'utf8',
    );
    expect(await buildUmbrellaUuidMap()).toEqual({ loop: 'uuid-loop', raumpilates: 'uuid-raum' });
  });

  it('no channels.json → empty map', async () => {
    expect(await buildUmbrellaUuidMap()).toEqual({});
  });
});
