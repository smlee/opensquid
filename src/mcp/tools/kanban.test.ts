/** KANBAN.2 — kanban MCP handlers: sync maps the whole work-graph, board is a pure read, place/remove curate. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  kanbanMapStore,
  type Lane,
  type WorkGraphReader,
  type KanbanMapStore,
} from '../../kanban/map_store.js';
import type { Issue } from '../../workgraph/types.js';
import {
  handleKanbanBoard,
  handleKanbanCreateBoard,
  handleKanbanPlace,
  handleKanbanRemove,
  handleKanbanSync,
} from './kanban.js';

const dirs: string[] = [];
async function mk(): Promise<KanbanMapStore> {
  const dir = await mkdtemp(join(tmpdir(), 'osq-kanban-tools-'));
  dirs.push(dir);
  const store = kanbanMapStore(`file:${join(dir, 'k.db')}`);
  await store.init();
  return store;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const iss = (id: string, over: Partial<Issue> = {}): Issue => ({
  id,
  title: id,
  body: '',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const reader = (issues: Issue[], ready: Issue[]): WorkGraphReader => ({
  listIssues: () => Promise.resolve(issues),
  listReady: () => Promise.resolve(ready),
});

interface BoardView {
  goal: string;
  lanes: Record<Lane, { cardId: string }[]>;
}
const allCardIds = (v: BoardView): string[] =>
  Object.values(v.lanes)
    .flat()
    .map((c) => c.cardId)
    .sort();

describe('kanban MCP handlers (KANBAN.2)', () => {
  it('sync maps the WHOLE work-graph onto the board; board then shows every issue in its lane', async () => {
    const k = await mk();
    const r = reader(
      [
        iss('done1', { status: 'closed' }),
        iss('act1', { status: 'in_progress' }),
        iss('back1'),
        iss('blk1'),
      ],
      [iss('back1')],
    );
    expect(JSON.parse(await handleKanbanCreateBoard({ name: 'b', goal: 'ship' }, k))).toEqual({
      ok: true,
      board: 'b',
    });
    expect(JSON.parse(await handleKanbanSync({ board: 'b' }, k, r))).toEqual({
      ok: true,
      synced: 4,
    });
    const view = JSON.parse(await handleKanbanBoard({ board: 'b' }, k, r)) as BoardView;
    expect(view.goal).toBe('ship');
    expect(view.lanes.done.map((c) => c.cardId)).toEqual(['done1']);
    expect(view.lanes.active.map((c) => c.cardId)).toEqual(['act1']);
    expect(view.lanes.backlog.map((c) => c.cardId)).toEqual(['back1']);
    expect(view.lanes.blocked.map((c) => c.cardId)).toEqual(['blk1']);
  });

  it('board is a PURE read — it places nothing (empty before any sync, even with issues present)', async () => {
    const k = await mk();
    const r = reader([iss('a'), iss('b')], [iss('a'), iss('b')]);
    await handleKanbanCreateBoard({ name: 'b', goal: 'g' }, k);
    const view = JSON.parse(await handleKanbanBoard({ board: 'b' }, k, r)) as BoardView;
    expect(allCardIds(view)).toEqual([]); // board did NOT auto-place
  });

  it('sync is idempotent — re-sync adds no duplicate cards', async () => {
    const k = await mk();
    const r = reader([iss('a'), iss('b')], [iss('a'), iss('b')]);
    await handleKanbanCreateBoard({ name: 'b', goal: 'g' }, k);
    await handleKanbanSync({ board: 'b' }, k, r);
    expect(JSON.parse(await handleKanbanSync({ board: 'b' }, k, r))).toEqual({
      ok: true,
      synced: 2,
    });
    const view = JSON.parse(await handleKanbanBoard({ board: 'b' }, k, r)) as BoardView;
    expect(allCardIds(view)).toEqual(['a', 'b']); // each once
  });

  it('place adds a curated card; remove drops it', async () => {
    const k = await mk();
    const r = reader([iss('x'), iss('y')], [iss('x'), iss('y')]);
    await handleKanbanCreateBoard({ name: 'b', goal: 'g' }, k);
    expect(JSON.parse(await handleKanbanPlace({ board: 'b', cardId: 'x' }, k))).toEqual({
      ok: true,
    });
    expect(
      allCardIds(JSON.parse(await handleKanbanBoard({ board: 'b' }, k, r)) as BoardView),
    ).toEqual(['x']);
    expect(JSON.parse(await handleKanbanRemove({ board: 'b', cardId: 'x' }, k))).toEqual({
      ok: true,
    });
    expect(
      allCardIds(JSON.parse(await handleKanbanBoard({ board: 'b' }, k, r)) as BoardView),
    ).toEqual([]);
  });
});
