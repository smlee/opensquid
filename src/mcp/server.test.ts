/**
 * Subprocess integration test for `opensquid-mcp`.
 *
 * The MCP SDK speaks newline-delimited JSON-RPC over stdio. We spawn the
 * server through `tsx` (same pattern as `hooks.integration.test.ts` —
 * faster than rebuilding `dist/` and exercises the real ESM resolution
 * path), feed JSON-RPC requests via stdin, and parse responses line-by-line
 * off stdout.
 *
 * Each test owns its own `OPENSQUID_HOME` (per-test temp dir) and pins a
 * deterministic `CLAUDE_SESSION_ID`. That gives every case a clean state +
 * violations filesystem layout with zero cross-test contamination.
 *
 * The `MCPClient` helper batches one initialize handshake before each test
 * so we exercise the SDK as a real client would, not by bypassing the
 * protocol.
 *
 * Cases:
 *   1. tools/list returns exactly the 5 Phase-1 tools, each with an object
 *      JSON Schema.
 *   2. list_packs returns "no packs loaded" (Phase 1 stub).
 *   3. list_skills (no args) returns "no skills loaded".
 *   4. inspect_skill missing required arg → JSON-RPC error.
 *   5. read_state on a pre-written key returns the JSON body.
 *   6. read_state on a missing key returns "null".
 *   7. read_violations with no log file returns "".
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const SERVER_FILE = resolve(__dirname, 'server.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown> };
}

interface ToolsListResult {
  tools: ToolDef[];
}

interface ToolCallResult {
  content: { type: string; text: string }[];
}

class MCPClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private stderr = '';
  private exited = false;

  constructor(env: NodeJS.ProcessEnv) {
    this.proc = spawn(TSX_BIN, [SERVER_FILE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.proc.on('close', () => {
      this.exited = true;
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          const handler = this.pending.get(msg.id);
          if (handler) {
            this.pending.delete(msg.id);
            handler(msg);
          }
        } catch {
          // Ignore non-JSON noise (shouldn't happen with stdio transport).
        }
      }
      nl = this.buffer.indexOf('\n');
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<JsonRpcResponse>((resolveResp, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP request "${method}" timed out (stderr=${this.stderr.slice(0, 500)})`),
        );
      }, 10_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolveResp(r);
      });
      this.proc.stdin.write(body);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize(): Promise<void> {
    const r = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    if (r.error) throw new Error(`initialize failed: ${r.error.message}`);
    this.notify('notifications/initialized');
  }

  getStderr(): string {
    return this.stderr;
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    this.proc.stdin.end();
    await new Promise<void>((resolveDone) => {
      const t = setTimeout(() => {
        this.proc.kill('SIGTERM');
        resolveDone();
      }, 2000);
      this.proc.on('close', () => {
        clearTimeout(t);
        resolveDone();
      });
    });
  }
}

describe('opensquid-mcp subprocess', () => {
  let home: string;
  let sessionId: string;
  let client: MCPClient;

  beforeEach(async () => {
    home = join(tmpdir(), `opensquid-mcp-test-${randomUUID()}`);
    sessionId = `sess-${randomUUID()}`;
    await mkdir(join(home, 'sessions', sessionId, 'state'), { recursive: true });
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: home,
      CLAUDE_SESSION_ID: sessionId,
    });
    await client.initialize();
  }, 15_000);

  afterEach(async () => {
    await client.shutdown();
    await rm(home, { recursive: true, force: true });
  });

  it('tools/list returns 5 Phase-1 tools with JSON Schema', async () => {
    const r = await client.request('tools/list', {});
    expect(r.error).toBeUndefined();
    const result = r.result as ToolsListResult;
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'inspect_skill',
      'list_packs',
      'list_skills',
      'read_state',
      'read_violations',
    ]);
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
    }
  }, 15_000);

  it('list_packs returns "no packs loaded" (Phase 1 stub)', async () => {
    const r = await client.request('tools/call', { name: 'list_packs', arguments: {} });
    expect(r.error).toBeUndefined();
    const out = r.result as ToolCallResult;
    expect(out.content[0]?.text).toBe('no packs loaded');
  }, 15_000);

  it('list_skills with no args returns "no skills loaded"', async () => {
    const r = await client.request('tools/call', { name: 'list_skills', arguments: {} });
    expect(r.error).toBeUndefined();
    const out = r.result as ToolCallResult;
    expect(out.content[0]?.text).toBe('no skills loaded');
  }, 15_000);

  it('inspect_skill with missing required args yields a JSON-RPC error', async () => {
    const r = await client.request('tools/call', {
      name: 'inspect_skill',
      arguments: { pack: 'p' },
    });
    // Either a protocol-level error or a tool error response containing the
    // text. The MCP SDK turns thrown handler errors into an error response.
    if (r.error) {
      expect(r.error.message.toLowerCase()).toMatch(/invalid|required/);
    } else {
      const out = r.result as ToolCallResult & { isError?: boolean };
      expect(out.isError === true || /invalid|required/i.test(out.content[0]?.text ?? '')).toBe(
        true,
      );
    }
  }, 15_000);

  it('read_state returns the JSON body for a pre-written key', async () => {
    const file = join(home, 'sessions', sessionId, 'state', 'mykey.json');
    await writeFile(file, JSON.stringify({ hello: 'world' }), 'utf8');
    const r = await client.request('tools/call', {
      name: 'read_state',
      arguments: { key: 'mykey' },
    });
    expect(r.error).toBeUndefined();
    const out = r.result as ToolCallResult;
    expect(out.content[0]?.text).toBe('{"hello":"world"}');
  }, 15_000);

  it('read_state returns "null" for a missing key', async () => {
    const r = await client.request('tools/call', {
      name: 'read_state',
      arguments: { key: 'nope' },
    });
    expect(r.error).toBeUndefined();
    const out = r.result as ToolCallResult;
    expect(out.content[0]?.text).toBe('null');
  }, 15_000);

  it('read_violations returns "" when no violations.jsonl exists', async () => {
    const r = await client.request('tools/call', {
      name: 'read_violations',
      arguments: {},
    });
    expect(r.error).toBeUndefined();
    const out = r.result as ToolCallResult;
    expect(out.content[0]?.text).toBe('');
  }, 15_000);
});
