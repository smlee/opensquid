/** KANBAN.1/.4 — the kanban mapping overlay: derived lanes, deterministic order, idempotent place,
 *  per-project scoping, data-preserving migration; work-graph untouched. */
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

const P = 'p1'; // a project namespace for the single-project tests
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
    await store.createBoard(P, 'b', 'ship it');
    const issues = [
      iss('done1', { status: 'closed' }),
      iss('wed1', { status: 'in_progress', wedgeReason: 'stuck' }),
      iss('act1', { status: 'in_progress' }),
      iss('back1'),
      iss('blk1'),
    ];
    for (const i of issues) await store.place(P, 'b', i.id);
    const { goal, lanes } = await store.board(P, 'b', reader(issues, [iss('back1')]));
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
      await store.createBoard(P, 'b', 'g');
      for (const i of issues) await store.place(P, 'b', i.id);
      const { lanes } = await store.board(P, 'b', reader(issues, issues));
      return lanes.backlog.map((c) => c.cardId);
    };
    expect(await order()).toEqual(['a', 'b', 'c']);
    expect(await order()).toEqual(['a', 'b', 'c']); // reproducible
  });

  it('same position → sorts by card_id (the tiebreak; no serialization needed)', async () => {
    const { store, url } = await mk();
    await store.createBoard(P, 'b', 'g');
    // Force a same-position collision via a raw insert (what concurrent place() could produce).
    const raw = createClient({ url });
    await raw.execute({
      sql: 'INSERT INTO kanban_cards (project, board, card_id, position, added_at) VALUES (?,?,?,?,?),(?,?,?,?,?)',
      args: [P, 'b', 'y', 1, 't', P, 'b', 'x', 1, 't'], // inserted y-before-x, SAME position 1
    });
    const issues = [iss('x'), iss('y')];
    const { lanes } = await store.board(P, 'b', reader(issues, issues));
    expect(lanes.backlog.map((c) => c.cardId)).toEqual(['x', 'y']); // by card_id, not insertion order
  });
});

describe('KanbanMapStore — placement semantics', () => {
  it('place is idempotent (re-place is a no-op)', async () => {
    const { store } = await mk();
    await store.createBoard(P, 'b', 'g');
    await store.place(P, 'b', 'x');
    await store.place(P, 'b', 'x');
    const { lanes } = await store.board(P, 'b', reader([iss('x')], [iss('x')]));
    expect(lanes.backlog.map((c) => c.cardId)).toEqual(['x']); // once
  });

  it('a card can be on multiple boards', async () => {
    const { store } = await mk();
    await store.createBoard(P, 'b1', 'g');
    await store.createBoard(P, 'b2', 'g');
    await store.place(P, 'b1', 'x');
    await store.place(P, 'b2', 'x');
    const r = reader([iss('x')], [iss('x')]);
    expect((await store.board(P, 'b1', r)).lanes.backlog.map((c) => c.cardId)).toEqual(['x']);
    expect((await store.board(P, 'b2', r)).lanes.backlog.map((c) => c.cardId)).toEqual(['x']);
  });

  it('a placed card whose work-graph issue is gone → skipped (no throw)', async () => {
    const { store } = await mk();
    await store.createBoard(P, 'b', 'g');
    await store.place(P, 'b', 'ghost');
    const { lanes } = await store.board(P, 'b', reader([], [])); // reader returns no such issue
    expect(Object.values(lanes).flat()).toEqual([]); // skipped, no throw
  });

  it('remove drops the card from the board', async () => {
    const { store } = await mk();
    await store.createBoard(P, 'b', 'g');
    await store.place(P, 'b', 'x');
    await store.remove(P, 'b', 'x');
    const { lanes } = await store.board(P, 'b', reader([iss('x')], [iss('x')]));
    expect(Object.values(lanes).flat()).toEqual([]);
  });
});

