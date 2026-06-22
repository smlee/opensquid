/**
 * Kanban MCP tools (KANBAN.2) — make the kanban overlay (`src/kanban/map_store.ts`, KANBAN.1) usable by the
 * agent: create boards, place/remove cards, SYNC a board from the work-graph, and READ the derived lane view.
 *
 * Mirrors `mcp/tools/workgraph.ts`: each handler validates via its Zod schema (run by the server before
 * dispatch) and returns a JSON string. The mapping is SPLIT for honest auth (pre-research §E): `kanban_sync`
 * is a WRITE (it places every work-graph issue — the idempotent place-loop), `kanban_board` is a PURE READ
 * (it calls only `board()`, which SELECTs + derives, no mutation). The work-graph is UNTOUCHED — the overlay
 * reads it through the injected `WorkGraphReader` only.
 *
 * Imports from: zod, ../../kanban/map_store.js (the KANBAN.1 store types).
 * Imported by: src/mcp/server.ts (the ToolHandlers map).
 */
import { z } from 'zod';

import type { KanbanMapStore, WorkGraphReader } from '../../kanban/map_store.js';

export const KanbanCreateBoardSchema = z
  .object({ name: z.string().min(1), goal: z.string().min(1) })
  .strict();
export const KanbanPlaceSchema = z
  .object({ board: z.string().min(1), cardId: z.string().min(1) })
  .strict();
export const KanbanRemoveSchema = z
  .object({ board: z.string().min(1), cardId: z.string().min(1) })
  .strict();
export const KanbanSyncSchema = z.object({ board: z.string().min(1) }).strict();
export const KanbanBoardSchema = z.object({ board: z.string().min(1) }).strict();

export const handleKanbanCreateBoard = async (
  a: z.infer<typeof KanbanCreateBoardSchema>,
  project: string,
  k: KanbanMapStore,
): Promise<string> => {
  await k.createBoard(project, a.name, a.goal);
  return JSON.stringify({ ok: true, board: a.name });
};

export const handleKanbanPlace = async (
  a: z.infer<typeof KanbanPlaceSchema>,
  project: string,
  k: KanbanMapStore,
): Promise<string> => {
  await k.place(project, a.board, a.cardId);
  return JSON.stringify({ ok: true });
};

export const handleKanbanRemove = async (
  a: z.infer<typeof KanbanRemoveSchema>,
  project: string,
  k: KanbanMapStore,
): Promise<string> => {
  await k.remove(project, a.board, a.cardId);
  return JSON.stringify({ ok: true });
};

/** SYNC (write): map the WHOLE work-graph onto the board — place every issue. `place` is idempotent
 *  (`ON CONFLICT(project,board,card_id) DO NOTHING`, KANBAN.1/.4), so re-sync adds only new issues. */
export const handleKanbanSync = async (
  a: z.infer<typeof KanbanSyncSchema>,
  project: string,
  k: KanbanMapStore,
  reader: WorkGraphReader,
): Promise<string> => {
  const issues = await reader.listIssues();
  for (const issue of issues) await k.place(project, a.board, issue.id);
  return JSON.stringify({ ok: true, synced: issues.length });
};

/** BOARD (pure read): the derived lane view — `board()` only SELECTs placed cards + derives lanes (no
 *  mutation, KANBAN.1 `map_store.ts`), so this tool is honestly READ_ONLY. */
export const handleKanbanBoard = async (
  a: z.infer<typeof KanbanBoardSchema>,
  project: string,
  k: KanbanMapStore,
  reader: WorkGraphReader,
): Promise<string> => JSON.stringify(await k.board(project, a.board, reader));
