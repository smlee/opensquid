/** T-scope-worksheet — projectScopes: batch completion = work-graph issue `closed` (real store). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Worksheet } from '../../packs/schemas/worksheet.js';
import { workGraphStore } from '../../workgraph/store.js';
import { projectScopes } from './projection.js';

let home: string;
const saved = process.env.OPENSQUID_HOME;

function homeStore(h: string): ReturnType<typeof workGraphStore> {
  return workGraphStore({
    dbUrl: `file:${join(h, 'workgraph.db')}`,
    sourceDir: join(h, 'store', 'issues'),
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opensquid-ws-proj-'));
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = saved;
  await rm(home, { recursive: true, force: true });
});

describe('projectScopes — batch completion via work-graph issue status', () => {
  it('a closed issue → complete; an open issue → incomplete', async () => {
    const wg = homeStore(home);
    await wg.init();
    const a = await wg.createIssue({ title: 'scope a' });
    const b = await wg.createIssue({ title: 'scope b' });
    await wg.updateIssue(a.id, { status: 'closed' });

    const ws: Worksheet = {
      mode: 'batch',
      scopes: [
        { id: 'a', issue: a.id, summary: 'sa' },
        { id: 'b', issue: b.id, summary: 'sb' },
      ],
      order: ['a', 'b'],
    };
    const proj = await projectScopes(ws, 'sid-proj-test', '/tmp/whatever-worksheet.md');
    expect(proj.find((p) => p.id === 'a')?.complete).toBe(true);
    expect(proj.find((p) => p.id === 'b')?.complete).toBe(false);
  });
});
