#!/usr/bin/env node
/**
 * OpenSquid — MCP server for AI agent memory with the anti-self-grading wedge.
 *
 *     ○ pending  →  △ active  →  □ promoted
 *           ↘             ↘
 *            discarded     superseded
 *
 * v0.2 is a thin RPC client over `loop-engine serve`. The engine
 * owns all the real logic (wedge gate, storage, lifecycle); opensquid
 * is the MCP↔engine bridge. The TS reimplementation v0.1.0 used is
 * gone — engine binary is the source of truth.
 *
 * Engine binary discovery: `OPENSQUID_ENGINE_BIN` env var, else the
 * local cargo-release build at
 * `/Users/slee/projects/loop/engine/target/release/loop-engine`.
 * v1.0 distribution will bundle per-platform binaries via npm
 * `optionalDependencies` (esbuild/swc pattern) so end users don't
 * need Rust.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  OpenSquidEngine,
  RpcError,
  type MemoryOrigin,
  type MemoryScope,
  type MemoryScopeFilter,
} from "./engine-client.js";
import { detectOrigin } from "./origin.js";
import {
  DEFAULT_MIN_SIMILARITY,
  filterBySimilarity,
  mergeRrf,
  type LessonHit,
  type MemoryHit,
} from "./recall.js";
import { defaultMemorizeScopeAsync, defaultRecallScopeFilterAsync } from "./scope.js";
import { CodexActivationCache, extractCodexId } from "./codex/activate.js";
import { appendPromotedLessonToClaudeMd } from "./claude-md.js";
import { classifyUtterance } from "./utterance/classifier.js";

const VERSION = "0.4.0";

// ---- CLI subcommand dispatch ---------------------------------------
// When invoked as `npx opensquid <subcommand> [...flags]`, route to the
// CLI module and exit. With no args (the MCP-host startup path), fall
// through to the stdio server setup below.
//
// Subcommand layout:
//   opensquid install|uninstall|doctor            → CLAUDE.md installer
//   opensquid codex install|list|remove|doctor|export → codex management
//   opensquid export                              → entire-system tar.gz export
//   opensquid import <path>                       → restore from export
const subcommand = process.argv[2];
if (subcommand === "export") {
  const { exportSystem, SystemExportError } = await import("./system-export.js");
  let output: string | undefined;
  let force = false;
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if ((a === "--output" || a === "-o") && process.argv[i + 1]) {
      output = process.argv[++i];
    } else if (a === "--force") {
      force = true;
    }
  }
  try {
    const result = await exportSystem({ output, force });
    console.log(`[opensquid export] wrote ${result.output} (${result.size_bytes} bytes)`);
    console.log(`  restore via:  opensquid import ${result.output}`);
    process.exit(0);
  } catch (e) {
    if (e instanceof SystemExportError) {
      console.error(`[opensquid export] error: ${e.message}`);
      if (e.hint) console.error(`  hint: ${e.hint}`);
      process.exit(1);
    }
    console.error(`[opensquid export] unexpected error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
if (subcommand === "import") {
  const { importSystem, SystemExportError } = await import("./system-export.js");
  const input = process.argv[3];
  if (!input || input.startsWith("-")) {
    console.error("usage: opensquid import <archive.tar.gz> [--merge|--replace]");
    process.exit(2);
  }
  let mode: "merge" | "replace" = "merge";
  for (let i = 4; i < process.argv.length; i++) {
    if (process.argv[i] === "--merge") mode = "merge";
    else if (process.argv[i] === "--replace") mode = "replace";
  }
  try {
    const result = await importSystem({ input, mode });
    console.log(
      `[opensquid import] restored ${result.input} → ${result.data_root} (mode: ${result.mode})`,
    );
    process.exit(0);
  } catch (e) {
    if (e instanceof SystemExportError) {
      console.error(`[opensquid import] error: ${e.message}`);
      if (e.hint) console.error(`  hint: ${e.hint}`);
      process.exit(1);
    }
    console.error(`[opensquid import] unexpected error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
if (subcommand === "install" || subcommand === "uninstall" || subcommand === "doctor") {
  const { runCli } = await import("./cli.js");
  try {
    await runCli(subcommand, process.argv.slice(3));
    process.exit(0);
  } catch (e) {
    console.error(`[opensquid ${subcommand}] error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
if (subcommand === "codex") {
  const codexCmd = process.argv[3];
  if (
    codexCmd !== "install" &&
    codexCmd !== "list" &&
    codexCmd !== "remove" &&
    codexCmd !== "doctor" &&
    codexCmd !== "export"
  ) {
    console.error("usage: opensquid codex install|list|remove|doctor|export [<args>...]");
    process.exit(2);
  }
  const { runCodexCli } = await import("./codex/cli.js");
  try {
    await runCodexCli(codexCmd, process.argv.slice(4));
    process.exit(0);
  } catch (e) {
    console.error(`[opensquid codex ${codexCmd}] error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
if (subcommand === "project") {
  const projectCmd = process.argv[3];
  if (
    projectCmd !== "init" &&
    projectCmd !== "info" &&
    projectCmd !== "list" &&
    projectCmd !== "prune"
  ) {
    console.error("usage: opensquid project init|info|list|prune [<args>...]");
    process.exit(2);
  }
  const { runProjectCli } = await import("./project-cli.js");
  try {
    await runProjectCli(projectCmd, process.argv.slice(4));
    process.exit(0);
  } catch (e) {
    console.error(`[opensquid project ${projectCmd}] error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
if (subcommand === "engine") {
  const engineCmd = process.argv[3];
  if (engineCmd !== "doctor" && engineCmd !== "set-path" && engineCmd !== "forget") {
    console.error("usage: opensquid engine doctor|set-path|forget [<args>...]");
    process.exit(2);
  }
  const { runEngineCli } = await import("./engine-cli.js");
  try {
    await runEngineCli(engineCmd, process.argv.slice(4));
    process.exit(0);
  } catch (e) {
    console.error(`[opensquid engine ${engineCmd}] error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
if (subcommand === "hook") {
  const hookCmd = process.argv[3];
  if (hookCmd === "pre-tool-use") {
    const { runPreToolUseHook } = await import("./hooks/pre-tool-use.js");
    await runPreToolUseHook();
    process.exit(0);
  }
  if (hookCmd === "stop") {
    const { runStopHook } = await import("./hooks/stop.js");
    await runStopHook();
    process.exit(0);
  }
  if (hookCmd === "user-prompt-submit") {
    const { runUserPromptSubmitHook } = await import("./hooks/user-prompt-submit.js");
    await runUserPromptSubmitHook();
    process.exit(0);
  }
  if (hookCmd === "session-end") {
    const { runSessionEndHook } = await import("./hooks/session-end.js");
    await runSessionEndHook();
    process.exit(0);
  }
  console.error("usage: opensquid hook pre-tool-use|stop|user-prompt-submit|session-end");
  process.exit(2);
}
if (subcommand === "hooks") {
  const hooksCmd = process.argv[3];
  if (hooksCmd !== "install" && hooksCmd !== "uninstall" && hooksCmd !== "doctor") {
    console.error("usage: opensquid hooks install|uninstall|doctor");
    process.exit(2);
  }
  const { runHooksCli } = await import("./hooks-cli.js");
  try {
    await runHooksCli(hooksCmd, process.argv.slice(4));
    process.exit(0);
  } catch (e) {
    console.error(`[opensquid hooks ${hooksCmd}] error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

const engine = new OpenSquidEngine();

const server = new Server({ name: "opensquid", version: VERSION }, { capabilities: { tools: {} } });

// ---- Tool catalogue ------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "remember",
      description:
        "Capture a candidate lesson via the loop-engine wedge gate. Enters as ○ pending. " +
        "Promotion to □ promoted requires external evidence + 24h age + applied-count threshold + " +
        "matching signal sources (the real gate, not a TS reimpl). Pass `authored_by: 'user'` " +
        "when the human explicitly endorses the lesson (engages eviction-immunity invariant).",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short summary of what was learned." },
          body: {
            type: "string",
            description: "Full lesson narrative — markdown supported.",
          },
          evidence: {
            type: "array",
            description:
              "Citations — free-text quotes or `mem-xxxxxxxx` memory references. Needed for promotion.",
            items: { type: "string" },
            default: [],
          },
          authored_by: {
            type: "string",
            enum: ["user", "agent"],
            description: "Who authored the lesson. Default 'agent'.",
            default: "agent",
          },
        },
        required: ["description", "body"],
      },
    },
    {
      name: "memorize",
      description:
        "Store a raw memory the agent encountered — observations, snippets, things-to-remember " +
        "that aren't wedge-gated claims. Memories are embedded via Qwen3-Embedding-4B and " +
        "surfaced by semantic similarity via `recall`. Use `remember` instead when the agent " +
        "is making a claim that should pass the promotion gate. " +
        "v0.3.1: auto-detects project scope from CWD (git repo basename) unless `scope` is given.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short summary of what to remember." },
          content: {
            type: "string",
            description: "Full content — observation, snippet, raw text.",
          },
          authored_by: {
            type: "string",
            enum: ["user", "agent"],
            description: "Who originated this memory. Default 'agent'.",
            default: "agent",
          },
          scope: {
            description:
              'Optional scope tag. Shape: `"user"`, `"global"`, `{team:id}`, `{skill:id}`, ' +
              "or `{project:id}`. Default: auto-detected project (if inside a git repo) else `user`.",
          },
        },
        required: ["description", "content"],
      },
    },
    {
      name: "recall",
      description:
        "Surface relevant lessons + memories for the current task. Fans out text-match (lessons) " +
        "+ semantic vector search (memories via Qwen3-Embedding-4B) in parallel; returns separate " +
        "per-source lists AND a single RRF-merged ranked list (`merged`). Discarded lessons excluded. " +
        "v0.3.1: `include_body: true` returns full memory bodies (no truncation); `scope_filter` " +
        "restricts results by MemoryScope. v0.4: `min_similarity` (default 0.5) drops weak hits — " +
        '`merged: []` means "nothing relevant" (decision-makable). Items appearing in BOTH lists ' +
        "are boosted by RRF.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you're trying to do or recall." },
          limit: {
            type: "number",
            description: "Max items per source to return (default 5).",
            default: 5,
          },
          include_body: {
            type: "boolean",
            description: "Return full memory bodies instead of 240-char previews. Default false.",
            default: false,
          },
          scope_filter: {
            description:
              'Optional scope filter. Shape: `{kind:"exact",scope:<MemoryScope>}`, ' +
              '`{kind:"kind",kind_name:"project"|"team"|...}`, or ' +
              '`{kind:"any_of",scopes:[...]}`. Default: any_of([user, <detected-project>]).',
          },
          min_similarity: {
            type: "number",
            description:
              "Drop hits with similarity below this threshold BEFORE merging. Range 0-1. " +
              'Default 0.5 — produces "no relevant context" signals when nothing\'s a real match. ' +
              "Pass 0 to reproduce v0.3.1 behavior (return top-K regardless).",
            default: 0.5,
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_memory",
      description:
        "Fetch a single memory by id with the FULL body (no truncation) and its scope. " +
        "Companion to `recall` — once a preview hit looks load-bearing but truncated, " +
        "call `get_memory` to surface the complete content for re-anchoring.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory id (mem-xxxxxxxx)." },
        },
        required: ["memory_id"],
      },
    },
    {
      name: "update_memory",
      description:
        "Mutate an existing memory's description, content, and/or scope. " +
        "Identity (id, created_at, citation count, origin) is always preserved. " +
        "Re-embeds on content change; description-only or scope-only edits are cheap " +
        "(no re-embedding). At least one of description/content/scope must be supplied.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory id (mem-xxxxxxxx)." },
          description: { type: "string", description: "New short summary. Omit to keep existing." },
          content: {
            type: "string",
            description: "New full content. Triggers re-embedding when different.",
          },
          scope: {
            description:
              'New scope tag. Shape: `"user"`, `"global"`, `{team:id}`, `{skill:id}`, `{project:id}`. Omit to keep existing.',
          },
        },
        required: ["memory_id"],
      },
    },
    {
      name: "forget",
      description:
        "Delete a memory. User-immunity-respecting by default: memories cited by " +
        "user-authored lessons are protected. Pass `force: true` ONLY when the user " +
        "explicitly intends to retire a memory they themselves cite (the wedge invariant).",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory id (mem-xxxxxxxx)." },
          force: {
            type: "boolean",
            description: "Bypass user-immunity. Default false.",
            default: false,
          },
        },
        required: ["memory_id"],
      },
    },
    {
      name: "promote",
      description:
        "Run the wedge gate. ○/△ → □ promoted on pass, or returns structured BlockReason. " +
        "The gate enforces: ≥24h age, applied-count threshold, external-signal-sources, " +
        "thumbs ratio, causal-narrative presence, evidence-refs non-empty. No self-grading. " +
        "v0.4 #106.1: on successful promote, the lesson's `description` (if passed) is " +
        "appended to the CLAUDE.md `opensquid-rules` sub-block so future sessions see " +
        "it in their system prompt with no recall lag.",
      inputSchema: {
        type: "object",
        properties: {
          lesson_id: { type: "string", description: "Lesson id (les-xxxxxxxx)." },
          description: {
            type: "string",
            description:
              "Optional one-line rule summary to append to CLAUDE.md's auto-managed " +
              "rules block on successful promote. Recommend: '<trigger> — <action>'. " +
              "When omitted, the CLAUDE.md update is silently skipped.",
          },
        },
        required: ["lesson_id"],
      },
    },
    {
      name: "eliminate",
      description:
        "Discard a lesson (terminal). User-authored lessons immune to engine-initiated " +
        "elimination — pass force=true only when the human explicitly intends to retire their own lesson.",
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
    {
      name: "classify_utterance",
      description:
        "v0.4 #111: classify a user utterance via the pattern catalog. Returns " +
        '{ kind: "fact" | "preference" | "correction" | "workflow_lock" | "none", ' +
        "suggested_action, matched: <pattern-ids>, confidence }. Pure regex catalog — " +
        "no LLM call. Call this when the agent receives a substantive user message " +
        "(per the classify-and-act block in CLAUDE.md), then act on suggested_action " +
        "by calling memorize / remember / update_memory yourself.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The user utterance to classify.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "pending_candidates",
      description:
        "v0.4 #111 companion: list lessons currently in `pending` state (lesson " +
        "candidates awaiting promote/discard decision). Returns the candidates' " +
        "ids + descriptions + body previews so the operator can review and decide. " +
        "Uses engine.recall internally and filters by status; no new engine RPC.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max candidates to return. Default 10.",
            default: 10,
          },
        },
      },
    },
    {
      name: "list_lessons",
      description:
        "v0.5: paginated list of lessons across the four non-discarded status " +
        "dirs (pending / active / promoted / superseded). Order is deterministic " +
        "(status, then id ascending) so paginated callers get stable ranking. " +
        "Default limit 50, capped at 500. Pass `statuses` to filter — e.g. " +
        '`["promoted"]` to enumerate just the promoted-rule tier. Returns full ' +
        "frontmatter summary per row including pack_id / external_id provenance.",
      inputSchema: {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            items: { type: "string", enum: ["pending", "active", "promoted", "superseded"] },
            description:
              "Status dirs to scan. Default: all four non-discarded. Pass a subset to filter.",
          },
          limit: {
            type: "number",
            description: "Page size. Default 50, capped at 500.",
            default: 50,
          },
          offset: {
            type: "number",
            description: "Items to skip from the deterministic-sorted list. Default 0.",
            default: 0,
          },
        },
      },
    },
    {
      name: "capture_feedback",
      description:
        "v0.5: record a thumbs-up or thumbs-down on a lesson. Adds to the " +
        "lesson's `external_signal_sources` (the wedge gate's signal-diversity " +
        "input — multiple distinct signals are required for promotion). " +
        "Idempotent on `source_signal_id`. The wedge invariant still applies: " +
        "this records evidence; it does NOT auto-promote. Use `promote` " +
        "explicitly when you want to run the gate.",
      inputSchema: {
        type: "object",
        properties: {
          lesson_id: { type: "string", description: "Engine lesson id (les-xxxxxxxx)." },
          polarity: {
            type: "string",
            enum: ["thumbs_up", "thumbs_down"],
            description: "Direction of the feedback signal.",
          },
          source_signal_id: {
            type: "string",
            description:
              "Optional opaque id deduplicating repeat signals from the same source. " +
              "If omitted, the engine mints a synthetic id (the call still records).",
          },
        },
        required: ["lesson_id", "polarity"],
      },
    },
    {
      name: "list_memories",
      description:
        "v0.5: paginated memory enumeration. Filter-optional via scope_filter " +
        "(same wire shape as recall). Default limit 50, capped at 500. Order " +
        "is deterministic (id ascending — memory ids are ULID-shaped so this " +
        "is roughly chronological). Returns frontmatter rows but NOT body — " +
        "call get_memory(id) for the full content of any single hit.",
      inputSchema: {
        type: "object",
        properties: {
          scope_filter: {
            description:
              'Optional scope filter. Shape: `{kind:"exact",scope:<MemoryScope>}`, ' +
              '`{kind:"kind",kind_name:"project"|"team"|...}`, or ' +
              '`{kind:"any_of",scopes:[...]}`. Default: no filter (all scopes).',
          },
          limit: {
            type: "number",
            description: "Page size. Default 50, capped at 500.",
            default: 50,
          },
          offset: {
            type: "number",
            description: "Items to skip from the deterministic-sorted list. Default 0.",
            default: 0,
          },
        },
      },
    },
    {
      name: "supersede",
      description:
        "v0.5: point an old lesson at a new replacement. Old lesson moves to " +
        "`superseded/`, the new lesson is unaffected. The causal chain is " +
        "preserved via `superseded_by` so historical reasoning is recoverable. " +
        "User-authored lessons are protected unless `force: true` (the user " +
        "must be explicit about retiring their own work). Engine rejects " +
        "self-references and cycles.",
      inputSchema: {
        type: "object",
        properties: {
          old_lesson_id: { type: "string", description: "Lesson being superseded." },
          new_lesson_id: { type: "string", description: "Replacement lesson." },
          force: {
            type: "boolean",
            description: "Bypass user-authored immunity. Default false.",
            default: false,
          },
        },
        required: ["old_lesson_id", "new_lesson_id"],
      },
    },
  ],
}));

// ---- Tool execution ------------------------------------------------

function textResult(payload: unknown): {
  content: { type: "text"; text: string }[];
} {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * Validate the MCP-provided `scope` argument against the `MemoryScope`
 * wire shape. Returns `null` when the input is missing or undefined
 * (caller falls back to a default); throws a typed `Error` for shapes
 * that look like an attempt to pass a scope but don't match the
 * engine's serde format. Surface-level checks only — the engine still
 * does the authoritative parse.
 */
