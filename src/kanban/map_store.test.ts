/** KANBAN.1 — the kanban mapping overlay: deterministic order, derived lanes, idempotent place; work-graph untouched. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { Issue } from '../workgraph/types.js';
import {
  deriveLane,
  kanbanMapStore,
  type WorkGraphReader,
  type KanbanMapStore,
} from './map_store.js';

const dirs: string[] = [];
async function mk(): Promise<{ store: KanbanMapStore; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'osq-kanban-'));
  dirs.push(dir);
  const url = `file:${join(dir, 'k.db')}`;
  const store = kanbanMapStore(url);
  await store.init();
  return { store, url };
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

describe('deriveLane — first-match precedence (pure)', () => {
  const ready = new Set(['r']);
  it('closed → done', () => expect(deriveLane(iss('x', { status: 'closed' }), ready)).toBe('done'));
  it('wedgeReason → wedged (precedence over active)', () =>
    expect(deriveLane(iss('x', { status: 'in_progress', wedgeReason: 'why' }), ready)).toBe(
      'wedged',
    ));
  it('in_progress → active', () =>
    expect(deriveLane(iss('x', { status: 'in_progress' }), ready)).toBe('active'));
  it('open + in listReady → backlog', () => expect(deriveLane(iss('r'), ready)).toBe('backlog'));
  it('open + NOT in listReady → blocked (blocked-or-claimed)', () =>
    expect(deriveLane(iss('x'), ready)).toBe('blocked'));
});

describe('KanbanMapStore.board — derived lanes over a stub reader', () => {
  it('groups placed cards into the derived lanes', async () => {
    const { store } = await mk();
    await store.createBoard('b', 'ship it');
    const issues = [
      iss('done1', { status: 'closed' }),
      iss('wed1', { status: 'in_progress', wedgeReason: 'stuck' }),
      iss('act1', { status: 'in_progress' }),
      iss('back1'),
      iss('blk1'),
    ];
    for (const i of issues) await store.place('b', i.id);
    const { goal, lanes } = await store.board('b', reader(issues, [iss('back1')]));
    expect(goal).toBe('ship it');
    expect(lanes.done.map((c) => c.cardId)).toEqual(['done1']);
    expect(lanes.wedged.map((c) => c.cardId)).toEqual(['wed1']);
    expect(lanes.active.map((c) => c.cardId)).toEqual(['act1']);
    expect(lanes.backlog.map((c) => c.cardId)).toEqual(['back1']);
    expect(lanes.blocked.map((c) => c.cardId)).toEqual(['blk1']); // open, not in listReady
  });
});

describe('KanbanMapStore — deterministic order', () => {
  it('orders by (position, card_id), identical across two fresh dbs', async () => {
    const issues = [iss('a'), iss('b'), iss('c')];
    const order = async (): Promise<string[]> => {
      const { store } = await mk();
      await store.createBoard('b', 'g');
      for (const i of issues) await store.place('b', i.id);
      const { lanes } = await store.board('b', reader(issues, issues));
      return lanes.backlog.map((c) => c.cardId);
    };
    expect(await order()).toEqual(['a', 'b', 'c']);
    expect(await order()).toEqual(['a', 'b', 'c']); // reproducible
  });

  it('same position → sorts by card_id (the tiebreak; no serialization needed)', async () => {
    const { store, url } = await mk();
    await store.createBoard('b', 'g');
    // Force a same-position collision via a raw insert (what concurrent place() could produce).
    const raw = createClient({ url });
    await raw.execute({
      sql: 'INSERT INTO kanban_cards (board, card_id, position, added_at) VALUES (?,?,?,?),(?,?,?,?)',
      args: ['b', 'y', 1, 't', 'b', 'x', 1, 't'], // inserted y-before-x, but SAME position 1
    });
    const issues = [iss('x'), iss('y')];
    const { lanes } = await store.board('b', reader(issues, issues));
    expect(lanes.backlog.map((c) => c.cardId)).toEqual(['x', 'y']); // by card_id, not insertion order
  });
});

describe('KanbanMapStore — placement semantics', () => {
  it('place is idempotent (re-place is a no-op)', async () => {
    const { store } = await mk();
    await store.createBoard('b', 'g');
    await store.place('b', 'x');
    await store.place('b', 'x');
    const { lanes } = await store.board('b', reader([iss('x')], [iss('x')]));
    expect(lanes.backlog.map((c) => c.cardId)).toEqual(['x']); // once
  });

  it('a card can be on multiple boards', async () => {
    const { store } = await mk();
    await store.createBoard('b1', 'g');
    await store.createBoard('b2', 'g');
    await store.place('b1', 'x');
    await store.place('b2', 'x');
    const r = reader([iss('x')], [iss('x')]);
    expect((await store.board('b1', r)).lanes.backlog.map((c) => c.cardId)).toEqual(['x']);
    expect((await store.board('b2', r)).lanes.backlog.map((c) => c.cardId)).toEqual(['x']);
  });

  it('a placed card whose work-graph issue is gone → skipped (no throw)', async () => {
    const { store } = await mk();
    await store.createBoard('b', 'g');
    await store.place('b', 'ghost');
    const { lanes } = await store.board('b', reader([], [])); // reader returns no such issue
    expect(Object.values(lanes).flat()).toEqual([]); // skipped, no throw
  });

  it('remove drops the card from the board', async () => {
    const { store } = await mk();
    await store.createBoard('b', 'g');
    await store.place('b', 'x');
    await store.remove('b', 'x');
    const { lanes } = await store.board('b', reader([iss('x')], [iss('x')]));
    expect(Object.values(lanes).flat()).toEqual([]);
  });
});
