#!/usr/bin/env node
/**
 * `opensquid-mcp` — MCP server entrypoint over stdio.
 *
 * Exposes the Phase-1 read-only tool set plus G.3's write surface:
 *
 *   list_packs         — currently active packs
 *   list_skills        — skills (optionally scoped to a pack)
 *   inspect_skill      — rules + load conditions + drift policy for one skill
 *   read_state         — read a session state key (functions/state.ts companion)
 *   read_violations    — return session violations.jsonl contents
 *   list_drift_events  — aggregated drift catalog across packs + session (Task 5.4)
 *   recall             — search the configured RAG backend for memory hits (Task T.5)
 *   memorize           — persist a memory (G.3) — direct engine.memory.create
 *   store_lesson       — capture a Stage-1 wedge-gate candidate (G.3)
 *   forget             — delete a memory; user-immune by default (G.3)
 *
 * G.3 introduces the first three WRITE tools as an explicit architectural
 * exception to the T.1.H read-only invariant — see each handler's header for
 * per-tool justification. `lesson.promote` (Stage 2) is intentionally NOT
 * exposed, so the wedge-gate outcome-validation moat cannot be bypassed by
 * an external MCP client.
 *
 * Transport: stdio (StdioServerTransport). stdout is reserved for the
 * JSON-RPC stream — NO `console.log` anywhere in this binary or any module
 * it imports through this code path. Diagnostics must go to `process.stderr`
 * exclusively. The `main().catch` at the bottom writes to stderr and exits
 * non-zero so an unexpected crash is observable, not silent.
 *
 * Args are Zod-parsed BEFORE being handed to a tool handler. A bad-args
 * `CallToolRequest` throws on the protocol level (which the MCP SDK turns
 * into a JSON-RPC error response) rather than running with garbage input.
 *
 * Imports from: @modelcontextprotocol/sdk + mcp/tools/*.
 * Imported by: nothing in src/. Wired as the `opensquid-mcp` bin in
 * package.json.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { wedgeLessonStore, type WedgeLessonStore } from '../rag/wedge/store.js';
import { wedgeLessonsDbUrl, wedgeLessonsDir } from '../rag/wedge/paths.js';
import { createBackend } from '../rag/backend_factory.js';
import { resolveBackendConfig } from '../rag/config.js';
import { OPENSQUID_HOME } from '../runtime/paths.js';
import { workGraphStore } from '../workgraph/store.js';

import type { RagBackend } from '../rag/types.js';

import { anchorProcessToProjectDir } from './anchor.js';
import { handleForget, ForgetSchema, type ForgetArgs } from './tools/forget.js';
import { handleInspectSkill } from './tools/inspect-skill.js';
import { handleListDriftEvents } from './tools/list-drift-events.js';
import { handleListPacks } from './tools/list-packs.js';
import { handleListSkills } from './tools/list-skills.js';
import { handleLogPhase, LogPhaseSchema, type LogPhaseArgs } from './tools/log_phase.js';
import { handleMemorize, MemorizeSchema, type MemorizeArgs } from './tools/memorize.js';
import { handleReadState } from './tools/read-state.js';
import { handleReadViolations } from './tools/read-violations.js';
import { handleRecall } from './tools/recall.js';
import {
  handleStoreLesson,
  StoreLessonSchema,
  type StoreLessonArgs,
} from './tools/store-lesson.js';
import {
  WgAddEdgeSchema,
  WgClaimSchema,
  WgCreateSchema,
  WgIdSchema,
  WgListSchema,
  WgReadySchema,
  WgUpdateSchema,
  handleWgAddEdge,
  handleWgClaim,
  handleWgCreate,
  handleWgEvents,
  handleWgGet,
  handleWgList,
  handleWgReady,
  handleWgUpdate,
} from './tools/workgraph.js';

import type { WorkGraphStore } from '../workgraph/types.js';

/**
 * Lazy wedge lesson-store singleton (retire-Rust RES-3c — store_lesson no longer
 * touches the Rust engine). Constructed + `init()`ed once per MCP-server process;
 * the cached promise amortizes the schema setup across calls.
 */
let wedgeStoreReady: Promise<WedgeLessonStore> | null = null;
function wedgeStore(): Promise<WedgeLessonStore> {
  if (!wedgeStoreReady) {
    const s = wedgeLessonStore({ dbUrl: wedgeLessonsDbUrl(), sourceDir: wedgeLessonsDir() });
    wedgeStoreReady = s.init().then(() => s);
  }
  return wedgeStoreReady;
}

/**
 * Build + init the configured RAG backend for a memory write/delete (retire-Rust write-path
 * cutover). Mirrors recall.ts's seam: engine-present users hit the engine, no-engine users hit
 * libSQL, via resolveBackendConfig. Per-call (cheap — the engine connection is the T.4 singleton;
 * libSQL opens a local handle).
 */
