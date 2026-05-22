#!/usr/bin/env node
/**
 * `opensquid-mcp` — MCP server entrypoint over stdio.
 *
 * Exposes the Phase-1 read-only tool set:
 *
 *   list_packs         — currently active packs
 *   list_skills        — skills (optionally scoped to a pack)
 *   inspect_skill      — rules + load conditions + drift policy for one skill
 *   read_state         — read a session state key (functions/state.ts companion)
 *   read_violations    — return session violations.jsonl contents
 *   list_drift_events  — aggregated drift catalog across packs + session (Task 5.4)
 *   recall             — search the configured RAG backend for memory hits (Task T.5)
 *
 * Mutations (write_state, append_log, promote_lesson, …) are intentionally
 * NOT exposed via MCP in Phase 1. Those live behind the hook bindings + rule
 * processes; the MCP surface is read-only inspection so an external client
 * can never bypass the dispatcher. `recall` is still read-only — it only
 * reads from the memory pool, never writes — so it slots cleanly into the
 * existing pattern.
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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { handleInspectSkill } from './tools/inspect-skill.js';
import { handleListDriftEvents } from './tools/list-drift-events.js';
import { handleListPacks } from './tools/list-packs.js';
import { handleListSkills } from './tools/list-skills.js';
import { handleReadState } from './tools/read-state.js';
import { handleReadViolations } from './tools/read-violations.js';
import { handleRecall } from './tools/recall.js';

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
} as const;

type ToolName = keyof typeof ToolHandlers;

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
  const server = new Server(
    { name: 'opensquid', version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: (Object.keys(ToolHandlers) as ToolName[]).map((name) => ({
        name,
        description: descriptions[name],
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