describe('KanbanMapStore — per-project scoping (KANBAN.4)', () => {
  it('same board NAME in two projects stays isolated (no cross-project collision)', async () => {
    const { store } = await mk();
    await store.createBoard('p1', 'b', 'g1');
    await store.createBoard('p2', 'b', 'g2');
    await store.place('p1', 'b', 'x');
    await store.place('p2', 'b', 'y');
    const r = reader([iss('x'), iss('y')], [iss('x'), iss('y')]);
    const b1 = await store.board('p1', 'b', r);
    const b2 = await store.board('p2', 'b', r);
    expect(b1.goal).toBe('g1');
    expect(b2.goal).toBe('g2');
    expect(b1.lanes.backlog.map((c) => c.cardId)).toEqual(['x']); // only p1's card
    expect(b2.lanes.backlog.map((c) => c.cardId)).toEqual(['y']); // only p2's card
  });

  it('position is scoped per (project, board) — each project starts at 1', async () => {
    const { store } = await mk();
    await store.createBoard('p1', 'b', 'g');
    await store.createBoard('p2', 'b', 'g');
    await store.place('p1', 'b', 'x'); // p1 position 1
    await store.place('p2', 'b', 'y'); // p2 position 1 (NOT 2 — scoped)
    const r = reader([iss('x'), iss('y')], [iss('x'), iss('y')]);
    expect((await store.board('p1', 'b', r)).lanes.backlog[0]!.position).toBe(1);
    expect((await store.board('p2', 'b', r)).lanes.backlog[0]!.position).toBe(1);
  });
});

describe('KanbanMapStore — data-preserving migration (KANBAN.4)', () => {
  it('a pre-project (old-schema) db is migrated, preserving curated rows under project="legacy-global"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osq-kanban-mig-'));
    dirs.push(dir);
    const url = `file:${join(dir, 'k.db')}`;
    // Seed the OLD pre-KANBAN.4 schema + a curated board with a specific card position.
    const raw = createClient({ url });
    await raw.execute(
      'CREATE TABLE kanban_boards (name TEXT PRIMARY KEY, goal TEXT NOT NULL, created_at TEXT NOT NULL)',
    );
    await raw.execute(
      'CREATE TABLE kanban_cards (board TEXT NOT NULL, card_id TEXT NOT NULL, position INTEGER NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (board, card_id))',
    );
    await raw.execute({
      sql: 'INSERT INTO kanban_boards (name, goal, created_at) VALUES (?, ?, ?)',
      args: ['old', 'legacy goal', 't'],
    });
    await raw.execute({
      sql: 'INSERT INTO kanban_cards (board, card_id, position, added_at) VALUES (?, ?, ?, ?)',
      args: ['old', 'card7', 7, 't'], // a curated, non-regenerable position
    });

    const store = kanbanMapStore(url);
    await store.init(); // runs migrateAddProject

    // The curated row survives under 'legacy-global' with its position intact.
    const r = reader([iss('card7')], [iss('card7')]);
    const board = await store.board('legacy-global', 'old', r);
    expect(board.goal).toBe('legacy goal');
    expect(board.lanes.backlog.map((c) => c.cardId)).toEqual(['card7']);
    expect(board.lanes.backlog[0]!.position).toBe(7); // preserved, not reset
    // The new scoped schema works for fresh writes.
    await store.place('p1', 'b', 'z');
    expect(
      (await store.board('p1', 'b', reader([iss('z')], [iss('z')]))).lanes.backlog,
    ).toHaveLength(1);
  });

  it('init is idempotent — re-init preserves a project-scoped board', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osq-kanban-idem-'));
    dirs.push(dir);
    const url = `file:${join(dir, 'k.db')}`;
    const s1 = kanbanMapStore(url);
    await s1.init();
    await s1.createBoard('p1', 'b', 'g');
    await s1.place('p1', 'b', 'x');
    // A second store over the same db re-runs init() (the hasProject guard skips the copy).
    const s2 = kanbanMapStore(url);
    await s2.init();
    const { lanes } = await s2.board('p1', 'b', reader([iss('x')], [iss('x')]));
    expect(lanes.backlog.map((c) => c.cardId)).toEqual(['x']); // survived re-init
  });
});