async function ragBackend(): Promise<RagBackend> {
  const backend = createBackend(await resolveBackendConfig());
  await backend.init();
  return backend;
}

/**
 * Lazy work-graph store singleton (T-WORKGRAPH-MCP). Promise-memoized so concurrent first-calls
 * await a single `init()` (one schema creation). Dedicated `~/.opensquid/workgraph.db` + per-op
 * git source under `store/issues`.
 */
let workGraphPromise: Promise<WorkGraphStore> | null = null;
function getWorkGraph(): Promise<WorkGraphStore> {
  workGraphPromise ??= (async () => {
    const store = workGraphStore({
      dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
      sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
    });
    await store.init();
    return store;
  })();
  return workGraphPromise;
}

// Each entry binds an args Zod schema to a handler that already accepts the
// inferred shape. `safeParse` runs against `req.params.arguments` before the
// handler ever sees the request — invalid input becomes a thrown Error which
// the SDK translates into a JSON-RPC error response.
const ToolHandlers = {
  list_packs: {
    schema: z.object({}),
    handle: () => handleListPacks(),
  },
  list_skills: {
    schema: z.object({ pack: z.string().optional() }),
    handle: (args: { pack?: string }) => handleListSkills(args),
  },
  inspect_skill: {
    schema: z.object({ pack: z.string(), skill: z.string() }),
    handle: (args: { pack: string; skill: string }) => handleInspectSkill(args),
  },
  read_state: {
    schema: z.object({ key: z.string() }),
    handle: (args: { key: string }) => handleReadState(args),
  },
  read_violations: {
    schema: z.object({}),
    handle: () => handleReadViolations(),
  },
  list_drift_events: {
    schema: z.object({ packs: z.array(z.string()).optional() }),
    handle: (args: { packs?: string[] }) => handleListDriftEvents(args),
  },
  recall: {
    schema: z.object({
      query: z.string().min(1),
      k: z.number().int().min(1).max(50).optional(),
    }),
    handle: (args: { query: string; k?: number }) => handleRecall(args),
  },
  memorize: {
    schema: MemorizeSchema,
    handle: async (args: MemorizeArgs) =>
      JSON.stringify(await handleMemorize(args, await ragBackend())),
  },
  store_lesson: {
    schema: StoreLessonSchema,
    handle: async (args: StoreLessonArgs) =>
      JSON.stringify(await handleStoreLesson(args, await wedgeStore())),
  },
  forget: {
    schema: ForgetSchema,
    handle: async (args: ForgetArgs) =>
      JSON.stringify(await handleForget(args, await ragBackend())),
  },
  log_phase: {
    schema: LogPhaseSchema,
    handle: (args: LogPhaseArgs) => handleLogPhase(args).then((r) => JSON.stringify(r)),
  },
  workgraph_create_issue: {
    schema: WgCreateSchema,
    handle: async (a: z.infer<typeof WgCreateSchema>) => handleWgCreate(a, await getWorkGraph()),
  },
  workgraph_update_issue: {
    schema: WgUpdateSchema,
    handle: async (a: z.infer<typeof WgUpdateSchema>) => handleWgUpdate(a, await getWorkGraph()),
  },
  workgraph_add_edge: {
    schema: WgAddEdgeSchema,
    handle: async (a: z.infer<typeof WgAddEdgeSchema>) => handleWgAddEdge(a, await getWorkGraph()),
  },
  workgraph_ready: {
    schema: WgReadySchema,
    handle: async (a: z.infer<typeof WgReadySchema>) => handleWgReady(a, await getWorkGraph()),
  },
  workgraph_get: {
    schema: WgIdSchema,
    handle: async (a: z.infer<typeof WgIdSchema>) => handleWgGet(a, await getWorkGraph()),
  },
  workgraph_list: {
    schema: WgListSchema,
    handle: async (a: z.infer<typeof WgListSchema>) => handleWgList(a, await getWorkGraph()),
  },
  workgraph_events: {
    schema: WgIdSchema,
    handle: async (a: z.infer<typeof WgIdSchema>) => handleWgEvents(a, await getWorkGraph()),
  },
  workgraph_claim: {
    schema: WgClaimSchema,
    handle: async (a: z.infer<typeof WgClaimSchema>) => handleWgClaim(a, await getWorkGraph()),
  },
} as const;

type ToolName = keyof typeof ToolHandlers;

// T-MCP-TOOL-ANNOTATIONS: honest MCP behavior hints, emitted in tools/list so
// annotation-aware hosts (codex's requires_mcp_tool_approval is the verified
// consumer) can auto-approve reads and local additive writes while keeping
// destructive tools prompted. CLIENT policy input only — never server-side
// security; the moat stays in the handlers. Lock-step with `ToolHandlers`
// (compile-enforced by Record over ToolName). NO idempotentHint anywhere:
// the work-graph mutations append an op per call (store.ts:111-143), so
// "repeated call has no additional effect" would be dishonest.
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const LOCAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

