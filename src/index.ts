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

const VERSION = "0.4.0";

// ---- CLI subcommand dispatch ---------------------------------------
// When invoked as `npx opensquid <subcommand> [...flags]`, route to the
// CLI module and exit. With no args (the MCP-host startup path), fall
// through to the stdio server setup below.
//
// Subcommand layout:
//   opensquid install|uninstall|doctor            → CLAUDE.md installer
//   opensquid codex install|list|remove|doctor    → codex management
const subcommand = process.argv[2];
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
    codexCmd !== "doctor"
  ) {
    console.error("usage: opensquid codex install|list|remove|doctor [<args>...]");
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
  if (hookCmd !== "pre-tool-use") {
    console.error("usage: opensquid hook pre-tool-use");
    process.exit(2);
  }
  // Hook handler manages its own exit code (0 = proceed, 2 = block).
  const { runPreToolUseHook } = await import("./hooks/pre-tool-use.js");
  await runPreToolUseHook();
  // runPreToolUseHook calls process.exit() itself; this line is
  // unreachable but keeps TypeScript happy on control-flow analysis.
  process.exit(0);
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