function coerceMemoryScope(value: unknown): MemoryScope | null {
  if (value === undefined || value === null) return null;
  if (value === "user" || value === "global") return value;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.project === "string") return { project: o.project };
    if (typeof o.team === "string") return { team: o.team };
    if (typeof o.skill === "string") return { skill: o.skill };
  }
  throw new Error(
    `invalid scope: expected "user" | "global" | {team|skill|project: string}, got ${JSON.stringify(value)}`,
  );
}

/**
 * Validate the MCP-provided `scope_filter` argument against the
 * `MemoryScopeFilter` wire shape. Returns `null` when missing; throws
 * on malformed input. Mirrors `coerceMemoryScope` discipline so the
 * MCP layer surfaces precise errors instead of opaque RPC failures.
 */
function coerceMemoryScopeFilter(value: unknown): MemoryScopeFilter | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") {
    throw new Error(`invalid scope_filter: expected object, got ${typeof value}`);
  }
  const o = value as Record<string, unknown>;
  if (o.kind === "exact") {
    const scope = coerceMemoryScope(o.scope);
    if (!scope) throw new Error("scope_filter.exact requires `scope`");
    return { kind: "exact", scope };
  }
  if (o.kind === "any_of") {
    if (!Array.isArray(o.scopes)) {
      throw new Error("scope_filter.any_of requires `scopes: MemoryScope[]`");
    }
    const scopes = o.scopes.map((s) => {
      const c = coerceMemoryScope(s);
      if (!c) throw new Error("scope_filter.any_of: null/undefined scope entry");
      return c;
    });
    return { kind: "any_of", scopes };
  }
  if (o.kind === "kind") {
    const k = o.kind_name;
    if (k !== "user" && k !== "team" && k !== "skill" && k !== "project" && k !== "global") {
      throw new Error(`scope_filter.kind: unknown kind_name "${String(k)}"`);
    }
    return { kind: "kind", kind_name: k };
  }
  throw new Error(`invalid scope_filter: unknown kind "${String(o.kind)}"`);
}