const toolAnnotations: Record<ToolName, ToolAnnotations> = {
  list_packs: READ_ONLY,
  list_skills: READ_ONLY,
  inspect_skill: READ_ONLY,
  read_state: READ_ONLY,
  read_violations: READ_ONLY,
  list_drift_events: READ_ONLY,
  recall: READ_ONLY,
  workgraph_ready: READ_ONLY,
  workgraph_get: READ_ONLY,
  workgraph_list: READ_ONLY,
  workgraph_events: READ_ONLY,
  memorize: LOCAL_WRITE,
  store_lesson: LOCAL_WRITE,
  log_phase: LOCAL_WRITE,
  workgraph_create_issue: LOCAL_WRITE,
  workgraph_update_issue: LOCAL_WRITE,
  workgraph_add_edge: LOCAL_WRITE,
  workgraph_claim: LOCAL_WRITE,
  // The one genuinely destructive tool: deletes a memory (tools/forget.ts).
  forget: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

// Centralized so the description copy lives next to (not threaded through)
// the handler map. Keys must stay in lock-step with `ToolHandlers`.
const descriptions: Record<ToolName, string> = {
  list_packs: 'List loaded packs',
  list_skills: 'List skills (optionally scoped to a pack)',
  inspect_skill: 'Show rules, load conditions, drift policy of a skill',
  read_state: 'Read a session state key',
  read_violations: 'Read the session violations.jsonl',
  list_drift_events: 'List drift events aggregated across packs + session',
  recall: 'Find memories relevant to a query. Returns up to k ranked results.',
  memorize:
    'Persist a memory. authored_by="user" (default) makes it eviction-immune. Scope defaults to user.',
  store_lesson:
    'Capture a candidate lesson for Stage 1 (user validates classification). ' +
    'Use this for in-session corrections; do NOT call promote_lesson — automation handles Stage 2.',
  forget: 'Delete a memory by id. User-authored memories require force: true (eviction immunity).',
  log_phase:
    'Log a completed workflow phase (pre_research|learn|code|test|audit|post_research|fix) ' +
    'for the active task. Writes the engine ledger + the gate state; the commit gate unblocks once all 7 are logged.',
  workgraph_create_issue:
    'Create a work-graph issue {title, body?}. Returns the issue (with its hash id). The work-graph is the agent’s structured, dependency-aware task store.',
  workgraph_update_issue:
    'Update a work-graph issue {id, status?(open|in_progress|closed), title?, body?}. Returns the updated issue.',
  workgraph_add_edge:
    'Add a dependency edge {from, to, type(blocks|parent-child|discovered-from|related)} between two issues (re-typing the same pair updates the type).',
  workgraph_ready:
    'List READY issues: open issues with no un-closed `blocks` blocker, oldest-first — the work to do next.',
  workgraph_get: 'Get one work-graph issue by id (or null).',
  workgraph_list: 'List work-graph issues, optionally filtered by status {status?}.',
  workgraph_events: 'List the append-only op-log (history) for an issue by id.',
  workgraph_claim:
    'Atomically claim a work-graph issue {id, ttlSec?} for exclusive work (exactly-once). Stamps the calling harness as audience. Returns {won, expiresAt}; won:false means another runner holds it. An expired claim is reclaimable.',
};

/**
 * Read the published package version at runtime. T.1.H fix: the prior
 * hardcoded `'0.5.9'` drifted ~100 patch bumps behind reality. Resolve
 * `package.json` relative to this module's URL so the lookup works in
 * both `dist/mcp/server.js` (built) and `src/mcp/server.ts` (vitest)
 * layouts — package.json sits at the package root, two levels up.
 */
function readPackageVersion(): string {
  try {
    // This file lives at <root>/{dist,src}/mcp/server.{js,ts}; package.json
    // sits at <root>/package.json — two levels up regardless of layout.
    const pkgJsonPath = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  anchorProcessToProjectDir();
  const server = new Server(
    { name: 'opensquid', version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: (Object.keys(ToolHandlers) as ToolName[]).map((name) => ({
        name,
        description: descriptions[name],
        annotations: toolAnnotations[name],
        inputSchema: zodToJsonSchema(ToolHandlers[name].schema) as {
          type: 'object';
          [k: string]: unknown;
        },
      })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name as ToolName;
    const handler = ToolHandlers[name];
    if (!handler) throw new Error(`Unknown tool: ${String(req.params.name)}`);
    const parsed = handler.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid args for ${name}: ${parsed.error.message}`);
    }
    // The cast lands at the call-site because each branch of `ToolHandlers`
    // carries its own arg shape; the discriminated lookup is statically safe
    // but TS cannot prove that across the union.
    const text = await (handler.handle as (a: unknown) => Promise<string>)(parsed.data);
    return { content: [{ type: 'text' as const, text }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid-mcp crash: ${String(e)}\n`);
  process.exit(1);
});
