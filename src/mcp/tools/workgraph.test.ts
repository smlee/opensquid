/**
 * Tests for the work-graph MCP handlers (T-WORKGRAPH-MCP). Exercises each handler end-to-end
 * against a :memory: workGraphStore (schemas are validated by the server before dispatch; the
 * store's own guards surface as thrown errors → JSON-RPC errors).
 */
import { describe, expect, it } from 'vitest';

import { bindProject, workGraphStore } from '../../workgraph/store.js';

import {
  handleWgAddEdge,
  handleWgCreate,
  handleWgEvents,
  handleWgGet,
  handleWgList,
  handleWgReady,
  handleWgUpdate,
} from './workgraph.js';

// The handlers take a per-project WorkGraphFacade (T-WORKGRAPH-PROJECT-SCOPE); bind one for the tests.
const fresh = async () => {
  const base = workGraphStore({ dbUrl: ':memory:' });
  await base.init();
  return bindProject(base, 'test-project');
};

describe('workgraph MCP handlers', () => {
  it('create → get round-trip + list', async () => {
    const s = await fresh();
    const created = JSON.parse(await handleWgCreate({ title: 'a', body: 'do' }, s)) as {
      id: string;
    };
    expect(created.id.startsWith('wg-')).toBe(true);
    expect(JSON.parse(await handleWgGet({ id: created.id }, s))).toEqual(created);
    expect(JSON.parse(await handleWgList({}, s))).toHaveLength(1);
  });

  it('addEdge → ready excludes the blocked; closing frees it; events show the ops', async () => {
    const s = await fresh();
    const a = JSON.parse(await handleWgCreate({ title: 'blocker' }, s)) as { id: string };
    const b = JSON.parse(await handleWgCreate({ title: 'blocked' }, s)) as { id: string };
    expect(JSON.parse(await handleWgAddEdge({ from: a.id, to: b.id, type: 'blocks' }, s))).toEqual({
      ok: true,
    });
    expect((JSON.parse(await handleWgReady({}, s)) as { id: string }[]).map((i) => i.id)).toEqual([
      a.id,
    ]);
    await handleWgUpdate({ id: a.id, status: 'closed' }, s);
    expect((JSON.parse(await handleWgReady({}, s)) as { id: string }[]).map((i) => i.id)).toEqual([
      b.id,
    ]);
    // a is the `from` of the edge, so its op-log also carries the dep_added op.
    const events = JSON.parse(await handleWgEvents({ id: a.id }, s)) as { type: string }[];
    expect(events.map((e) => e.type)).toEqual(['issue_created', 'dep_added', 'issue_set']);
  });

  it('update reflects in get; a missing edge endpoint rejects', async () => {
    const s = await fresh();
    const a = JSON.parse(await handleWgCreate({ title: 'x' }, s)) as { id: string };
    await expect(handleWgAddEdge({ from: a.id, to: 'wg-nope', type: 'blocks' }, s)).rejects.toThrow(
      /endpoint missing/,
    );
    await handleWgUpdate({ id: a.id, status: 'in_progress' }, s);
    expect((JSON.parse(await handleWgGet({ id: a.id }, s)) as { status: string }).status).toBe(
      'in_progress',
    );
  });
});
