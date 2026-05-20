/**
 * `mcp` strategy: delegate the LLM call to a tool on an external MCP
 * server. Used when the user wants opensquid to route through a
 * specialised MCP host (e.g. a routing layer in front of multiple
 * providers, or a tool that wraps a proprietary endpoint).
 *
 * Model neutrality: this file branches on opaque user-supplied strings
 * (`cfg.server`, `cfg.tool`). The MCP server's own internals decide
 * which model handles the call — opensquid stays out of that decision.
 *
 * Fail-fast at factory time: `cfg.server` + `cfg.tool` are required.
 * Throwing during `resolveStrategy` (rather than at first `.call()`)
 * means misconfigured `models.yaml` surfaces during pack load, not
 * mid-task. This matches the runtime-failure-handling policy
 * (`project_opensquid_runtime_failure_handling`): validate early.
 *
 * Lifecycle:
 *   For Phase 1 we do connect-per-call: each `.call()` spins up a
 *   fresh Client + StdioClientTransport, runs `callTool`, then closes.
 *   Wasteful but simple; connection pooling is deferred. The MCP SDK
 *   has its own keep-alive semantics inside the Client, but pooling
 *   across strategy invocations needs a session-scoped cache the
 *   strategy doesn't currently own.
 *
 * Lazy load: `@modelcontextprotocol/sdk` is already a regular dep
 * (used by the opensquid MCP server itself), so import is just lazy
 * for startup-cost hygiene — not for optional-install.
 *
 * Test seam: tests inject a stub Client + Transport pair via
 * `opts.client` (factory returning a stub).
 *
 * Imports from: ../types.js.
 * Imported by: models/dispatcher.ts.
 */

import type { ModelAliasConfig, ModelStrategy } from '../types.js';

export interface McpToolResultContent {
  type: string;
  text?: string;
}

export interface McpToolResult {
  content?: McpToolResultContent[];
}

export interface McpClientLike {
  connect: (transport: unknown) => Promise<void>;
  callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

/**
 * Build a (client, transport) pair for one connect/call/close cycle.
 * Returning a pair (rather than just a client) lets the factory own
 * transport construction — stubs don't need to mock StdioClientTransport.
 */
export type McpClientFactory = (
  cfg: ModelAliasConfig,
) => Promise<{ client: McpClientLike; transport: unknown }>;

export interface McpStrategyOptions {
  /** Test seam: inject a client+transport factory bypassing the SDK import. */
  clientFactory?: McpClientFactory;
}

async function defaultClientFactory(
  cfg: ModelAliasConfig,
): Promise<{ client: McpClientLike; transport: unknown }> {
  // Lazy import — startup cost stays off the fast path.
  const { Client } = (await import('@modelcontextprotocol/sdk/client/index.js')) as {
    Client: new (
      info: { name: string; version: string },
      caps: { capabilities: Record<string, unknown> },
    ) => McpClientLike;
  };
  const { StdioClientTransport } = (await import('@modelcontextprotocol/sdk/client/stdio.js')) as {
    StdioClientTransport: new (opts: { command: string; args: string[] }) => unknown;
  };
  const client = new Client({ name: 'opensquid', version: '0.5.0' }, { capabilities: {} });
  // cfg.server is treated as a command (binary or path). URL-form
  // (SSE/HTTP) requires a different transport — Phase 2 will branch
  // on the shape; for now stdio is the only supported wire.
  const transport = new StdioClientTransport({
    command: cfg.server ?? '',
    args: cfg.args ?? [],
  });
  return { client, transport };
}

export function mcpStrategy(cfg: ModelAliasConfig, opts: McpStrategyOptions = {}): ModelStrategy {
  // Fail-fast at factory time so misconfigured models.yaml surfaces during
  // pack load, not mid-task.
  if (!cfg.server) {
    throw new Error('mcp strategy: `server` is required in alias config');
  }
  if (!cfg.tool) {
    throw new Error('mcp strategy: `tool` is required in alias config');
  }
  const toolName = cfg.tool;
  const factory = opts.clientFactory ?? defaultClientFactory;

  return {
    async call(prompt: string): Promise<string> {
      const { client, transport } = await factory(cfg);
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name: toolName,
          arguments: { prompt },
        });
        const first = result.content?.[0];
        if (first?.type === 'text' && typeof first.text === 'string') {
          return first.text;
        }
        return '';
      } finally {
        // Always close — connect-per-call leaks otherwise. Errors during
        // close are swallowed (we've already either returned or are about
        // to rethrow the callTool error; close failure is secondary).
        await client.close().catch(() => {
          // intentionally swallowed
        });
      }
    },
  };
}
