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
 *   1. tools/list returns the 12 tools (8 read-only + G.3's `memorize`,
 *      `store_lesson`, `forget` + AP.3's `log_phase`), each with an object JSON Schema.
 *   2. list_packs returns "no packs loaded" (Phase 1 stub).
 *   3. list_skills (no args) returns "no skills loaded".
 *   4. inspect_skill missing required arg → JSON-RPC error.
 *   5. read_state on a pre-written key returns the JSON body.
 *   6. read_state on a missing key returns "null".
 *   7. read_violations with no log file returns "".
 *   8. list_drift_events on a pre-populated pack catalog returns the merged JSON.
 *   9. recall validates query (empty string rejected).
 *  10. recall validates k bounds (>50 rejected; <1 rejected).
 *  11. recall returns "No memories found..." when backend yields zero hits.
 *  12. recall formats multi-hit output as "[N] (source, score=X.XXX) <content>".
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
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
  annotations?: Record<string, boolean>;
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
      // Isolate project scope too, not just user scope (OPENSQUID_HOME): the child's
      // resolveProjectScopeRoot walks up from cwd, so an inherited repo-root cwd would
      // pick up this repo's .opensquid/active.json. The per-test temp home has none —
      // matching CI's clean checkout, where these "no packs loaded" stubs pass.
      cwd: env.OPENSQUID_HOME,
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
    await mkdir(join(home, '.opensquid'), { recursive: true });
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: home,
      OPENSQUID_PROJECT_ROOT: home,
      CLAUDE_SESSION_ID: sessionId,
      // Pin recall's backend to the lexical (Ollama-free) variant so the
      // tool's RAG path is testable without an Ollama or engine binary on
      // the runner. Each test gets its own OPENSQUID_HOME, so the libsql
      // file is fresh per test.
      OPENSQUID_RAG_BACKEND: 'libsql-lexical',
    });
    await client.initialize();
  }, 15_000);

  afterEach(async () => {
    await client.shutdown();
    await rm(home, { recursive: true, force: true });
  });

  it('a direct MCP issue close pushes item_closed to the project monitor stream', async () => {
    const created = await client.request('tools/call', {
      name: 'workgraph_create_issue',
      arguments: { title: 'monitor close fixture' },
    });
    expect(created.error).toBeUndefined();
    const createdResult = created.result as ToolCallResult;
    const issue = JSON.parse(createdResult.content[0]!.text) as { id: string };

    const updated = await client.request('tools/call', {
      name: 'workgraph_update_issue',
      arguments: { id: issue.id, status: 'closed' },
    });
    expect(updated.error).toBeUndefined();

    const db = createClient({ url: `file:${join(home, '.opensquid', 'opensquid.db')}` });
    try {
      const rows = await db.execute({
        sql: 'SELECT wg_id, kind FROM loop_events WHERE wg_id = ?',
        args: [issue.id],
      });
      expect(rows.rows).toEqual([
        expect.objectContaining({ wg_id: issue.id, kind: 'item_closed' }),
      ]);
    } finally {
      db.close();
    }
  });

  it('tools/list returns the 31 tools (+ kanban overlay + story, KANBAN.2/.5) with JSON Schema', async () => {
    const r = await client.request('tools/list', {});
    expect(r.error).toBeUndefined();
    const result = r.result as ToolsListResult;
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'decision_classify',
      'forget',
      'inspect_skill',
      'kanban_board',
      'kanban_create_board',
      'kanban_place',
      'kanban_remove',
      'kanban_story',
      'kanban_sync',
      'list_drift_events',
      'list_packs',
      'list_skills',
      'log_phase',
      'memorize',
      'read_state',
      'read_violations',
      'recall',
      'set_goal',
      'set_loop_phase',
      'store_lesson',
      'web_fetch',
      'workgraph_add_edge',
      'workgraph_archive',
      'workgraph_claim',
      'workgraph_create_issue',
      'workgraph_events',
      'workgraph_get',
      'workgraph_list',
      'workgraph_ready',
      'workgraph_unarchive',
      'workgraph_update_issue',
    ]);
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
    }
    // recall description is user-visible in Claude Code's MCP listing —
    // assert no engine-internal vocabulary leaked.
    const recallTool = result.tools.find((t) => t.name === 'recall');
    expect(recallTool).toBeDefined();
    expect(recallTool!.description).toMatch(/memor/i);
    expect(recallTool!.description).not.toMatch(/wedge|manifest|cartridge/i);
    // G.3 write-tool descriptions — assert the load-bearing copy that
    // distinguishes memorize (immediate persist) from store_lesson
    // (Stage-1 candidate) and warns against direct promote_lesson calls.
    const memorize = result.tools.find((t) => t.name === 'memorize');
    expect(memorize?.description).toMatch(/eviction-immune/i);
    const storeLesson = result.tools.find((t) => t.name === 'store_lesson');
    expect(storeLesson?.description).toMatch(/stage 1/i);
    expect(storeLesson?.description).toMatch(/do not call promote_lesson/i);
    const forgetTool = result.tools.find((t) => t.name === 'forget');
    expect(forgetTool?.description).toMatch(/force: true/i);
    // T-MCP-TOOL-ANNOTATIONS: every tool carries honest behavior hints —
    // annotation-aware hosts auto-approve reads/local-writes, keep prompting
    // on the destructive tool. No idempotentHint anywhere (op-log appends).
    for (const t of result.tools) {
      expect(t.annotations, `${t.name} must carry annotations`).toBeDefined();
      expect(t.annotations!.idempotentHint).toBeUndefined();
    }
    const ann = (n: string): Record<string, boolean> =>
      result.tools.find((t) => t.name === n)!.annotations!;
    for (const n of ['recall', 'list_packs', 'workgraph_get', 'workgraph_events']) {
      expect(ann(n).readOnlyHint).toBe(true);
      expect(ann(n).openWorldHint).toBe(false);
    }
    expect(ann('forget').destructiveHint).toBe(true);
    expect(ann('memorize').readOnlyHint).toBe(false);
    expect(ann('memorize').destructiveHint).toBe(false);
    expect(ann('workgraph_update_issue').destructiveHint).toBe(false);
    // KANBAN.2: honest auth — kanban_board is a pure read, kanban_sync mutates the overlay.
    expect(ann('kanban_board').readOnlyHint).toBe(true);
    expect(ann('kanban_sync').readOnlyHint).toBe(false);
    expect(ann('kanban_sync').destructiveHint).toBe(false);
    // KANBAN.5: kanban_story is a pure read of the work-graph.
    expect(ann('kanban_story').readOnlyHint).toBe(true);
  }, 15_000);

  it('memorize with missing required args yields an error (Zod runs before engine)', async () => {
    const r = await client.request('tools/call', {
      name: 'memorize',
      arguments: { description: 'd' }, // missing content
    });
    if (r.error) {
      expect(r.error.message.toLowerCase()).toMatch(/invalid|content|required/);
    } else {
      const out = r.result as ToolCallResult & { isError?: boolean };
      expect(out.isError === true || /invalid|content/i.test(out.content[0]?.text ?? '')).toBe(
        true,
      );
    }
  }, 15_000);

  it('store_lesson with invalid classification yields an error (Zod runs before engine)', async () => {
    const r = await client.request('tools/call', {
      name: 'store_lesson',
      arguments: { description: 'd', content: 'c', classification: 'nonsense' },
    });
    if (r.error) {
      expect(r.error.message.toLowerCase()).toMatch(/invalid|classification/);
    } else {
      const out = r.result as ToolCallResult & { isError?: boolean };
      expect(
        out.isError === true || /invalid|classification/i.test(out.content[0]?.text ?? ''),
      ).toBe(true);
    }
  }, 15_000);

  it('forget with empty id yields an error (Zod runs before engine)', async () => {
    const r = await client.request('tools/call', {
      name: 'forget',
      arguments: { id: '' },
    });
    if (r.error) {
      expect(r.error.message.toLowerCase()).toMatch(/invalid|id|required/);
    } else {
      const out = r.result as ToolCallResult & { isError?: boolean };
      expect(out.isError === true || /invalid|id/i.test(out.content[0]?.text ?? '')).toBe(true);
    }
  }, 15_000);

  it('CallTool with unknown name yields an error (regression)', async () => {
    const r = await client.request('tools/call', {
      name: 'this_tool_does_not_exist',
      arguments: {},
    });
    if (r.error) {
      expect(r.error.message.toLowerCase()).toMatch(/unknown|not.*found/);
    } else {
      const out = r.result as ToolCallResult & { isError?: boolean };
      expect(out.isError === true || /unknown|not/i.test(out.content[0]?.text ?? '')).toBe(true);
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

  it('list_drift_events aggregates a pre-populated pack catalog with session catalog', async () => {
    // Seed one pack catalog + one session catalog under the per-test HOME.
    const packDir = join(home, 'packs', 'pack-a', 'state');
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, 'drift-catalog.jsonl'),
      `${JSON.stringify({ timestamp: '2026-05-19T10:00:00Z', ruleId: 'r1', level: 'block', message: 'from a' })}\n`,
      'utf8',
    );
    await writeFile(
      join(home, 'sessions', sessionId, 'state', 'drift-catalog.jsonl'),
      `${JSON.stringify({ timestamp: '2026-05-19T09:00:00Z', ruleId: 'r2', level: 'warn', message: 'from session' })}\n`,
      'utf8',
    );

    const r = await client.request('tools/call', {
      name: 'list_drift_events',
      arguments: { packs: ['pack-a'] },
    });
    expect(r.error).toBeUndefined();
    const out = r.result as ToolCallResult;
    const events = JSON.parse(out.content[0]?.text ?? '[]') as {
      timestamp: string;
      pack: string;
      ruleId: string;
    }[];
    // Chronological order: session@09 → pack-a@10.
    expect(events.map((e) => `${e.pack}|${e.ruleId}`)).toEqual(['<session>|r2', 'pack-a|r1']);
  }, 15_000);

  it('recall rejects an empty query (Zod min(1))', async () => {
    const r = await client.request('tools/call', {
      name: 'recall',
      arguments: { query: '' },
    });
    if (r.error) {
      expect(r.error.message.toLowerCase()).toMatch(/invalid|query/);
    } else {
      const out = r.result as ToolCallResult & { isError?: boolean };
      expect(out.isError === true || /invalid|query/i.test(out.content[0]?.text ?? '')).toBe(true);
    }
  }, 15_000);

  it('recall rejects k > 50 and k < 1 (Zod bounds)', async () => {
    const tooHigh = await client.request('tools/call', {
      name: 'recall',
      arguments: { query: 'anything', k: 100 },
    });
    if (tooHigh.error) {
      expect(tooHigh.error.message.toLowerCase()).toMatch(/invalid|k/);
    } else {
      const out = tooHigh.result as ToolCallResult & { isError?: boolean };
      expect(out.isError === true || /invalid/i.test(out.content[0]?.text ?? '')).toBe(true);
    }
    const tooLow = await client.request('tools/call', {
      name: 'recall',
      arguments: { query: 'anything', k: 0 },
    });
    if (tooLow.error) {
      expect(tooLow.error.message.toLowerCase()).toMatch(/invalid|k/);
    } else {
      const out = tooLow.result as ToolCallResult & { isError?: boolean };
      expect(out.isError === true || /invalid/i.test(out.content[0]?.text ?? '')).toBe(true);
    }
  }, 15_000);

  it('recall returns "No memories found..." for a fresh empty backend', async () => {
    const r = await client.request('tools/call', {
      name: 'recall',
      arguments: { query: 'nothing-will-match-this-xyz123' },
    });
    expect(r.error).toBeUndefined();
    const out = r.result as ToolCallResult;
    // `.toContain` (not `.toBe`): a null-namespace recall prepends the fail-loud scope notice
    // (T-memory-scope-isolation), which is allowed to ride ahead of the empty-result line.
    expect(out.content[0]?.text).toContain(
      'No memories found matching "nothing-will-match-this-xyz123".',
    );
  }, 15_000);
});
