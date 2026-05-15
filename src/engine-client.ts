/**
 * Thin JSON-RPC 2.0 client that spawns `loop-engine serve` as a
 * subprocess and talks to it over stdin/stdout.
 *
 * Responsibilities:
 *  - Spawn the engine binary lazily on first call.
 *  - Map outgoing requests to pending promises by `id`.
 *  - Translate JSON-RPC error responses into thrown JS Errors with
 *    `.code` and `.data` attached.
 *  - Survive crashes: if the subprocess exits, the next call respawns.
 *
 * Binary discovery (v0.4 — see src/config.ts resolveEngineBin):
 *   1. `OPENSQUID_ENGINE_BIN` env var — explicit override
 *   2. `<data-root>/config.json` `engine_bin` field — persisted choice
 *   3. Auto-search common dev paths (~/projects/<*>/engine/target/release/
 *      and ~/work/<*>/engine/target/release/)
 *   4. $PATH — system-installed binary
 *   5. Throw with a helpful error message
 *
 * On first successful auto-discovery, the resolved path is written back
 * to config.json so subsequent sessions skip the search. Moving the
 * loop-engine checkout invalidates the cached path; the next start
 * re-discovers automatically.
 *
 * v0.2 keeps the subprocess alive across the MCP session lifetime —
 * a single engine process serves all tool calls until the MCP host
 * disconnects.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { resolveEngineBin } from "./config.js";

export class RpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class EngineClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private startupAck: Promise<void> | null = null;

  /** Lazily spawn the engine subprocess. Idempotent. */
  private async ensureStarted(): Promise<void> {
    if (this.proc) return;
    if (this.startupAck) return this.startupAck;

    const bin = await resolveEngineBin();
    if (!bin) {
      throw new Error(
        "loop-engine binary not found. Set OPENSQUID_ENGINE_BIN, or run " +
          "`opensquid engine set-path <path>`, or build the engine at " +
          "~/projects/loop/engine/target/release/loop-engine",
      );
    }
    const proc = spawn(bin, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Pin the engine to opensquid's storage root so the on-disk
        // layout is shared across both halves.
        LOOP_HOME: process.env.LOOP_HOME ?? `${process.env.HOME}/.opensquid`,
      },
    });
    this.proc = proc;
    this.reader = createInterface({ input: proc.stdout });
    this.reader.on("line", (line: string) => this.handleLine(line));

    proc.stderr.on("data", (chunk: Buffer) => {
      // Engine logs go to stderr; mirror them but tag so they're
      // distinguishable from opensquid's own logs.
      const text = chunk.toString().trimEnd();
      if (text) console.error(`[engine] ${text}`);
    });

    proc.on("exit", (code: number | null) => {
      const reason = `engine subprocess exited (code=${code ?? "null"})`;
      console.error(`[opensquid] ${reason}`);
      this.proc = null;
      this.reader = null;
      // Reject all in-flight calls so callers can retry.
      for (const [, pending] of this.pending) {
        pending.reject(new Error(reason));
      }
      this.pending.clear();
    });

    proc.on("error", (err: Error) => {
      console.error(`[opensquid] engine spawn error: ${err.message}`);
    });

    // Single ping to confirm the engine is live before we return.
    this.startupAck = this.call("ping", {})
      .then(() => undefined)
      .catch((e: Error) => {
        throw new Error(`engine failed to start: ${e.message}`);
      });
    return this.startupAck;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch (e) {
      console.error(`[opensquid] failed to parse engine line: ${e}`);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      console.error(`[opensquid] response for unknown id=${msg.id}`);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * Send a JSON-RPC request, await the response. Throws `RpcError` on
   * engine-side errors; throws `Error` on subprocess crashes.
   */
  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (method !== "ping") await this.ensureStarted();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      if (!this.proc) {
        reject(new Error("engine subprocess not running"));
        return;
      }
      this.proc.stdin.write(req + "\n");
    });
  }

  /** Graceful shutdown — kill the subprocess. */
  shutdown(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

// ---- Typed convenience wrappers around the engine surface ----------

/**
 * Mirror of the engine's `MemoryScope` serde shape. Wire format:
 *   - `"user"` | `"global"` (unit variants)
 *   - `{ team: "id" }` | `{ skill: "id" }` | `{ project: "id" }`
 */
export type MemoryScope =
  | "user"
  | "global"
  | { team: string }
  | { skill: string }
  | { project: string };

/**
 * Mirror of the engine's `MemoryOrigin` serde shape — v0.4 provenance
 * metadata attached to every memorize call. All fields are optional;
 * hosts populate what they can detect. Engine YAML omits absent
 * fields via `skip_serializing_if`, so partial blocks round-trip
 * cleanly.
 *
 * Privacy invariant: `session_id` is opaque (hashed first 8 chars),
 * never a raw UUID. `cwd_basename` is the last path segment only,
 * never the full path.
 */
export interface MemoryOrigin {
  host?: string;
  session_id?: string;
  model?: string;
  cwd_basename?: string;
  written_at?: string;
}

/**
 * Mirror of the engine's serve.rs `ScopeFilterWire` enum. The engine's
 * runtime `MemoryScopeFilter` is allocation-aware; this wire form is
 * intentionally simple JSON the host can build inline.
 */
export type MemoryScopeFilter =
  | { kind: "exact"; scope: MemoryScope }
  | { kind: "kind"; kind_name: "user" | "team" | "skill" | "project" | "global" }
  | { kind: "any_of"; scopes: MemoryScope[] };

export interface CreateLessonResult {
  id: string;
  status: "pending";
  authored_by: "user" | "agent";
  created_at: string;
}

export interface RecallResult {
  query: string;
  returned: number;
  results: Array<{
    kind: "lesson";
    id: string;
    description: string;
    status: string;
    body_preview: string;
    similarity: number;
    applied_count: number;
  }>;
}

export interface PromoteResult {
  ok: true;
  id: string;
  gate: "passed";
  status: "promoted";
  from: string;
}

export interface DiscardResult {
  ok: true;
  id: string;
  status: "discarded";
  from: string;
  reason?: string;
}

export interface CreateMemoryResult {
  id: string;
  description: string;
  created_at: string;
  scope: MemoryScope;
  /** v0.4: provenance block, populated when the caller sent one. */
  origin?: MemoryOrigin | null;
}

export interface MemorySearchResult {
  query: string;
  returned: number;
  results: Array<{
    kind: "memory";
    id: string;
    description: string;
    /**
     * Body content. Always the truncated 240-char preview unless the
     * caller passed `include_body: true` — in that case this is the
     * FULL body (no truncation). The engine reuses the same field for
     * both modes so callers don't have to branch on shape.
     */
    body_preview: string;
    /**
     * Score in `[0.0, 1.0]`. Interpretation depends on `source`:
     * `semantic` → cosine similarity; `text` → token+substring score;
     * `both` → RRF-fused score (sum of `1/(60+rank)` per source).
     */
    similarity: number;
    /**
     * v0.5: which search path produced this hit. `undefined` on
     * pre-v0.5 engine responses. `"both"` means the same memory
     * surfaced from both the semantic and text sub-searches under
     * mode `"hybrid"` — strongest signal.
     */
    source?: "semantic" | "text" | "both";
  }>;
}

export interface GetMemoryResult {
  id: string;
  description: string;
  /** Full body content (no truncation). */
  content: string;
  created_at: string;
  scope: MemoryScope;
  /** v0.4: provenance block; `null` for pre-v0.4 memories. */
  origin?: MemoryOrigin | null;
}

export class OpenSquidEngine {
  private client = new EngineClient();

  shutdown(): void {
    this.client.shutdown();
  }

  ping(): Promise<{ ok: boolean; version: string }> {
    return this.client.call("ping", {});
  }

  createLesson(args: {
    description: string;
    body: string;
    evidence?: string[];
    /**
     * Engine v1.1: `"pack"` indicates codex-seeded provenance; requires
     * `pack_id` companion + `seed_as_promoted: true` to land in promoted.
     */
    authored_by?: "user" | "agent" | "pack";
    /** Engine v1.1: required when `authored_by === "pack"`. */
    pack_id?: string;
    /**
     * Engine v1.2: opaque per-pack lesson id. When present alongside
     * `pack_id` on a Pack-authored create, the engine UPSERTs by
     * `(pack_id, external_id)` — re-installing the same codex updates
     * the existing lesson in place instead of minting a new engine id.
     * This keeps the engine-id stable so CLAUDE.md auto-publish dedup
     * (which is keyed on engine id) actually works on re-installs.
     * Only meaningful when `authored_by === "pack"`.
     */
    external_id?: string;
    /**
     * Engine v1.1: bypass the wedge gate and land in `promoted` directly.
     * Only valid when `authored_by === "pack"`. The trust comes from
     * user-installing the codex.
     */
    seed_as_promoted?: boolean;
  }): Promise<CreateLessonResult> {
    return this.client.call("lesson.create", args);
  }

  recall(args: { query: string; limit?: number }): Promise<RecallResult> {
    return this.client.call("lesson.recall", args);
  }

  promote(args: { id: string }): Promise<PromoteResult> {
    return this.client.call("lesson.promote", args);
  }

  discard(args: { id: string; reason?: string; force?: boolean }): Promise<DiscardResult> {
    return this.client.call("lesson.discard", args);
  }

  createMemory(args: {
    description: string;
    content: string;
    authored_by?: "user" | "agent";
    /** v0.3.1: optional scope tag. Defaults to `User` on the engine. */
    scope?: MemoryScope;
    /**
     * v0.4: optional provenance block. opensquid auto-populates via
     * `detectOrigin()` when this is omitted; pass an explicit value
     * to override (test fixtures, replay tooling).
     */
    origin?: MemoryOrigin;
  }): Promise<CreateMemoryResult> {
    return this.client.call("memory.create", args);
  }

  searchMemory(args: {
    query: string;
    limit?: number;
    /**
     * v0.3.1: when true, results carry the FULL body in `body_preview`
     * instead of a 240-char truncation. Use for re-anchoring on long
     * memories after context drift.
     */
    include_body?: boolean;
    /** v0.3.1: restrict results to memories matching this scope filter. */
    scope_filter?: MemoryScopeFilter;
    /**
     * v0.5: which search path to run.
     * - `"semantic"` (default): cosine similarity over the embedder.
     * - `"text"`: token-overlap + substring score (no embedder call).
     * - `"hybrid"`: run both and RRF-merge by id; same-id hits get
     *   a strict score boost and `source: "both"`.
     *
     * opensquid's `recall` defaults to `"hybrid"` — it fixes the
     * v0.4 false-negative where proper-noun queries scored below
     * the semantic threshold even when the description matched
     * literally.
     */
    mode?: "semantic" | "text" | "hybrid";
    /**
     * v0.5: per-sub-search similarity floor, applied to RAW scores
     * BEFORE the hybrid RRF merge. Use this instead of post-filtering
     * the response — RRF scores aren't in the same range as raw
     * cosine/token scores so a uniform threshold post-merge would be
     * wrong. opensquid's recall passes its `min_similarity` here.
     */
    min_similarity?: number;
  }): Promise<MemorySearchResult> {
    return this.client.call("memory.search", args);
  }

  /**
   * v0.3.1: fetch a single memory by id with full content + scope.
   * Throws `RpcError` with code -32002 if no memory with that id
   * exists (engine returns `DispatchError::NotFound`).
   */
  getMemory(args: { id: string }): Promise<GetMemoryResult> {
    return this.client.call("memory.get", args);
  }

  /**
   * v0.4: mutate description / content / scope on an existing memory.
   * Identity, citation counter, derived_from, and origin are always
   * preserved. Re-embeds on content change; cheap path for
   * description/scope-only edits. At least one mutable field must
   * be supplied. Throws `RpcError` -32002 if the id doesn't exist.
   */
  updateMemory(args: {
    id: string;
    description?: string;
    content?: string;
    scope?: MemoryScope;
  }): Promise<{
    ok: true;
    id: string;
    description: string;
    created_at: string;
    updated_at: string;
    scope: MemoryScope;
    origin?: MemoryOrigin | null;
  }> {
    return this.client.call("memory.update", args);
  }

  /**
   * v0.4: `forget` — delete a memory. `force = false` (default)
   * respects user-immunity (returns RpcError -32003 if cited by a
   * user-authored lesson). `force = true` is the user-initiated
   * override.
   */
  deleteMemory(args: { id: string; force?: boolean }): Promise<{
    ok: true;
    id: string;
    forced: boolean;
  }> {
    return this.client.call("memory.delete", args);
  }
}
