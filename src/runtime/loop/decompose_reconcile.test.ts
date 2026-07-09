/**
 * WGL.3 (wg-141e0ffd9955) — reconcile-on-re-decompose by RUN-ID. Proves the three branches
 * (first / idempotent / superseded) keyed on generation-id MISMATCH (not element-diff), that a superseded
 * generation is soft-archived (kept as history, off ready), and that a pre-ownership child (no generationId:
 * body) is treated as a different generation → superseded. Over a real `:memory:` workGraphStore.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { workGraphStore } from '../../workgraph/store.js';

import { reconcileDecomposition } from './decompose_reconcile.js';
import { extractScope } from './scope_extract.js';

const fresh = async () => {
  const s = workGraphStore({ dbUrl: ':memory:' });
  await s.init();
  return s;
};

async function artifact(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'recon-'));
  const p = join(dir, 'scope.md');
  await writeFile(p, body);
  return p;
}
const ext = async (p: string) => {
  const e = await extractScope(p);
  if (e === null) throw new Error('extractScope returned null');
  return e;
};

const V1 = ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]'].join('\n');
const V2 = ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]', '3. Third [ask: "c"]'].join(
  '\n',
);

const kidsOf = async (s: Awaited<ReturnType<typeof fresh>>, parentId: string) =>
  (await s.listEdges())
    .filter((e) => e.type === 'parent-child' && e.from === parentId)
    .map((e) => e.to);

describe('reconcileDecomposition (WGL.3)', () => {
  it('FIRST: empty board → decompose, action=first, parent-child edges stamped', async () => {
    const s = await fresh();
    const parent = await s.createIssue({ title: 'task', body: '' });
    const p = await artifact(V1);
    const r = await reconcileDecomposition(s, parent.id, p, await ext(p));
    expect(r.action).toBe('first');
    expect(r.archived).toEqual([]);
    expect(await kidsOf(s, parent.id)).toHaveLength(2);
  });

  it('IDEMPOTENT: re-running the SAME artifact → no new issues, no archives', async () => {
    const s = await fresh();
    const parent = await s.createIssue({ title: 'task', body: '' });
    const p = await artifact(V1);
    const e = await ext(p);
    await reconcileDecomposition(s, parent.id, p, e);
    const before = (await s.listIssues()).length;
    const r = await reconcileDecomposition(s, parent.id, p, e);
    expect(r.action).toBe('idempotent');
    expect(r.archived).toEqual([]);
    expect((await s.listIssues()).length).toBe(before);
  });

  it('SUPERSEDE: a re-authored generation archives the prior children and adds the current', async () => {
    const s = await fresh();
    const parent = await s.createIssue({ title: 'task', body: '' });
    const p1 = await artifact(V1);
    await reconcileDecomposition(s, parent.id, p1, await ext(p1));
    const v1kids = await kidsOf(s, parent.id);

    const p2 = await artifact(V2);
    const r = await reconcileDecomposition(s, parent.id, p2, await ext(p2));
    expect(r.action).toBe('superseded');
    expect([...r.archived].sort()).toEqual([...v1kids].sort());
    for (const id of v1kids) expect((await s.getIssue(id))?.status).toBe('archived'); // kept as history
    const ready = (await s.listReady()).map((i) => i.id);
    for (const id of v1kids) expect(ready).not.toContain(id); // off ready
  });

  it('a pre-ownership child (no generationId: body) is a DIFFERENT generation → superseded', async () => {
    const s = await fresh();
    const parent = await s.createIssue({ title: 'task', body: '' });
    const legacy = await s.createIssue({ title: 'scope-1', body: 'sourceElementId:scope-1' });
    await s.addEdge(parent.id, legacy.id, 'parent-child');
    const p = await artifact(V1);
    const r = await reconcileDecomposition(s, parent.id, p, await ext(p));
    expect(r.action).toBe('superseded');
    expect(r.archived).toEqual([legacy.id]);
    expect((await s.getIssue(legacy.id))?.status).toBe('archived');
  });
});
