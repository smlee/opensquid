/** KANBAN.5 — the kanban story schema: buildKanbanStory (deriveLane-grouped, structured) + renderKanbanStory. */
import { describe, expect, it } from 'vitest';

import { buildKanbanStory, renderKanbanStory } from './story.js';
import type { Issue } from '../workgraph/types.js';

const iss = (id: string, over: Partial<Issue> = {}): Issue => ({
  id,
  title: id,
  body: '',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('buildKanbanStory — structured schema, deriveLane-grouped', () => {
  it('groups every issue into its lane, carries the goal, deterministic id-sort', () => {
    const issues = [
      iss('z-back', { title: 'backlog z' }),
      iss('a-back', { title: 'backlog a' }),
      iss('done1', { status: 'closed' }),
      iss('act1', { status: 'in_progress' }),
      iss('wed1', { status: 'in_progress', wedgeReason: 'stuck' }),
      iss('blk1'), // open, not in ready → blocked
    ];
    const ready = new Set(['z-back', 'a-back']);
    const story = buildKanbanStory('ship it', issues, ready);
    expect(story.goal).toBe('ship it');
    expect(story.lanes.done.map((c) => c.id)).toEqual(['done1']);
    expect(story.lanes.active.map((c) => c.id)).toEqual(['act1']);
    expect(story.lanes.wedged.map((c) => c.id)).toEqual(['wed1']);
    expect(story.lanes.blocked.map((c) => c.id)).toEqual(['blk1']);
    expect(story.lanes.backlog.map((c) => c.id)).toEqual(['a-back', 'z-back']); // id-sorted, not input order
    expect(story.lanes.backlog[0]).toEqual({ id: 'a-back', title: 'backlog a', status: 'open' });
  });

  it('empty work-graph → all lanes empty, goal carried', () => {
    const story = buildKanbanStory('g', [], new Set());
    expect(Object.values(story.lanes).every((l) => l.length === 0)).toBe(true);
    expect(story.goal).toBe('g');
  });
});

describe('renderKanbanStory — markdown from the schema', () => {
  it('renders goal + fixed lane order + counts + cards', () => {
    const story = buildKanbanStory(
      'ship it',
      [iss('act1', { status: 'in_progress' }), iss('r1')],
      new Set(['r1']),
    );
    const md = renderKanbanStory(story);
    expect(md).toContain('Goal: ship it');
    expect(md).toContain('**Active** (1)');
    expect(md).toContain('  - `act1` act1');
    expect(md).toContain('**Backlog (ready)** (1)');
    expect(md).toContain('  - `r1` r1');
    // fixed order: Active before Backlog before Done
    expect(md.indexOf('**Active**')).toBeLessThan(md.indexOf('**Backlog (ready)**'));
    expect(md.indexOf('**Backlog (ready)**')).toBeLessThan(md.indexOf('**Done**'));
  });

  it('empty lane → _(none)_, empty goal → _(none set)_', () => {
    const md = renderKanbanStory(buildKanbanStory('', [], new Set()));
    expect(md).toContain('Goal: _(none set)_');
    expect(md).toContain('**Done** (0)\n  _(none)_');
  });
});
