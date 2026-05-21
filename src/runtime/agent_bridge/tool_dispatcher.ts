/**
 * agent_bridge — tool dispatcher (WAB.4, 0.5.97).
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` WAB.4.
 * Architecture: `docs/tasks/WAB.1-architecture.md` decisions (e) + (f).
 *
 * Responsibility:
 *   1. Hold a name-indexed registry of `ToolSpec` + `ToolHandler` pairs.
 *   2. On `call(name, input, ctx)`: look up the spec, run the spec's
 *      optional `validate(input)` guard (throws on bad input), forward
 *      the validated value to the handler, return the handler's string
 *      output (which the agent loop feeds back as a `tool_result` block).
 *   3. On `list()`: return the snapshot of registered specs in the order
 *      they were registered. The agent loop passes this to
 *      `Anthropic.messages.create({ tools })`.
 *
 * Non-responsibility:
 *   - Does NOT call the model. The agent loop (`agent_loop.ts`) owns the
 *     SDK round-trip; the dispatcher only resolves `tool_use` blocks.
 *   - Does NOT manage tool lifecycle (registration happens once per
 *     session at construction; no add/remove at runtime in WAB.4).
 *   - Does NOT auto-convert zod → JSON Schema. Tool authors supply both
 *     `input_schema` (JSON Schema, for the model) and `validate`
 *     (runtime guard, for the dispatcher) — see types.ts comment.
 *
 * Error contract:
 *   - Unknown name → `Error` with prefix `tool_dispatcher: unknown tool`.
 *     The agent loop catches and surfaces as a fatal turn error (the
 *     model invoked something not in the declared list — likely a
 *     schema/spec mismatch).
 *   - Validation failure → re-throws the validator's error (zod's
 *     `ZodError` carries structured detail; ajv's `ValidationError`
 *     similarly). Caller can inspect the error class.
 *   - Handler rejection → surfaces unmodified.
 *
 * Imports from: ./types.js.
 * Imported by: agent_loop.ts (caller), pack_binding.ts (WAB.6
 *   builder), daemon.ts (WAB.7 wiring).
 */

import type { ToolContext, ToolDispatcher, ToolHandler, ToolSpec } from './types.js';

// ---------------------------------------------------------------------------
// Internal record — pairs a spec with its handler in the registry.
// ---------------------------------------------------------------------------

interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// Registration input — accepted by the constructor and by `register()`.
//
// Same shape as `RegisteredTool` but exposed as a separate type so
// consumers can build arrays of these without importing the private
// `RegisteredTool` interface.
// ---------------------------------------------------------------------------

export interface ToolRegistration {
  spec: ToolSpec;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// SimpleToolDispatcher — the only impl shipped in WAB.4.
//
// Map-backed (O(1) lookup), insertion-order-preserving for `list()`. The
// constructor accepts an optional initial registration list; `register`
// adds more (throws on duplicate name — sessions should never silently
// shadow a tool).
//
// Naming: prefixed `Simple` so a future WAB iteration (e.g. priority
// routing, MCP-tool delegation) can add a parallel `LayeredToolDispatcher`
// without renaming this one.
// ---------------------------------------------------------------------------

export class SimpleToolDispatcher implements ToolDispatcher {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(initial: ToolRegistration[] = []) {
    for (const t of initial) this.register(t);
  }

  /**
   * Add a tool to the registry. Throws on duplicate name — silent
   * shadowing would let one pack hijack another pack's tool surface.
   */
  register(t: ToolRegistration): void {
    if (this.tools.has(t.spec.name)) {
      throw new Error(`tool_dispatcher: duplicate tool name '${t.spec.name}' — refusing to shadow`);
    }
    this.tools.set(t.spec.name, { spec: t.spec, handler: t.handler });
  }

  /** Live tool count (telemetry / tests). */
  get size(): number {
    return this.tools.size;
  }

  /** Whether a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  // -------------------------------------------------------------------------
  // ToolDispatcher impl
  // -------------------------------------------------------------------------

  list(): ToolSpec[] {
    // Snapshot — callers should be free to pass this directly to the SDK
    // without worrying about it being mutated underneath them. The Map's
    // values() iterator preserves insertion order, matching how authors
    // expect tools to appear in the model's tool list.
    return Array.from(this.tools.values()).map((t) => t.spec);
  }

  async call(name: string, input: unknown, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      // Include the registered tool names in the message — debugging
      // why the model picked a non-existent tool is much easier when
      // you can see what WAS available at dispatch time.
      const available = Array.from(this.tools.keys()).join(', ');
      throw new Error(`tool_dispatcher: unknown tool '${name}' (registered: [${available}])`);
    }
    // Spec opted into runtime validation → run it. The validator may
    // narrow the type by returning a refined value; we forward THAT to
    // the handler so zod's `.parse()` doubles as a type-narrowing
    // step. Validators that don't narrow can just return the input
    // unchanged.
    const validated = tool.spec.validate !== undefined ? tool.spec.validate(input) : input;
    return tool.handler(validated, ctx);
  }
}
