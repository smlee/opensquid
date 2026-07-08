/**
 * WGL.8 (wg-141e0ffd9955) — cross-element integration for the workgraph item-lifecycle. Exercises the seven
 * scoped elements END-TO-END over a REAL event-sourced store (a temp file db + a temp `sourceDir` so the
 * rebuild-replay proof is genuine — the op-files ARE the source of truth), with NO real `.opensquid` I/O:
 *   (1) archive op → applyOp sets `archived` + listReady excludes it + rebuild replay reconstructs it;
 *   (2) autoDecompose stamps a parent-child edge + generation id per child;
 *   (3) re-decompose with a NEW generation archives the prior generation and adds the current (by run-id, not
 *       element-diff);
 *   (4) the reaper archives an orphan stub and leaves a live item (automation never scopes — archive only);
 *   (5) a parent auto-closes when all children closed/archived/wedged while a wedged child stays escalated;
 *   (6) an all-orphan board reaps-then-BOARD_EMPTY (the reaper is idempotent → converges);
 *   (7) the MCP archive tool round-trips.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rebuildWorkGraph, workGraphStore } from '../../workgraph/store.js';
import { handleWgArchive, handleWgUnarchive } from '../../mcp/tools/workgraph.js';

import { autoDecompose, deriveGenerationId } from './auto_decompose.js';
import { reconcileDecomposition } from './decompose_reconcile.js';
import { reapOrphans } from './reaper.js';
import { rollUpParents } from './parent_rollup.js';
import { extractScope } from './scope_extract.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wgl-e2e-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = async () => {
  const s = workGraphStore({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
  await s.init();
  return s;
};
async function artifact(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
}
const ext = async (p: string) => {
  const e = await extractScope(p);
  if (e === null) throw new Error('extractScope null');
  return e;
};
const V1 = ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]'].join('\n');
const V2 = ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]', '3. Third [ask: "c"]'].join(
  '\n',
);

describe('workgraph lifecycle e2e (WGL.8)', () => {
  it('(1) archive op survives rebuild replay + listReady excludes it (event-sourcing integrity)', async () => {
    const s = await open();
    const a = await s.createIssue({ title: 'A' });
    await s.archiveIssue(a.id, 'reaped');
    expect((await s.getIssue(a.id))?.status).toBe('archived');
    expect((await s.listReady()).map((i) => i.id)).not.toContain(a.id);
    const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
    await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
    const s2 = workGraphStore({ dbUrl: rebuiltUrl });
    await s2.init();
    expect((await s2.getIssue(a.id))?.status).toBe('archived'); // reconstructed from op-files, not a projection re-read
  });

  it('(2) autoDecompose stamps a parent-child edge + generation id per child', async () => {
    const s = await open();
    const parent = await s.createIssue({ title: 'task' });
    const p = await artifact('v1.md', V1);
    const gen = deriveGenerationId(await ext(p));
    await autoDecompose(p, s, { parentId: parent.id, generationId: gen });
    const edges = await s.listEdges();
    const kids = edges
      .filter((e) => e.type === 'parent-child' && e.from === parent.id)
      .map((e) => e.to);
    expect(kids).toHaveLength(2);
    for (const k of kids) expect((await s.getIssue(k))?.body).toContain(`generationId:${gen}`);
  });

  it('(3) re-decompose with a NEW generation archives the prior generation, adds the current (run-id, not diff)', async () => {
    const s = await open();
    const parent = await s.createIssue({ title: 'task' });
    const p1 = await artifact('v1.md', V1);
    await reconcileDecomposition(s, parent.id, p1, await ext(p1));
    const v1kids = (await s.listEdges())
      .filter((e) => e.type === 'parent-child' && e.from === parent.id)
      .map((e) => e.to);
    const p2 = await artifact('v2.md', V2);
    const r = await reconcileDecomposition(s, parent.id, p2, await ext(p2));
    expect(r.action).toBe('superseded');
    for (const id of v1kids) expect((await s.getIssue(id))?.status).toBe('archived'); // prior gen kept as history
    const ready = (await s.listReady()).map((i) => i.id);
    for (const id of v1kids) expect(ready).not.toContain(id);
  });

  it('(4) the reaper archives an orphan stub, leaves a live item, and scopes NOTHING', async () => {
    const s = await open();
    const parent = await s.createIssue({ title: 'task' });
    const owned = await s.createIssue({ title: 'owned', body: 'sourceElementId:scope-1' });
    await s.addEdge(parent.id, owned.id, 'parent-child');
    const orphan = await s.createIssue({ title: 'orphan', body: 'sourceElementId:scope-9' });
    const reaped = await reapOrphans(s);
    expect(reaped).toEqual([orphan.id]);
    expect((await s.getIssue(orphan.id))?.status).toBe('archived');
    expect((await s.getIssue(owned.id))?.status).toBe('open');
    // automation-never-scopes: the only op the reaper wrote is the archive (no issue_set/claim/checkpoint).
    expect((await s.listEvents(orphan.id)).map((o) => o.type)).toEqual([
      'issue_created',
      'issue_archived',
    ]);
  });

  it('(5) a parent rolls up when all children closed/archived/wedged; a wedged child stays escalated', async () => {
    const s = await open();
    const P = await s.createIssue({ title: 'P' });
    const C1 = await s.createIssue({ title: 'C1' });
    const C2 = await s.createIssue({ title: 'C2' });
    const C3 = await s.createIssue({ title: 'C3' });
    await s.addEdge(P.id, C1.id, 'parent-child');
    await s.addEdge(P.id, C2.id, 'parent-child');
    await s.addEdge(P.id, C3.id, 'parent-child');
    await s.updateIssue(C1.id, { status: 'closed' });
    await s.archiveIssue(C2.id, 'superseded');
    await s.wedgeMark(C3.id, 'stuck');
    expect(await rollUpParents(s, C1.id)).toEqual([P.id]);
    expect((await s.getIssue(P.id))?.status).toBe('closed');
    expect((await s.getIssue(C3.id))?.wedgeReason).toBe('stuck'); // never buried
  });

  it('(6) an all-orphan board reaps then converges (idempotent — pass 2 archives nothing)', async () => {
    const s = await open();
    await s.createIssue({ title: 'o1', body: 'sourceElementId:scope-1' });
    await s.createIssue({ title: 'o2', body: 'sourceElementId:scope-2' });
    expect((await reapOrphans(s)).length).toBe(2); // pass 1 reaps both
    expect(await reapOrphans(s)).toEqual([]); // pass 2 → nothing new (converges, no infinite loop)
    expect(await s.listReady()).toEqual([]); // board genuinely empty now
  });

  it('(7) the MCP archive tool round-trips open → archived → open', async () => {
    const s = await open();
    const a = await s.createIssue({ title: 'stub' });
    expect(JSON.parse(await handleWgArchive({ id: a.id, reason: 'orphan' }, s))).toEqual({
      ok: true,
      id: a.id,
      status: 'archived',
    });
    expect((await s.getIssue(a.id))?.status).toBe('archived');
    expect(JSON.parse(await handleWgUnarchive({ id: a.id }, s))).toEqual({
      ok: true,
      id: a.id,
      status: 'open',
    });
    expect((await s.getIssue(a.id))?.status).toBe('open');
  });
});