function rpcErrorResult(
  method: string,
  e: unknown,
): {
  content: { type: "text"; text: string }[];
} {
  if (e instanceof RpcError) {
    return textResult({
      ok: false,
      method,
      error: { code: e.code, message: e.message, data: e.data },
    });
  }
  const message = e instanceof Error ? e.message : String(e);
  return textResult({ ok: false, method, error: { code: -1, message } });
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "remember": {
        const result = await engine.createLesson({
          description: String(a.description ?? "").trim(),
          body: String(a.body ?? "").trim(),
          evidence: Array.isArray(a.evidence) ? a.evidence.map(String) : [],
          authored_by: a.authored_by === "user" ? "user" : "agent",
        });
        return textResult({
          ok: true,
          lesson_id: result.id,
          status: result.status,
          authored_by: result.authored_by,
          created_at: result.created_at,
          next: "Lesson captured as ○ pending. The wedge gate enforces 24h time-floor + applied-count + signal-sources before promotion.",
        });
      }

      case "memorize": {
        // Auto-detect project scope unless the caller passed one.
        // Caller-provided `scope` is validated by `coerceMemoryScope`
        // before reaching the engine — invalid shapes get a clear
        // MCP-level error (not the engine's serde message).
        const scope = coerceMemoryScope(a.scope) ?? (await defaultMemorizeScopeAsync());
        // v0.4 Phase 1: attach provenance unless the caller overrode
        // it. Hosts that don't need provenance can pass `origin: null`
        // (or any non-object) to suppress.
        const origin: MemoryOrigin =
          (a.origin && typeof a.origin === "object" ? (a.origin as MemoryOrigin) : null) ??
          detectOrigin();
        const result = await engine.createMemory({
          description: String(a.description ?? "").trim(),
          content: String(a.content ?? "").trim(),
          authored_by: a.authored_by === "user" ? "user" : "agent",
          scope,
          origin,
        });
        return textResult({
          ok: true,
          memory_id: result.id,
          description: result.description,
          created_at: result.created_at,
          scope: result.scope,
          origin: result.origin,
          next: "Memory stored + embedded. Surface via `recall` with any related query (semantic search).",
        });
      }

      case "recall": {
        const query = String(a.query ?? "").trim();
        const limit = typeof a.limit === "number" ? Math.max(1, Math.min(50, a.limit)) : 5;
        const include_body = a.include_body === true;
        const scope_filter =
          coerceMemoryScopeFilter(a.scope_filter) ?? (await defaultRecallScopeFilterAsync());
        // v0.4: similarity threshold. Defaults to 0.5 (decision-makable
        // signal); pass 0 explicitly to reproduce v0.3.1 behavior.
        const min_similarity =
          typeof a.min_similarity === "number"
            ? Math.max(0, Math.min(1, a.min_similarity))
            : DEFAULT_MIN_SIMILARITY;
        if (!query) return textResult({ error: "query is required" });
        // Fan out: text-match lessons + hybrid memories in parallel.
        // v0.5: memory search runs in `hybrid` mode by default — the
        // engine runs both semantic and text-match sub-searches and
        // RRF-merges by id. Solves the v0.4 false-negative on
        // proper-noun queries that scored below the semantic
        // threshold despite a literal description match (see
        // docs/v0.5-hybrid-recall-design.md). Callers can override
        // by setting `mode` on a future tool surface; default stays
        // hybrid because that's the strictly-better behavior.
        //
        // Threshold semantics: opensquid passes `min_similarity`
        // down to the engine, which applies it to RAW per-source
        // scores BEFORE the RRF merge. RRF scores are in a
        // different range and can't share the threshold meaningfully.
        // Lesson hits still get post-filtered here because
        // engine.recall doesn't accept a threshold param (lesson
        // scores are single-source so the post-filter is correct).
        const [lessonResult, memoryResult] = await Promise.all([
          engine.recall({ query, limit }),
          engine
            .searchMemory({
              query,
              limit,
              include_body,
              scope_filter,
              mode: "hybrid",
              min_similarity,
            })
            .catch((e) => {
              // Memory search needs Ollama running; surface the error
              // inline rather than failing the whole recall.
              console.error(
                `[opensquid] memory.search failed: ${e instanceof Error ? e.message : e}`,
              );
              return { query, returned: 0, results: [] };
            }),
        ]);
        // Filter lessons (single-source text-match scores) by
        // min_similarity; trust the engine on memories (already
        // filtered pre-RRF). Then RRF-merge lessons + memories at
        // the opensquid layer — the same memory id can't appear in
        // both lists so the dual-source boost here doesn't fire
        // (that's exercised inside engine's hybrid_search instead).
        const lessonsAboveThreshold = filterBySimilarity(
          lessonResult.results as LessonHit[],
          min_similarity,
        );
        // v0.4: filter Pack-authored lessons by codex activation.
        // Lessons with `(codex:X)` suffix only surface when codex X's
        // `detected_by` matches the current cwd. Lessons WITHOUT the
        // suffix (pre-codex direct lesson.create) are always kept.
        const activationCache = new CodexActivationCache(process.cwd());
        const lessonsKept: LessonHit[] = [];
        for (const lesson of lessonsAboveThreshold) {
          const codexId = extractCodexId(lesson.description);
          if (codexId === null || (await activationCache.isActive(codexId))) {
            lessonsKept.push(lesson);
          }
        }
        const memoriesKept = memoryResult.results as MemoryHit[];
        const merged = mergeRrf(lessonsKept, memoriesKept);
        return textResult({
          query,
          scope_filter,
          include_body,
          min_similarity,
          merged,
          lessons: {
            returned: lessonsKept.length,
            results: lessonsKept,
          },
          memories: {
            returned: memoriesKept.length,
            results: memoriesKept,
          },
        });
      }

      case "get_memory": {
        const id = String(a.memory_id ?? "").trim();
        if (!id) return textResult({ error: "memory_id is required" });
        const result = await engine.getMemory({ id });
        return textResult({
          ok: true,
          ...result,
        });
      }

      case "update_memory": {
        const id = String(a.memory_id ?? "").trim();
        if (!id) return textResult({ error: "memory_id is required" });
        const args: {
          id: string;
          description?: string;
          content?: string;
          scope?: MemoryScope;
        } = { id };
        if (typeof a.description === "string") args.description = a.description;
        if (typeof a.content === "string") args.content = a.content;
        if (a.scope !== undefined) {
          const coerced = coerceMemoryScope(a.scope);
          if (coerced) args.scope = coerced;
        }
        if (
          args.description === undefined &&
          args.content === undefined &&
          args.scope === undefined
        ) {
          return textResult({
            error: "at least one of description, content, scope must be supplied",
          });
        }
        const result = await engine.updateMemory(args);
        return textResult(result);
      }

      case "forget": {
        const id = String(a.memory_id ?? "").trim();
        if (!id) return textResult({ error: "memory_id is required" });
        const force = a.force === true;
        const result = await engine.deleteMemory({ id, force });
        return textResult(result);
      }

      case "promote": {
        const id = String(a.lesson_id ?? "");
        const result = await engine.promote({ id });
        // v0.4 #106.1: surface promoted lesson into CLAUDE.md's
        // auto-managed rules sub-block so future sessions see the
        // rule in their system prompt without needing recall.
        //
        // Non-fatal — CLAUDE.md is downstream display, not the source
        // of truth. Failures are logged but don't block the promote.
        try {
          // Best-effort fetch of the just-promoted lesson's description.
          // engine.promote currently returns minimal fields; we use the
          // id + a placeholder description. A richer description requires
          // a separate engine.getLesson RPC (deferred to #106.2).
          const description = String(a.description ?? "");
          if (description) {
            await appendPromotedLessonToClaudeMd({
              id,
              description,
              promoted_at: new Date().toISOString(),
            });
          }
        } catch (e) {
          console.error(
            `[opensquid] CLAUDE.md rules-block update failed (non-fatal): ${e instanceof Error ? e.message : e}`,
          );
        }
        return textResult(result);
      }

      case "eliminate": {
        const id = String(a.lesson_id ?? "");
        const reason = a.reason ? String(a.reason) : undefined;
        const force = a.force === true;
        const result = await engine.discard({ id, reason, force });
        return textResult(result);
      }

      case "classify_utterance": {
        const text = String(a.text ?? "");
        const result = classifyUtterance(text);
        return textResult(result);
      }

      case "pending_candidates": {
        // v0.5: switched to engine.listLessons({statuses: ["pending"]}) —
        // the v0.4 implementation faked it with engine.recall + client
        // filter, which was bound by recall's similarity ranking and
        // miscounted candidates whose description didn't match the
        // wildcard query strongly enough.
        const limit = typeof a.limit === "number" ? Math.max(1, Math.min(50, a.limit)) : 10;
        const page = await engine.listLessons({ statuses: ["pending"], limit });
        return textResult({
          total: page.total,
          returned: page.returned,
          candidates: page.results.map((r) => ({
            id: r.id,
            description: r.description,
            authored_by: r.authored_by,
          })),
        });
      }

      case "list_lessons": {
        const statuses = Array.isArray(a.statuses) ? (a.statuses as string[]) : undefined;
        const limit = typeof a.limit === "number" ? a.limit : undefined;
        const offset = typeof a.offset === "number" ? a.offset : undefined;
        const result = await engine.listLessons({ statuses, limit, offset });
        return textResult(result);
      }

      case "list_memories": {
        const limit = typeof a.limit === "number" ? a.limit : undefined;
        const offset = typeof a.offset === "number" ? a.offset : undefined;
        const scopeFilter =
          a.scope_filter && typeof a.scope_filter === "object"
            ? (a.scope_filter as MemoryScopeFilter)
            : undefined;
        const result = await engine.listMemories({
          scope_filter: scopeFilter,
          limit,
          offset,
        });
        return textResult(result);
      }

      case "capture_feedback": {
        const lessonId = typeof a.lesson_id === "string" ? a.lesson_id : "";
        const polarity = typeof a.polarity === "string" ? a.polarity : "";
        if (!lessonId || (polarity !== "thumbs_up" && polarity !== "thumbs_down")) {
          return textResult({
            error: "lesson_id (string) + polarity ('thumbs_up' | 'thumbs_down') required",
          });
        }
        const result = await engine.captureFeedback({
          id: lessonId,
          polarity: polarity as "thumbs_up" | "thumbs_down",
          source_signal_id: typeof a.source_signal_id === "string" ? a.source_signal_id : undefined,
        });
        return textResult(result);
      }

      case "supersede": {
        const oldId = typeof a.old_lesson_id === "string" ? a.old_lesson_id : "";
        const newId = typeof a.new_lesson_id === "string" ? a.new_lesson_id : "";
        if (!oldId || !newId) {
          return textResult({
            error: "old_lesson_id and new_lesson_id (both strings) required",
          });
        }
        const result = await engine.supersedeLesson({
          old_id: oldId,
          new_id: newId,
          force: a.force === true,
        });
        return textResult(result);
      }

      default:
        return textResult({ error: `unknown tool: ${name}` });
    }
  } catch (e) {
    return rpcErrorResult(name, e);
  }
});

// ---- Lifecycle -----------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// Clean engine shutdown when MCP transport closes.
process.on("SIGTERM", () => {
  engine.shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  engine.shutdown();
  process.exit(0);
});

console.error(`[opensquid v${VERSION}] ready on stdio`);
