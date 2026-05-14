#!/usr/bin/env node
/**
 * OpenSquid — MCP server for AI agent memory with anti-self-grading wedge.
 *
 * Powered by loop-engine (https://github.com/MindcraftorAI/loop-engine).
 *
 * The wedge: every lesson that graduates to "promoted" must pass an
 * external-evidence gate. No self-grading. The agent doesn't decide
 * what it learned — OpenSquid does.
 *
 *     ○ pending  →  △ active  →  □ promoted
 *           ↘             ↘
 *            discarded     superseded
 *
 * v0.0.1 ships the MCP skeleton. Engine integration lands as
 * loop-engine wires up its public crate surface.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const VERSION = "0.0.1";

const server = new Server(
  {
    name: "opensquid",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

/**
 * Tool catalogue. Each tool maps to a loop-engine capability surface.
 * The names are deliberately playful — they're the public face users
 * type into Claude / Cursor / other MCP hosts.
 *
 * Internal-engine ops the user never sees: gate evaluation, citation-
 * counter mutation, compression sweeps. OpenSquid surfaces the user-
 * intent verbs.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "remember",
      description:
        "Capture a candidate lesson for the agent. Lesson enters as `pending`. " +
        "Promotion to `active`/`promoted` requires external evidence per the wedge gate.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "What was learned." },
          body: { type: "string", description: "Full lesson narrative." },
          evidence: {
            type: "array",
            description: "Citations or memory references that ground the lesson.",
            items: { type: "string" },
          },
        },
        required: ["description", "body"],
      },
    },
    {
      name: "recall",
      description:
        "Surface lessons + memories relevant to the current task. " +
        "Returns the manifest section the host LLM should treat as context.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you're trying to do." },
          limit: { type: "number", description: "Max items to return (default 5)." },
        },
        required: ["query"],
      },
    },
    {
      name: "promote",
      description:
        "Move a pending lesson through the wedge gate. Engine evaluates external " +
        "evidence + tampered-age + thumbs signals. Returns `promoted` or `blocked` with reasons.",
      inputSchema: {
        type: "object",
        properties: {
          lesson_id: { type: "string" },
        },
        required: ["lesson_id"],
      },
    },
    {
      name: "eliminate",
      description:
        "Discard a lesson (terminal state). User-authored lessons are immune to " +
        "engine-initiated elimination — explicit user intent required.",
      inputSchema: {
        type: "object",
        properties: {
          lesson_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["lesson_id"],
      },
    },
  ],
}));

/**
 * Tool execution. Stub implementations until loop-engine wires up
 * its public surface for cross-process consumption.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  return {
    content: [
      {
        type: "text",
        text:
          `[opensquid v${VERSION}] tool '${name}' invoked. ` +
          `Engine integration pending; this is the v0.0.1 scaffold. ` +
          `Pass the gate, or get eliminated.`,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[opensquid v${VERSION}] ready on stdio`);
