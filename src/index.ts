#!/usr/bin/env node
/**
 * OpenSquid — MCP server for AI agent memory with anti-self-grading wedge.
 *
 *     ○ pending  →  △ active  →  □ promoted
 *           ↘             ↘
 *            discarded     superseded
 *
 * v0.1 ships real tool implementations over local-file storage at
 * `~/.opensquid/lessons/{status}/<id>.json`. Forward-compatible
 * with `loop-engine`'s status-as-directory invariant — when the
 * engine integration lands, the storage layer swaps; the wire
 * surface stays.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { checkPromotionGate } from "./gate.js";
import { newLessonId, isValidLessonId } from "./id.js";
import { recall as recallLessons } from "./recall.js";
import { findLesson, listAllLessons, moveLesson, writeLesson } from "./storage.js";
import type { Authorship, Lesson } from "./types.js";

const VERSION = "0.1.0";

const server = new Server(
  { name: "opensquid", version: VERSION },
  { capabilities: { tools: {} } },
);

// ---- Tool catalogue -------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "remember",
      description:
        "Capture a candidate lesson. Enters as ○ pending. Promotion to □ promoted " +
        "requires external evidence per the wedge gate. Pass `authored_by: 'user'` " +
        "when the human explicitly endorses the lesson (engages immunity invariant).",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short summary of what was learned." },
          body: {
            type: "string",
            description: "Full lesson narrative — markdown supported. Min 50 chars to pass the gate.",
          },
          evidence: {
            type: "array",
            description: "Citations — quotes or `mem-xxxxxxxx` references. At least one needed for promotion.",
            items: { type: "string" },
            default: [],
          },
          authored_by: {
            type: "string",
            enum: ["user", "agent"],
            description: "Who authored the lesson. Default 'agent' (LLM-generated).",
            default: "agent",
          },
        },
        required: ["description", "body"],
      },
    },
    {
      name: "recall",
      description:
        "Surface lessons relevant to the current task. Returns up to N matches " +
        "ordered by similarity. Discarded lessons are excluded.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you're trying to do or recall." },
          limit: { type: "number", description: "Max items to return (default 5).", default: 5 },
        },
        required: ["query"],
      },
    },
    {
      name: "promote",
      description:
        "Run the wedge gate. ○/△ → □ promoted on pass, or returns structured Block " +
        "reasons. Checks: body length, evidence presence, thumbs-down ratio, time-floor.",
      inputSchema: {
        type: "object",
        properties: {
          lesson_id: { type: "string", description: "Lesson id (les-xxxxxxxx)." },
        },
        required: ["lesson_id"],
      },
    },
    {
      name: "eliminate",
      description:
        "Discard a lesson (terminal). User-authored lessons immune to engine-initiated " +
        "elimination — set force=true to bypass (only when human explicitly intends).",
      inputSchema: {
        type: "object",
        properties: {
          lesson_id: { type: "string" },
          reason: { type: "string", description: "Why this lesson is being discarded." },
          force: {
            type: "boolean",
            description: "Bypass user-authored immunity. Default false.",
            default: false,
          },
        },
        required: ["lesson_id"],
      },
    },
  ],
}));

// ---- Tool execution -------------------------------------------------

function textResult(payload: unknown): {
  content: { type: "text"; text: string }[];
} {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "remember": {
      const description = String(a.description ?? "").trim();
      const body = String(a.body ?? "").trim();
      const evidence = Array.isArray(a.evidence) ? a.evidence.map(String) : [];
      const authoredBy: Authorship = a.authored_by === "user" ? "user" : "agent";

      if (!description || !body) {
        return textResult({ error: "description and body are required" });
      }
      const now = new Date().toISOString();
      const lesson: Lesson = {
        id: newLessonId(),
        description,
        body,
        evidence,
        status: "pending",
        createdAt: now,
        authoredBy,
        thumbsUp: 0,
        thumbsDown: 0,
      };
      await writeLesson(lesson);
      return textResult({
        ok: true,
        lesson_id: lesson.id,
        status: lesson.status,
        authored_by: lesson.authoredBy,
        next: `Lesson captured as ○ pending. Run 'promote' to send it through the wedge gate (requires evidence + 1h age + ≥50 char body).`,
      });
    }

    case "recall": {
      const query = String(a.query ?? "").trim();
      const limit = typeof a.limit === "number" ? Math.max(1, Math.min(50, a.limit)) : 5;
      if (!query) return textResult({ error: "query is required" });
      const lessons = await listAllLessons();
      const hits = recallLessons(query, lessons, limit);
      return textResult({ query, returned: hits.length, lessons: hits });
    }

    case "promote": {
      const lessonId = String(a.lesson_id ?? "");
      if (!isValidLessonId(lessonId)) {
        return textResult({ error: `invalid lesson id: ${lessonId}` });
      }
      const lesson = await findLesson(lessonId);
      if (!lesson) return textResult({ error: `lesson not found: ${lessonId}` });
      const decision = checkPromotionGate(lesson, new Date());
      if (!decision.promote) {
        return textResult({
          ok: false,
          lesson_id: lessonId,
          gate: "blocked",
          reasons: decision.reasons,
          hint: "Add evidence, expand the body, wait out the time-floor, or address the thumbs-down ratio.",
        });
      }
      const fromStatus = lesson.status;
      lesson.status = "promoted";
      lesson.updatedAt = new Date().toISOString();
      await moveLesson(lesson, fromStatus);
      return textResult({
        ok: true,
        lesson_id: lessonId,
        gate: "passed",
        status: "promoted",
        from: fromStatus,
      });
    }

    case "eliminate": {
      const lessonId = String(a.lesson_id ?? "");
      const reason = a.reason ? String(a.reason) : undefined;
      const force = a.force === true;
      if (!isValidLessonId(lessonId)) {
        return textResult({ error: `invalid lesson id: ${lessonId}` });
      }
      const lesson = await findLesson(lessonId);
      if (!lesson) return textResult({ error: `lesson not found: ${lessonId}` });
      if (!force && lesson.authoredBy === "user") {
        return textResult({
          ok: false,
          lesson_id: lessonId,
          error: "user-authored lesson is eviction-immune",
          hint: "Pass force=true only when the human explicitly intends to discard their own lesson.",
        });
      }
      const fromStatus = lesson.status;
      lesson.status = "discarded";
      lesson.discardedAt = new Date().toISOString();
      lesson.updatedAt = lesson.discardedAt;
      if (reason) lesson.discardReason = reason;
      await moveLesson(lesson, fromStatus);
      return textResult({
        ok: true,
        lesson_id: lessonId,
        status: "discarded",
        from: fromStatus,
        reason,
      });
    }

    default:
      return textResult({ error: `unknown tool: ${name}` });
  }
});

// ---- Bootstrap ------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[opensquid v${VERSION}] ready on stdio`);
