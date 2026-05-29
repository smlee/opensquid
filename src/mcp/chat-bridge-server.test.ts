/**
 * T-CBT CBT.1 — subprocess integration test for `opensquid-chat-bridge-mcp`.
 *
 * Mirrors `src/mcp/server.test.ts` (the read-only opensquid-mcp server's
 * subprocess pattern). Covers both tools:
 *   - `chat_poll_inbox` — read-only inbox merge (fs JSONL + the long-lived
 *     ChatBridgeSubscriber's LRU push-buffer), filter by since/platform/limit,
 *     collision warning prefix.
 *   - `chat_send` — line-delimited JSON-RPC over UDS to the chat-daemon's
 *     `send` method, including `project:<platform>` shorthand resolution via
 *     chat-routing.json.
 *
 * Per-test isolation: every case owns its own tmp `OPENSQUID_HOME`, optional
 * tmp cwd (for project.json cwd-walk cases), and a fresh `FakeChatDaemon`
 * UDS server at `<tmp-HOME>/chat-daemon.sock`.
 *
 * `FakeChatDaemon` handles BOTH `send` (one-shot canned reply + capture
 * params) AND `subscribe` (ack + keep-alive). The keep-alive matters: the
 * long-lived `ChatBridgeSubscriber` in chat-bridge-server.ts:617 boots
 * UNCONDITIONALLY — no `AUTOBOOT` env var to disable it (verified by grep).
 * Without subscribe-handling the subscriber spams reconnect attempts onto
 * stderr.
 *
 * Skips entirely on Windows: the UDS surface uses `\\.\pipe\...` named
 * pipes there, which the test harness doesn't model.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const SERVER_FILE = resolve(__dirname, 'chat-bridge-server.ts');

// ---------------------------------------------------------------------------
// JSON-RPC + MCP types (copied from server.test.ts).
// ---------------------------------------------------------------------------

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
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// FakeChatDaemon — UDS server that mimics the real chat-daemon's `send`
// JSON-RPC method + acks `subscribe` (the long-lived ChatBridgeSubscriber
// boots unconditionally; the fake keeps it quiet).
// ---------------------------------------------------------------------------

interface CapturedSend {
  channel: string;
  text: string;
  replyTo?: string;
  threadId?: string;
}

class FakeChatDaemon {
  private server: Server | null = null;
  private readonly connections = new Set<Socket>();
  public readonly sentRequests: CapturedSend[] = [];

  async listen(socketPath: string): Promise<void> {
    this.server = createServer((sock) => {
      this.connections.add(sock);
      let buf = '';
      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          this.handleLine(sock, line);
          nl = buf.indexOf('\n');
        }
      });
      sock.on('close', () => this.connections.delete(sock));
      sock.on('error', () => this.connections.delete(sock));
    });
    return new Promise<void>((resolveListen, reject) => {
      const srv = this.server!;
      srv.once('error', reject);
      srv.listen(socketPath, () => resolveListen());
    });
  }

  private handleLine(sock: Socket, line: string): void {
    let parsed: {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(line) as {
        jsonrpc?: string;
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
    } catch {
      return;
    }
    if (parsed.method === 'send') {
      const params = (parsed.params ?? {}) as {
        channel?: string;
        text?: string;
        replyTo?: string;
        threadId?: string;
      };
      const captured: CapturedSend = {
        channel: params.channel ?? '',
        text: params.text ?? '',
        ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      };
      this.sentRequests.push(captured);
      sock.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            ok: true,
            platform: 'telegram',
            message_id: 'fake-123',
            delivered_at: '2026-05-29T00:00:00Z',
          },
        }) + '\n',
      );
      try {
        sock.end();
      } catch {
        /* already closing */
      }
      return;
    }
    // subscribe / unknown — ack + keep connection open so the long-lived
    // ChatBridgeSubscriber stays quiet.
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }) + '\n');
  }

  async close(): Promise<void> {
    for (const c of this.connections) {
      try {
        c.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this.connections.clear();
    if (this.server) {
      const srv = this.server;
      await new Promise<void>((r) => srv.close(() => r()));
      this.server = null;
    }
  }
}

// ---------------------------------------------------------------------------
// MCPClient — adapted from server.test.ts:70-166. SERVER_FILE swapped for
// chat-bridge-server.ts; constructor accepts optional `cwd` so cases that
// exercise the cwd-walk pass a fixture directory containing
// `.opensquid/project.json`.
// ---------------------------------------------------------------------------

class MCPClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private stderr = '';
  private exited = false;

  constructor(env: NodeJS.ProcessEnv, cwd?: string) {
    this.proc = spawn(TSX_BIN, [SERVER_FILE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      ...(cwd !== undefined ? { cwd } : {}),
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
          /* non-JSON noise — ignore (shouldn't happen on stdio transport) */
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

// ---------------------------------------------------------------------------
// Fixture helpers — seed inbox/routing/collision/project-card files on disk.
// ---------------------------------------------------------------------------

function validInboxMsg(
  overrides: Partial<{
    id: string;
    platform: 'telegram' | 'discord' | 'slack';
    channel: string;
    sender: string;
    text: string;
    enqueued_at: string;
  }> = {},
): string {
  return JSON.stringify({
    v: 1,
    id: overrides.id ?? randomUUID(),
    platform: overrides.platform ?? 'telegram',
    channel: overrides.channel ?? '-1001234',
    sender: overrides.sender ?? 'alice',
    sender_id: '12345',
    text: overrides.text ?? 'hello',
    received_at: overrides.enqueued_at ?? '2026-05-29T00:00:00Z',
    enqueued_at: overrides.enqueued_at ?? '2026-05-29T00:00:00Z',
    mentions_bot: false,
  });
}

async function seedInbox(
  home: string,
  projectUuid: string,
  pf: 'telegram' | 'discord' | 'slack',
  lines: string[],
): Promise<void> {
  const dir = join(home, 'projects', projectUuid, 'inbox');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${pf}.jsonl`), lines.map((l) => l + '\n').join(''), 'utf8');
}

async function seedChatRouting(
  home: string,
  projectUuid: string,
  routing: { telegram?: { report_channel: string; report_topic_id?: number } },
): Promise<void> {
  const dir = join(home, 'projects', projectUuid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'chat-routing.json'), JSON.stringify(routing), 'utf8');
}

async function seedCollisions(home: string, entries: object[]): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, 'collisions.jsonl'),
    entries.map((e) => JSON.stringify(e) + '\n').join(''),
    'utf8',
  );
}

/** Extract the surfaced error string regardless of which envelope the SDK
 *  used (JSON-RPC error vs tool-result isError). */
function surfaceText(r: JsonRpcResponse): string {
  if (r.error) return r.error.message;
  const result = r.result as ToolCallResult;
  return result.content[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// Outer describe — entire suite skips on Windows (UDS surface is named-pipe
// shaped there; not modelled here).
// ---------------------------------------------------------------------------

const RUN = platform() === 'win32' ? describe.skip : describe;

RUN('opensquid-chat-bridge-mcp subprocess', () => {
  let tempHome: string;
  let priorHome: string | undefined;
  let fakeDaemon: FakeChatDaemon;
  let client: MCPClient | null = null;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cbt-'));
    process.env.OPENSQUID_HOME = tempHome;

    // L14 — UDS socket path < 104 bytes (macOS cap; Linux is 108). Fail
    // loud with the path in the message if a future TMPDIR exceeds it.
    const sockPath = join(tempHome, 'chat-daemon.sock');
    if (sockPath.length >= 104) {
      throw new Error(`UDS socket path too long (${String(sockPath.length)} bytes): ${sockPath}`);
    }

    fakeDaemon = new FakeChatDaemon();
    await fakeDaemon.listen(sockPath);
  });

  afterEach(async () => {
    if (client) {
      await client.shutdown();
      client = null;
    }
    await fakeDaemon.close();
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Group A — MCP protocol handshake + introspection (2 cases)
  // -------------------------------------------------------------------------

  it('A1: tools/list returns 2 tools (chat_poll_inbox + chat_send), each with object inputSchema', async () => {
    client = new MCPClient({ ...process.env, OPENSQUID_HOME: tempHome });
    await client.initialize();
    const r = await client.request('tools/list');
    const result = r.result as ToolsListResult;
    expect(result.tools.map((t) => t.name).sort()).toEqual(['chat_poll_inbox', 'chat_send']);
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
    }
  }, 15000);

  it('A2: each tool schema documents its expected args', async () => {
    client = new MCPClient({ ...process.env, OPENSQUID_HOME: tempHome });
    await client.initialize();
    const r = await client.request('tools/list');
    const result = r.result as ToolsListResult;
    const poll = result.tools.find((t) => t.name === 'chat_poll_inbox');
    const send = result.tools.find((t) => t.name === 'chat_send');
    expect(poll?.inputSchema.properties).toBeDefined();
    expect(send?.inputSchema.properties).toBeDefined();
    const pollProps = poll!.inputSchema.properties!;
    const sendProps = send!.inputSchema.properties!;
    expect(Object.keys(pollProps).sort()).toEqual(['limit', 'platform', 'since']);
    expect(Object.keys(sendProps).sort()).toEqual(['channel', 'reply_to', 'text', 'thread_id']);
  }, 15000);

  // -------------------------------------------------------------------------
  // Group B — chat_poll_inbox happy paths (5 cases)
  // -------------------------------------------------------------------------

  it('B1: no active project → "No active project — …"', async () => {
    const cwdEmpty = await mkdtemp(join(tmpdir(), 'opensquid-cbt-cwd-'));
    try {
      client = new MCPClient(
        { ...process.env, OPENSQUID_HOME: tempHome, OPENSQUID_PROJECT_UUID: '' },
        cwdEmpty,
      );
      await client.initialize();
      const r = await client.request('tools/call', {
        name: 'chat_poll_inbox',
        arguments: { limit: 10 },
      });
      const text = (r.result as ToolCallResult).content[0]!.text;
      expect(text).toContain('No active project');
    } finally {
      await rm(cwdEmpty, { recursive: true, force: true });
    }
  }, 15000);

  it('B2: active project + empty inbox → "No new messages …"', async () => {
    const uuid = randomUUID();
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_poll_inbox',
      arguments: { limit: 10 },
    });
    const text = (r.result as ToolCallResult).content[0]!.text;
    expect(text).toContain('No new messages in project');
    expect(text).toContain(uuid);
  }, 15000);

  it('B3: active project + 1 message → formatted output + cursor', async () => {
    const uuid = randomUUID();
    await seedInbox(tempHome, uuid, 'telegram', [
      validInboxMsg({
        text: 'hello',
        sender: 'alice',
        enqueued_at: '2026-05-29T00:00:00Z',
      }),
    ]);
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_poll_inbox',
      arguments: { limit: 10 },
    });
    const text = (r.result as ToolCallResult).content[0]!.text;
    expect(text).toContain('[2026-05-29T00:00:00Z] telegram/-1001234 <alice> hello');
    expect(text).toContain(`Project: ${uuid}`);
    expect(text).toContain('Scanned: telegram');
    expect(text).toContain('Returned: 1');
    expect(text).toContain("Next cursor (pass as 'since'): 2026-05-29T00:00:00Z");
  }, 15000);

  it('B4: messages across 3 platforms without filter → all scanned + merged sort', async () => {
    const uuid = randomUUID();
    await seedInbox(tempHome, uuid, 'telegram', [
      validInboxMsg({ text: 'tg-1', enqueued_at: '2026-05-29T00:00:01Z', platform: 'telegram' }),
    ]);
    await seedInbox(tempHome, uuid, 'discord', [
      validInboxMsg({ text: 'dc-1', enqueued_at: '2026-05-29T00:00:00Z', platform: 'discord' }),
    ]);
    await seedInbox(tempHome, uuid, 'slack', [
      validInboxMsg({ text: 'sl-1', enqueued_at: '2026-05-29T00:00:02Z', platform: 'slack' }),
    ]);
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_poll_inbox',
      arguments: { limit: 10 },
    });
    const text = (r.result as ToolCallResult).content[0]!.text;
    expect(text).toContain('Scanned: telegram, discord, slack');
    expect(text).toContain('Returned: 3');
    // Merge-sort by enqueued_at: discord (T+0) → telegram (T+1) → slack (T+2).
    const idxDc = text.indexOf('dc-1');
    const idxTg = text.indexOf('tg-1');
    const idxSl = text.indexOf('sl-1');
    expect(idxDc).toBeGreaterThan(-1);
    expect(idxTg).toBeGreaterThan(idxDc);
    expect(idxSl).toBeGreaterThan(idxTg);
  }, 15000);

  it('B5: since cursor + limit cap → returns only the tail', async () => {
    const uuid = randomUUID();
    await seedInbox(tempHome, uuid, 'telegram', [
      validInboxMsg({ text: 'a', enqueued_at: '2026-05-29T00:00:00Z' }),
      validInboxMsg({ text: 'b', enqueued_at: '2026-05-29T00:00:01Z' }),
      validInboxMsg({ text: 'c', enqueued_at: '2026-05-29T00:00:02Z' }),
    ]);
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_poll_inbox',
      arguments: { since: '2026-05-29T00:00:00Z', limit: 1 },
    });
    const text = (r.result as ToolCallResult).content[0]!.text;
    expect(text).toContain('Returned: 1');
    expect(text).toContain('> c');
    expect(text).not.toContain('> a');
    expect(text).not.toContain('> b');
  }, 15000);

  // -------------------------------------------------------------------------
  // Group C — chat_poll_inbox edge cases (3 cases)
  // -------------------------------------------------------------------------

  it('C1: malformed JSONL line in the middle → skipped, walk continues', async () => {
    const uuid = randomUUID();
    await seedInbox(tempHome, uuid, 'telegram', [
      validInboxMsg({ text: 'first', enqueued_at: '2026-05-29T00:00:00Z' }),
      '{ not json',
      validInboxMsg({ text: 'third', enqueued_at: '2026-05-29T00:00:02Z' }),
    ]);
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_poll_inbox',
      arguments: { limit: 10 },
    });
    const text = (r.result as ToolCallResult).content[0]!.text;
    expect(text).toContain('Returned: 2');
    expect(text).toContain('first');
    expect(text).toContain('third');
  }, 15000);

  it('C2: platform filter narrows the scan to one file', async () => {
    const uuid = randomUUID();
    await seedInbox(tempHome, uuid, 'telegram', [
      validInboxMsg({ text: 'tg-only', enqueued_at: '2026-05-29T00:00:00Z' }),
    ]);
    await seedInbox(tempHome, uuid, 'discord', [
      validInboxMsg({ text: 'dc-only', enqueued_at: '2026-05-29T00:00:00Z', platform: 'discord' }),
    ]);
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_poll_inbox',
      arguments: { platform: 'telegram', limit: 10 },
    });
    const text = (r.result as ToolCallResult).content[0]!.text;
    expect(text).toContain('Scanned: telegram');
    expect(text).not.toContain('discord');
    expect(text).toContain('tg-only');
    expect(text).not.toContain('dc-only');
  }, 15000);

  it('C3: collision entry for active uuid → response carries a warning prefix', async () => {
    const uuid = randomUUID();
    const otherUuid = randomUUID();
    await seedCollisions(tempHome, [
      {
        v: 1,
        occurred_at: new Date().toISOString(),
        channel_key: 'telegram:-1001234',
        claimants: [uuid, otherUuid],
        winner_uuid: otherUuid,
        notified_via_telegram: false,
      },
    ]);
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_poll_inbox',
      arguments: { limit: 10 },
    });
    const text = (r.result as ToolCallResult).content[0]!.text;
    // L12 — contains-check on a stable phrase, NOT strict text match.
    // The full collision prefix references chat-routing.json paths that
    // vary per test HOME.
    expect(text.toLowerCase()).toMatch(/collision|chat-routing|claimant/);
  }, 15000);

  // -------------------------------------------------------------------------
  // Group D — chat_send happy w/ fake daemon (3 cases)
  // -------------------------------------------------------------------------

  it('D1: chat_send(telegram:1234, hello) → fake daemon captures + bridge returns ok', async () => {
    const uuid = randomUUID();
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_send',
      arguments: { channel: 'telegram:1234', text: 'hello' },
    });
    const text = (r.result as ToolCallResult).content[0]!.text;
    expect(text).toBe('sent to telegram:1234 — message_id=fake-123 at 2026-05-29T00:00:00Z');
    const sends = fakeDaemon.sentRequests.filter((s) => s.channel === 'telegram:1234');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({ channel: 'telegram:1234', text: 'hello' });
  }, 15000);

  it('D2: chat_send with reply_to + thread_id → payload carries both (camelCase)', async () => {
    const uuid = randomUUID();
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_send',
      arguments: {
        channel: 'telegram:1234',
        text: 'reply',
        reply_to: 'msg-X',
        thread_id: '99',
      },
    });
    expect(r.error).toBeUndefined();
    const sends = fakeDaemon.sentRequests.filter((s) => s.text === 'reply');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({
      channel: 'telegram:1234',
      text: 'reply',
      replyTo: 'msg-X',
      threadId: '99',
    });
  }, 15000);

  it('D3: project:telegram shorthand resolves via chat-routing.json', async () => {
    const uuid = randomUUID();
    await seedChatRouting(tempHome, uuid, {
      telegram: { report_channel: '-1009876', report_topic_id: 42 },
    });
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_send',
      arguments: { channel: 'project:telegram', text: 'shorthand' },
    });
    expect(r.error).toBeUndefined();
    const sends = fakeDaemon.sentRequests.filter((s) => s.text === 'shorthand');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({
      channel: '-1009876',
      text: 'shorthand',
      threadId: '42',
    });
  }, 15000);

  // -------------------------------------------------------------------------
  // Group E — chat_send error paths (3 cases)
  // -------------------------------------------------------------------------

  it('E1: daemon socket missing → unreachable / timeout error surface', async () => {
    // Tear down the fake daemon BEFORE the call so the connect fails.
    await fakeDaemon.close();
    const uuid = randomUUID();
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_send',
      arguments: { channel: 'telegram:1234', text: 'unreachable' },
    });
    const surface = surfaceText(r).toLowerCase();
    expect(surface).toMatch(/unreachable|chat-daemon|timeout|connect|enoent|refused/);
  }, 15000);

  it('E2: project:<unknown-platform> → unknown shorthand error', async () => {
    const uuid = randomUUID();
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_send',
      arguments: { channel: 'project:imap', text: 'nope' },
    });
    const surface = surfaceText(r).toLowerCase();
    expect(surface).toContain('unknown project shorthand');
    // Did not reach the daemon — no captured send for this payload.
    expect(fakeDaemon.sentRequests.filter((s) => s.text === 'nope')).toHaveLength(0);
  }, 15000);

  it('E3: project:telegram with no active project → "cannot resolve" error', async () => {
    const cwdEmpty = await mkdtemp(join(tmpdir(), 'opensquid-cbt-cwd-'));
    try {
      client = new MCPClient(
        { ...process.env, OPENSQUID_HOME: tempHome, OPENSQUID_PROJECT_UUID: '' },
        cwdEmpty,
      );
      await client.initialize();
      const r = await client.request('tools/call', {
        name: 'chat_send',
        arguments: { channel: 'project:telegram', text: 'noproject' },
      });
      const surface = surfaceText(r).toLowerCase();
      expect(surface).toContain('cannot resolve project');
      expect(fakeDaemon.sentRequests.filter((s) => s.text === 'noproject')).toHaveLength(0);
    } finally {
      await rm(cwdEmpty, { recursive: true, force: true });
    }
  }, 15000);

  // -------------------------------------------------------------------------
  // Group F — schema validation (2 cases)
  // -------------------------------------------------------------------------

  it('F1: chat_send({}) (missing required channel + text) → SDK reports the missing args', async () => {
    const uuid = randomUUID();
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', { name: 'chat_send', arguments: {} });
    // The MCP SDK may serialize Zod validation as a JSON-RPC -32602 error
    // OR as `result.isError === true` with content text. Accept either; in
    // both envelopes the surfaced text must mention at least one missing
    // required field.
    const surface = surfaceText(r).toLowerCase();
    expect(surface).toMatch(/channel|text|required|invalid/);
  }, 15000);

  it('F2: chat_poll_inbox({limit: -5}) → Zod limit-bounds violation surfaces', async () => {
    const uuid = randomUUID();
    client = new MCPClient({
      ...process.env,
      OPENSQUID_HOME: tempHome,
      OPENSQUID_PROJECT_UUID: uuid,
    });
    await client.initialize();
    const r = await client.request('tools/call', {
      name: 'chat_poll_inbox',
      arguments: { limit: -5 },
    });
    const surface = surfaceText(r).toLowerCase();
    expect(surface).toMatch(/limit|invalid|min|greater|small/);
  }, 15000);
});
