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
if (subcommand === "chat-daemon") {
  const sub = process.argv[3] ?? "status";
  const { runChatDaemonCli } = await import("./chat/daemon/cli.js");
  try {
    const code = await runChatDaemonCli(sub, process.argv.slice(4));
    process.exit(code);
  } catch (e) {
    console.error(`[chat-daemon ${sub}] error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
if (subcommand === "chat-daemon-worker") {
  // Internal entrypoint — invoked by lifecycle.startDaemon's spawn.
  // Never returns (parks on stdin); signal handlers drive shutdown.
  const { runChatDaemonWorker } = await import("./chat/daemon/cli.js");
  await runChatDaemonWorker();
  // unreachable
  process.exit(0);
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

// ---- Chat gateway (lazy) -------------------------------------------
// Initialized on first chat_* MCP tool call so non-chat sessions don't
// pay the import / connection cost. Cached across the MCP session.

let chatGatewayPromise: Promise<{
  gateway: import("./chat/gateway.js").ChatGateway;
  config: import("./chat/config.js").ChatConnectionsConfig;
  issues: Array<{ platform: string; field: string; problem: string }>;
}> | null = null;

async function ensureChatGatewayWithMeta(): Promise<{
  gateway: import("./chat/gateway.js").ChatGateway;
  config: import("./chat/config.js").ChatConnectionsConfig;
  issues: Array<{ platform: string; field: string; problem: string }>;
}> {
  if (!chatGatewayPromise) {
    chatGatewayPromise = (async () => {
      const { buildChatGateway } = await import("./chat/factory.js");
      const { loadChatConfig } = await import("./chat/config.js");
      const config = await loadChatConfig();
      const built = await buildChatGateway({ config });
      await built.gateway.start();
      return { gateway: built.gateway, config, issues: built.issues };
    })();
  }
  return chatGatewayPromise;
}

async function ensureChatGateway(): Promise<import("./chat/gateway.js").ChatGateway> {
  return (await ensureChatGatewayWithMeta()).gateway;
}

/**
 * Derive a stable session id for the MCP server's own process. Used as
 * the default `session_id` for `log_phase` when the caller doesn't
 * supply one. Format mirrors the engine's `MemoryOrigin.session_id`
 * convention: short hex derived from process pid + start time.
 */
let cachedSessionId: string | null = null;
function currentSessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  // Path-safe per the engine's [A-Za-z0-9_-]{1,128} validator.
  const pid = process.pid;
  const startMs = Math.floor(Date.now() / 1000);
  cachedSessionId = `mcp-${pid}-${startMs.toString(36)}`;
  return cachedSessionId;
}

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
      name: "manifest",
      description:
        "v0.5: central RAG-style assembly — returns active lessons (deterministic-sorted, " +
        "gate-annotated, applied_count bumped) + optional memory recall in one shot. " +
        "Use this to get 'what rules apply right now' for the current task. The " +
        "preferred entrypoint for a host like Hermes that wants the agent's full " +
        "system context payload in a single call instead of stitching together " +
        "list_lessons + recall.",
      inputSchema: {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            items: {
              type: "string",
              enum: ["pending", "active", "promoted", "discarded", "superseded"],
            },
            description: 'Lesson statuses to include. Default ["active"].',
          },
          lesson_limit: {
            type: "number",
            description: "Max lessons to return after sorting. Default 5.",
            default: 5,
          },
          body_preview_len: {
            type: "number",
            description: "Char count for each lesson's body preview. Default 200.",
            default: 200,
          },
          annotate_with_gate: {
            type: "boolean",
            description: "Attach the wedge-gate decision per lesson. Default true.",
            default: true,
          },
          record_applied: {
            type: "boolean",
            description:
              "Bump applied_count + last_applied_at on each surfaced lesson. Default true.",
            default: true,
          },
          memory_query: {
            type: "string",
            description:
              "Text query for the memory section. When present, the engine runs vector " +
              "search via the configured embedder and populates `memories`. Omit to skip.",
          },
          memory_limit: {
            type: "number",
            description: "Max memories to return when memory_query is set. Default 5.",
            default: 5,
          },
          memory_scope_filter: {
            description:
              "Optional scope filter for the memory section. Same wire shape as recall: " +
              '`{kind:"exact",scope:<MemoryScope>}`, `{kind:"kind",kind_name:"project"|...}`, ' +
              'or `{kind:"any_of",scopes:[...]}`.',
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
    {
      name: "chat_send",
      description:
        "Send a text message to a configured chat channel (v0.7). Channel id format: " +
        "`<platform>:<native_id>` — e.g. `telegram:8075471258`, `discord:1234567890`, " +
        "`slack:C012345`. The platform must be configured in " +
        "~/.opensquid/config.json `chat_connections` block. All three adapters (Telegram, " +
        "Discord, Slack) are live as of v0.7c — they activate when their config block is " +
        "present.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel id, format `<platform>:<native_id>`.",
          },
          text: { type: "string", description: "Message body — text only in v0.7." },
          reply_to: {
            type: "string",
            description: "Optional source message id to thread under (best-effort per platform).",
          },
        },
        required: ["channel", "text"],
      },
    },
    {
      name: "chat_list_channels",
      description:
        "List currently active chat platforms and any pre-configured channel allowlists. " +
        "Returns `{ active_platforms: [...], allowlists: { platform: [chat_id_or_user_id...] }, " +
        "issues: [...] }`. Empty platforms array = no chat connections configured yet.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "chat_set_project_channel",
      description:
        "v0.7.1: declare the active project's outbound chat channel + inbound chat_ids for a " +
        "platform. Writes ~/.opensquid/projects/<uuid>/chat-routing.json. The chat-daemon picks " +
        "the change up within ~30s (or restart `opensquid chat-daemon` to apply immediately). " +
        "Subsequent `chat_send` calls with channel='project:<platform>' auto-resolve to this " +
        "channel; inbound messages from listed chat_ids land in this project's inbox.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["telegram", "discord", "slack"],
            description: "Which platform's routing to write.",
          },
          report_channel: {
            type: "string",
            description:
              "Outbound default channel id (`<platform>:<native_id>`), e.g. `telegram:-1001234567890`.",
          },
          inbound_chat_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Native chat/channel ids whose inbound messages should route to this project's inbox.",
          },
          report_topic_id: {
            type: "number",
            description:
              "v0.7.2 Telegram only: forum topic id (`message_thread_id`) within the report_channel supergroup. When set, outbound `chat_send` with `channel:'project:telegram'` posts to this topic.",
          },
          inbound_topic_ids: {
            type: "array",
            items: { type: "number" },
            description:
              "v0.7.2 Telegram only: when set, only inbound messages with one of these message_thread_id values route to this project. Empty/unset = accept all topics from the listed inbound_chat_ids.",
          },
        },
        required: ["platform"],
      },
    },
    {
      name: "chat_create_topic",
      description:
        "v0.7.2 Telegram only: create a new forum topic inside a supergroup (the bot must be admin with 'Manage Topics' permission and the group must have Topics enabled). When `project: true` (default), the new topic_id is automatically written to the active project's chat-routing.json as `report_topic_id`. Returns `{ message_thread_id, name }`.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description:
              "Supergroup chat_id where the topic will be created (e.g. `-1001234567890`).",
          },
          name: { type: "string", description: "Topic name (visible in Telegram UI)." },
          icon_color: {
            type: "number",
            description:
              "Optional icon color code (one of: 7322096, 16766590, 13338331, 9367192, 16749490, 16478047).",
          },
          icon_custom_emoji_id: {
            type: "string",
            description: "Optional custom emoji file id (premium feature).",
          },
          project: {
            type: "boolean",
            description:
              "If true (default), write the new topic_id to the active project's chat-routing.json as report_topic_id. Set false to just return the id without writing.",
          },
        },
        required: ["chat_id", "name"],
      },
    },
    {
      name: "chat_poll_inbox",
      description:
        "v0.7.1: read recent inbound chat messages from the active project's inbox. Inbox is " +
        "populated by the chat-daemon as messages arrive on any configured platform. Returns " +
        "`{ messages: [...], scanned_platforms: [...] }`. Each message carries id, platform, " +
        "channel, sender, sender_id, text, received_at, enqueued_at, mentions_bot.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["telegram", "discord", "slack"],
            description: "Restrict to this platform; omit to read all platforms' inboxes.",
          },
          limit: {
            type: "number",
            description: "Max messages to return. Default 20.",
          },
          since: {
            type: "string",
            description:
              "ISO 8601 timestamp; return only messages enqueued strictly AFTER this time.",
          },
        },
      },
    },
    {
      name: "chat_daemon_status",
      description:
        "v0.7.1: report whether the chat-daemon is running and which platforms it has active. " +
        "Returns `{ running: bool, pid?, version?, active_platforms?, uptime_ms? }`. When " +
        "`running: false`, the daemon may auto-spawn on the next MCP server startup if any " +
        "chat_connections are configured.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "log_phase",
      description:
        "Record a workflow phase completion in the loop-engine phase ledger (v0.6.1). " +
        "Used by the agent to mark phases as they complete during a task — pre_research, " +
        "learn, code, test, audit, post_research, fix. The PreToolUse hook gates `git commit` " +
        "on the active task having `audit` + `post_research` logged. Idempotent: re-logging " +
        "the same phase returns `newly_recorded: false`. `task_id` should be the active " +
        "Claude Code task id (the numeric id from `TaskCreate` / `TodoWrite`). `session_id` " +
        "defaults to the MCP session's claude_code session id when omitted.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Claude Code task id (matches the id from TodoWrite items).",
          },
          phase: {
            type: "string",
            enum: ["pre_research", "learn", "code", "test", "audit", "post_research", "fix"],
            description: "Which phase is being marked complete.",
          },
          note: {
            type: "string",
            description: "Optional free-text note (1-2 sentences). Max 16 KB.",
          },
          session_id: {
            type: "string",
            description: "Optional. Override the auto-detected session id. Useful for testing.",
          },
        },
        required: ["task_id", "phase"],
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

      case "manifest": {
        const statuses = Array.isArray(a.statuses)
          ? (a.statuses as Array<"pending" | "active" | "promoted" | "discarded" | "superseded">)
          : undefined;
        const scopeFilter =
          a.memory_scope_filter && typeof a.memory_scope_filter === "object"
            ? (a.memory_scope_filter as MemoryScopeFilter)
            : undefined;
        const result = await engine.assembleManifest({
          statuses,
          lesson_limit: typeof a.lesson_limit === "number" ? a.lesson_limit : undefined,
          body_preview_len: typeof a.body_preview_len === "number" ? a.body_preview_len : undefined,
          annotate_with_gate:
            typeof a.annotate_with_gate === "boolean" ? a.annotate_with_gate : undefined,
          record_applied: typeof a.record_applied === "boolean" ? a.record_applied : undefined,
          memory_query: typeof a.memory_query === "string" ? a.memory_query : undefined,
          memory_limit: typeof a.memory_limit === "number" ? a.memory_limit : undefined,
          memory_scope_filter: scopeFilter,
        });
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

      case "chat_send": {
        let channel = typeof a.channel === "string" ? a.channel.trim() : "";
        const text = typeof a.text === "string" ? a.text : "";
        if (!channel || !text) {
          return textResult({ error: "channel + text (both strings) required" });
        }
        const replyTo = typeof a.reply_to === "string" ? a.reply_to : undefined;
        // v0.7.1 Phase E: `project:<platform>` magic value resolves to
        // the active project's chat-routing.json report_channel for
        // that platform. Lets agents send "to my chat" without having
        // to know the chat_id literally.
        // v0.7.2: also resolve report_topic_id (Telegram forum topics)
        // and thread it through as the outbound threadId so the message
        // lands in the right topic within the supergroup.
        let resolvedThreadId: string | undefined;
        if (channel.startsWith("project:")) {
          const platform = channel.slice("project:".length) as "telegram" | "discord" | "slack";
          const { resolveActiveProjectUuid } = await import("./chat/daemon/active-project.js");
          const { loadProjectChatRouting } = await import("./chat/daemon/routing.js");
          const uuid = await resolveActiveProjectUuid();
          if (!uuid) {
            return textResult({
              error:
                "project:<platform> requires a project card — run `opensquid project init` first",
            });
          }
          const routing = await loadProjectChatRouting(uuid);
          const platformBlock = routing?.[platform];
          const resolved = platformBlock?.report_channel;
          if (!resolved) {
            return textResult({
              error: `no report_channel configured for ${platform} in project ${uuid} — call chat_set_project_channel first`,
            });
          }
          channel = resolved;
          if (
            platform === "telegram" &&
            platformBlock &&
            "report_topic_id" in platformBlock &&
            typeof platformBlock.report_topic_id === "number"
          ) {
            resolvedThreadId = String(platformBlock.report_topic_id);
          }
        }
        // v0.7.1 Phase B: try the chat-daemon first. The daemon owns
        // the single long-poll per platform so multiple Claude Code
        // projects can share a bot token. Fall back to the in-process
        // gateway if no daemon is running (single-project users get
        // identical behavior to v0.6.x).
        try {
          const { DaemonClient, DaemonUnreachableError } =
            await import("./chat/daemon/rpc-client.js");
          const client = new DaemonClient();
          try {
            const res = await client.send({
              channel,
              text,
              replyTo,
              threadId: resolvedThreadId,
            });
            return textResult({
              ok: true,
              platform: res.platform,
              messageId: res.message_id,
              deliveredAt: res.delivered_at,
              via: "daemon",
            });
          } catch (err) {
            if (!(err instanceof DaemonUnreachableError)) throw err;
            // fall through to in-process path below
          }
        } catch (importErr) {
          // dynamic import itself failed — extremely unlikely; fall
          // through so the user still gets a send attempt.
          process.stderr.write(
            `[chat_send] daemon-client import failed: ${importErr instanceof Error ? importErr.message : importErr}\n`,
          );
        }
        const gw = await ensureChatGateway();
        const result = await gw.send({ channel, text, replyTo, threadId: resolvedThreadId });
        return textResult({ ok: true, ...result, via: "in_process" });
      }

      case "chat_list_channels": {
        const { gateway, config, issues } = await ensureChatGatewayWithMeta();
        const allowlists: Record<string, string[]> = {};
        if (config.telegram?.allowlist_chat_ids) {
          allowlists.telegram = config.telegram.allowlist_chat_ids;
        }
        if (config.discord?.allowlist_user_ids) {
          allowlists.discord = config.discord.allowlist_user_ids;
        }
        if (config.slack?.allowlist_user_ids) {
          allowlists.slack = config.slack.allowlist_user_ids;
        }
        return textResult({
          active_platforms: gateway.activePlatforms(),
          allowlists,
          issues,
        });
      }

      case "chat_set_project_channel": {
        const platform = typeof a.platform === "string" ? a.platform : "";
        if (platform !== "telegram" && platform !== "discord" && platform !== "slack") {
          return textResult({ error: "platform must be 'telegram' | 'discord' | 'slack'" });
        }
        const report_channel =
          typeof a.report_channel === "string" ? a.report_channel.trim() : undefined;
        const inbound_chat_ids = Array.isArray(a.inbound_chat_ids)
          ? (a.inbound_chat_ids.filter((x) => typeof x === "string") as string[])
          : undefined;
        const report_topic_id =
          typeof a.report_topic_id === "number" ? a.report_topic_id : undefined;
        const inbound_topic_ids = Array.isArray(a.inbound_topic_ids)
          ? (a.inbound_topic_ids.filter((x) => typeof x === "number") as number[])
          : undefined;
        const { resolveActiveProjectUuid } = await import("./chat/daemon/active-project.js");
        const { loadProjectChatRouting, saveProjectChatRouting } =
          await import("./chat/daemon/routing.js");
        const uuid = await resolveActiveProjectUuid();
        if (!uuid) {
          return textResult({
            error: "no project card in cwd — run `opensquid project init` first",
          });
        }
        const current = (await loadProjectChatRouting(uuid)) ?? {};
        const platformBlock: Record<string, unknown> = { ...(current[platform] ?? {}) };
        if (report_channel !== undefined) platformBlock.report_channel = report_channel;
        if (inbound_chat_ids !== undefined) {
          // telegram uses inbound_chat_ids; discord/slack use inbound_channel_ids
          if (platform === "telegram") platformBlock.inbound_chat_ids = inbound_chat_ids;
          else platformBlock.inbound_channel_ids = inbound_chat_ids;
        }
        // v0.7.2 Telegram-only topic fields.
        if (platform === "telegram") {
          if (report_topic_id !== undefined) platformBlock.report_topic_id = report_topic_id;
          if (inbound_topic_ids !== undefined) platformBlock.inbound_topic_ids = inbound_topic_ids;
        } else if (report_topic_id !== undefined || inbound_topic_ids !== undefined) {
          return textResult({
            error: "report_topic_id / inbound_topic_ids only apply to platform='telegram'",
          });
        }
        const next = { ...current, [platform]: platformBlock };
        const { path: writtenPath } = await saveProjectChatRouting(uuid, next, undefined);
        return textResult({
          ok: true,
          project_uuid: uuid,
          path: writtenPath,
          routing: next,
        });
      }

      case "chat_create_topic": {
        const chatId = typeof a.chat_id === "string" ? a.chat_id.trim() : "";
        const name = typeof a.name === "string" ? a.name : "";
        if (!chatId || !name) {
          return textResult({ error: "chat_id + name (both strings) required" });
        }
        const iconColor = typeof a.icon_color === "number" ? a.icon_color : undefined;
        const iconCustomEmojiId =
          typeof a.icon_custom_emoji_id === "string" ? a.icon_custom_emoji_id : undefined;
        const writeToProject = a.project !== false; // default true
        const { DaemonClient, DaemonUnreachableError } =
          await import("./chat/daemon/rpc-client.js");
        let topicResult: { message_thread_id: number; name: string };
        try {
          const client = new DaemonClient();
          topicResult = await client.createTopic({
            platform: "telegram",
            chat_id: chatId,
            name,
            icon_color: iconColor,
            icon_custom_emoji_id: iconCustomEmojiId,
          });
        } catch (err) {
          if (!(err instanceof DaemonUnreachableError)) {
            return textResult({ error: err instanceof Error ? err.message : String(err) });
          }
          const gw = await ensureChatGateway();
          const adapter = gw.getAdapter("telegram");
          if (
            !adapter ||
            typeof (adapter as { createTopic?: unknown }).createTopic !== "function"
          ) {
            return textResult({
              error: "telegram adapter not active or doesn't support createTopic",
            });
          }
          const adapterAny = adapter as unknown as {
            createTopic: (
              chatId: string,
              name: string,
              opts: { iconColor?: number; iconCustomEmojiId?: string },
            ) => Promise<{ message_thread_id: number; name: string }>;
          };
          topicResult = await adapterAny.createTopic(chatId, name, {
            iconColor,
            iconCustomEmojiId,
          });
        }
        if (writeToProject) {
          const { resolveActiveProjectUuid } = await import("./chat/daemon/active-project.js");
          const { loadProjectChatRouting, saveProjectChatRouting } =
            await import("./chat/daemon/routing.js");
          const uuid = await resolveActiveProjectUuid();
          if (!uuid) {
            return textResult({
              ok: true,
              message_thread_id: topicResult.message_thread_id,
              name: topicResult.name,
              warning:
                "topic created but no project card in cwd — couldn't write to chat-routing.json. Run `opensquid project init` then chat_set_project_channel manually.",
            });
          }
          const current = (await loadProjectChatRouting(uuid)) ?? {};
          const telegramBlock: Record<string, unknown> = { ...(current.telegram ?? {}) };
          telegramBlock.report_channel = `telegram:${chatId}`;
          telegramBlock.report_topic_id = topicResult.message_thread_id;
          const existingInboundChats = Array.isArray(telegramBlock.inbound_chat_ids)
            ? (telegramBlock.inbound_chat_ids as string[])
            : [];
          if (!existingInboundChats.includes(chatId)) {
            telegramBlock.inbound_chat_ids = [...existingInboundChats, chatId];
          }
          const existingInboundTopics = Array.isArray(telegramBlock.inbound_topic_ids)
            ? (telegramBlock.inbound_topic_ids as number[])
            : [];
          if (!existingInboundTopics.includes(topicResult.message_thread_id)) {
            telegramBlock.inbound_topic_ids = [
              ...existingInboundTopics,
              topicResult.message_thread_id,
            ];
          }
          const next = { ...current, telegram: telegramBlock };
          await saveProjectChatRouting(uuid, next, undefined);
          return textResult({
            ok: true,
            message_thread_id: topicResult.message_thread_id,
            name: topicResult.name,
            project_uuid: uuid,
            wrote_routing: true,
          });
        }
        return textResult({
          ok: true,
          message_thread_id: topicResult.message_thread_id,
          name: topicResult.name,
          wrote_routing: false,
        });
      }

      case "chat_poll_inbox": {
        const platform =
          a.platform === "telegram" || a.platform === "discord" || a.platform === "slack"
            ? a.platform
            : undefined;
        const limit = typeof a.limit === "number" && a.limit > 0 ? Math.floor(a.limit) : 20;
        const since = typeof a.since === "string" ? a.since : undefined;
        const { resolveActiveProjectUuid } = await import("./chat/daemon/active-project.js");
        const { pollInbox } = await import("./chat/daemon/inbox-read.js");
        const uuid = await resolveActiveProjectUuid();
        if (!uuid) {
          return textResult({
            error: "no project card in cwd — run `opensquid project init` first",
            messages: [],
          });
        }
        const res = await pollInbox({ projectUuid: uuid, platform, limit, since });
        return textResult({
          project_uuid: uuid,
          messages: res.messages,
          scanned_platforms: res.scanned_platforms,
        });
      }

      case "chat_daemon_status": {
        const { status: daemonStatus } = await import("./chat/daemon/lifecycle.js");
        const s = await daemonStatus();
        if (!s.running) {
          return textResult({
            running: false,
            stale_pid: "stale_pid" in s ? s.stale_pid : undefined,
          });
        }
        // If the daemon is up, hit it via RPC for active_platforms + version.
        try {
          const { DaemonClient } = await import("./chat/daemon/rpc-client.js");
          const client = new DaemonClient();
          const [pong, list] = await Promise.all([client.ping(), client.listChannels()]);
          return textResult({
            running: true,
            pid: s.pid,
            version: pong.version,
            active_platforms: list.active_platforms,
            uptime_ms: list.uptime_ms,
          });
        } catch (rpcErr) {
          return textResult({
            running: true,
            pid: s.pid,
            rpc_error: rpcErr instanceof Error ? rpcErr.message : String(rpcErr),
          });
        }
      }

      case "log_phase": {
        const taskId = typeof a.task_id === "string" ? a.task_id.trim() : "";
        const phase = typeof a.phase === "string" ? a.phase.trim() : "";
        const note = typeof a.note === "string" ? a.note : undefined;
        // session_id is a path-segment in the engine, so fall back to
        // the agent's MCP session id when the caller omits it. Per
        // [[reference_github_auth_setup]] context, default to a stable
        // string when unavailable (the engine's validator will still
        // reject anything malformed).
        const sessionId =
          typeof a.session_id === "string" && a.session_id.trim()
            ? a.session_id.trim()
            : currentSessionId();
        if (!taskId || !phase) {
          return textResult({ error: "task_id + phase (both strings) required" });
        }
        const result = await engine.logPhase({
          session_id: sessionId,
          task_id: taskId,
          phase,
          note,
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

// v0.7.1 Phase D: opportunistically ensure the chat-daemon is running
// so chat_send routes through it and inbound Telegram/Discord/Slack
// messages land in per-project inboxes. Fire-and-forget — never block
// the MCP server's stdio loop on daemon spawn. No-op when no chat
// platforms are configured.
void (async () => {
  try {
    const { ensureDaemonRunning } = await import("./chat/daemon/autospawn.js");
    const res = await ensureDaemonRunning();
    if (res.status === "spawned" || res.status === "waited_for_peer") {
      process.stderr.write(
        `[opensquid] chat-daemon ${res.status === "spawned" ? "started" : "found peer"} (pid ${res.pid})\n`,
      );
    } else if (res.status === "error") {
      process.stderr.write(`[opensquid] chat-daemon autospawn error: ${res.error}\n`);
    }
    // "already_running" / "no_config" → silent
  } catch (err) {
    process.stderr.write(
      `[opensquid] chat-daemon autospawn import failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }
})();

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
