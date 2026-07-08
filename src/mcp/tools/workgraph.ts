/**
 * Work-graph MCP tools (T-WORKGRAPH-MCP slice 1e) — make the event-sourced work-graph
 * (src/workgraph/store.ts) usable by the agent: create/update/link issues + query
 * ready/get/list/events. Each handler validates via its Zod schema (run by the server before
 * dispatch) and returns a JSON string, mirroring the existing write-tool shape (e.g. log_phase).
 * The work-graph is operational state, outside the lesson-promotion wedge.
 *
 * Imports from: zod, ../../workgraph/types.js.
 * Imported by: src/mcp/server.ts (the ToolHandlers map).
 */
import { z } from 'zod';

import { claimAudience } from '../../workgraph/audience.js';

import type { WorkGraphFacade } from '../../workgraph/types.js';

const Status = z.enum(['open', 'in_progress', 'closed', 'archived']); // WGL.1 — + 'archived'
const EdgeT = z.enum(['blocks', 'parent-child', 'discovered-from', 'related']);

export const WgCreateSchema = z.object({ title: z.string().min(1), body: z.string().optional() });
export const WgUpdateSchema = z.object({
  id: z.string().min(1),
  status: Status.optional(),
  title: z.string().optional(),
  body: z.string().optional(),
});
export const WgAddEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: EdgeT,
});
export const WgIdSchema = z.object({ id: z.string().min(1) });
export const WgListSchema = z.object({ status: Status.optional() });
export const WgReadySchema = z.object({});
export const WgClaimSchema = z.object({
  id: z.string().min(1),
  ttlSec: z.number().int().positive().default(1800),
});

export const handleWgCreate = async (
  a: z.infer<typeof WgCreateSchema>,
  s: WorkGraphFacade,
): Promise<string> =>
  JSON.stringify(
    await s.createIssue({ title: a.title, ...(a.body === undefined ? {} : { body: a.body }) }),
  );

export const handleWgUpdate = async (
  a: z.infer<typeof WgUpdateSchema>,
  s: WorkGraphFacade,
): Promise<string> =>
  JSON.stringify(
    await s.updateIssue(a.id, {
      ...(a.status === undefined ? {} : { status: a.status }),
      ...(a.title === undefined ? {} : { title: a.title }),
      ...(a.body === undefined ? {} : { body: a.body }),
    }),
  );

export const handleWgAddEdge = async (
  a: z.infer<typeof WgAddEdgeSchema>,
  s: WorkGraphFacade,
): Promise<string> => {
  await s.addEdge(a.from, a.to, a.type);
  return JSON.stringify({ ok: true });
};

// WGL.7 — the archive op's MCP surface: soft-archive (with an optional reason) + its reverse. Thin handlers
// (validate → facade call → JSON), exactly like handleWgAddEdge; the archive semantics live in the store (WGL.1).
export const WgArchiveSchema = z.object({ id: z.string().min(1), reason: z.string().optional() });
export const WgUnarchiveSchema = z.object({ id: z.string().min(1) });

export const handleWgArchive = async (
  a: z.infer<typeof WgArchiveSchema>,
  s: WorkGraphFacade,
): Promise<string> => {
  await s.archiveIssue(a.id, a.reason);
  return JSON.stringify({ ok: true, id: a.id, status: 'archived' });
};

export const handleWgUnarchive = async (
  a: z.infer<typeof WgUnarchiveSchema>,
  s: WorkGraphFacade,
): Promise<string> => {
  await s.unarchiveIssue(a.id);
  return JSON.stringify({ ok: true, id: a.id, status: 'open' });
};

export const handleWgReady = async (
  _a: z.infer<typeof WgReadySchema>,
  s: WorkGraphFacade,
): Promise<string> => JSON.stringify(await s.listReady());

export const handleWgGet = async (
  a: z.infer<typeof WgIdSchema>,
  s: WorkGraphFacade,
): Promise<string> => JSON.stringify(await s.getIssue(a.id));

export const handleWgList = async (
  a: z.infer<typeof WgListSchema>,
  s: WorkGraphFacade,
): Promise<string> =>
  JSON.stringify(await s.listIssues(a.status === undefined ? undefined : { status: a.status }));

export const handleWgEvents = async (
  a: z.infer<typeof WgIdSchema>,
  s: WorkGraphFacade,
): Promise<string> => JSON.stringify(await s.listEvents(a.id));

// GR.1 — atomic claim. Audience is stamped from the trusted env markers, NEVER from caller args.
export const handleWgClaim = async (
  a: z.infer<typeof WgClaimSchema>,
  s: WorkGraphFacade,
): Promise<string> => JSON.stringify(await s.claimIssue(a.id, claimAudience(), a.ttlSec));
