/**
 * KANBAN.5 — the kanban "story" SCHEMA + pure build/render (the user's "model the kanban story schema… as a
 * checkpoint"). `buildKanbanStory` groups the work-graph by `deriveLane` (KANBAN.1) into a structured
 * `KanbanStory` ({goal, lanes}); `renderKanbanStory` renders it to markdown for the auto-handoff doc. The
 * `kanban_story` MCP tool returns the STRUCTURED story as JSON (matching `kanban_board`'s read contract); the
 * handoff renders it. Rebuilt live from append-only truth each call/handoff → cannot go stale (unlike the
 * hand-maintained MEMORY.md resume block).
 *
 * Imports from: ./map_store.js (deriveLane/Lane), ../workgraph/types.js (Issue type only).
 * Imported by: runtime/handoff/render.ts, mcp/tools/kanban.ts.
 */
import { deriveLane, type Lane } from './map_store.js';

import type { Issue } from '../workgraph/types.js';

export interface StoryCard {
  id: string;
  title: string;
  status: string;
}

export interface KanbanStory {
  goal: string;
  lanes: Record<Lane, StoryCard[]>;
}

const LANE_ORDER: readonly Lane[] = ['active', 'backlog', 'blocked', 'wedged', 'done'];
const LANE_TITLE: Record<Lane, string> = {
  active: 'Active',
  backlog: 'Backlog (ready)',
  blocked: 'Blocked',
  wedged: 'Wedged',
  done: 'Done',
};

/** PURE: group issues by `deriveLane` into the structured story (deterministic id-sort per lane). */
export function buildKanbanStory(
  goal: string,
  issues: Issue[],
  readyIds: ReadonlySet<string>,
): KanbanStory {
  const lanes: Record<Lane, StoryCard[]> = {
    active: [],
    backlog: [],
    blocked: [],
    wedged: [],
    done: [],
  };
  for (const i of issues) {
    lanes[deriveLane(i, readyIds)].push({ id: i.id, title: i.title, status: i.status });
  }
  for (const lane of LANE_ORDER) lanes[lane].sort((a, b) => a.id.localeCompare(b.id)); // deterministic
  return { goal, lanes };
}

/** PURE: render a `KanbanStory` to markdown — fixed lane order, per-lane counts, empty→`_(none)_`. */
export function renderKanbanStory(story: KanbanStory): string {
  const body = LANE_ORDER.map((lane) => {
    const items = story.lanes[lane].map((c) => `  - \`${c.id}\` ${c.title}`).join('\n');
    return `**${LANE_TITLE[lane]}** (${String(story.lanes[lane].length)})\n${items || '  _(none)_'}`;
  }).join('\n\n');
  return `Goal: ${story.goal || '_(none set)_'}\n\n${body}`;
}
