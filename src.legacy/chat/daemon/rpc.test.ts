/**
 * RPC server + client integration tests (v0.7.1 Phase B).
 *
 * Exercise the full wire path: real Unix socket / named pipe, real
 * JSON-RPC framing, real client → server round-trip. Stubs the gateway
 * with a tiny fake so the test doesn't need bot tokens. The protocol
 * IS the contract here, so synthetic transport would prove nothing.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ChatAdapter,
  ChannelId,
  ChatPlatform,
  MessageHandler,
  OutboundMessage,
  SendResult as GatewaySendResult,
} from "../gateway.js";
import { ChatGateway } from "../gateway.js";
import { TopicGoneError } from "../adapters/telegram.js";
import { loadAllTopicGoneEvents } from "./collisions.js";
import { saveProjectChatRouting, loadProjectChatRouting } from "./routing.js";
import { DaemonClient, DaemonRpcError, DaemonUnreachableError } from "./rpc-client.js";
import { daemonSockAddress } from "./protocol.js";
import { RpcServer } from "./rpc-server.js";

class StubAdapter implements ChatAdapter {
  readonly platform: ChatPlatform;
  constructor(platform: ChatPlatform) {
    this.platform = platform;
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  onMessage(_: MessageHandler): void {
    /* noop */
  }
  send(msg: OutboundMessage): Promise<GatewaySendResult> {
    return Promise.resolve({
      platform: this.platform,
      channel: msg.channel as ChannelId,
      messageId: `stub-${Date.now()}`,
      deliveredAt: new Date(),
    });
  }
  identity(): Promise<{ username: string; nativeId: string }> {
    return Promise.resolve({ username: `stub-${this.platform}`, nativeId: "0" });
  }
}

let tmpRoot: string;
let server: RpcServer;
let prevOpensquidHome: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensquid-rpc-test-"));
  // The protocol's address calculation looks at process.env.OPENSQUID_HOME
  // via daemonPaths → resolveDataRoot. Set it for the duration of the
  // test so the client and server resolve the same address.
  prevOpensquidHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = tmpRoot;
});

afterEach(async () => {
  if (server) {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  }
  if (prevOpensquidHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prevOpensquidHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("daemonSockAddress", () => {
  it("returns a filesystem path on POSIX, named pipe on Windows", () => {
    const addr = daemonSockAddress(tmpRoot);
    if (os.platform() === "win32") {
      expect(addr).toMatch(/^\\\\\.\\pipe\\opensquid-chat-daemon-/);
    } else {
      expect(addr).toBe(path.join(tmpRoot, "chat-daemon.sock"));
    }
  });
});

describe("RpcServer + DaemonClient round-trip", () => {
  it("ping returns pong, pid, and version", async () => {
    const gw = new ChatGateway([new StubAdapter("telegram")]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot, version: "test-v1" });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    const res = await client.ping();
    expect(res.pong).toBe(true);
    expect(res.pid).toBe(process.pid);
    expect(res.version).toBe("test-v1");
  });

  it("list_channels surfaces the gateway's active platforms", async () => {
    const gw = new ChatGateway([new StubAdapter("telegram"), new StubAdapter("discord")]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    const res = await client.listChannels();
    expect(res.active_platforms).toEqual(expect.arrayContaining(["telegram", "discord"]));
    expect(res.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it("send delegates to gateway.send and returns the message id + delivery time", async () => {
    const gw = new ChatGateway([new StubAdapter("telegram")]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    const res = await client.send({ channel: "telegram:12345", text: "hello world" });
    expect(res.ok).toBe(true);
    expect(res.platform).toBe("telegram");
    expect(res.message_id).toMatch(/^stub-/);
    expect(res.delivered_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("send with missing params returns INVALID_PARAMS (-32602)", async () => {
    const gw = new ChatGateway([new StubAdapter("telegram")]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    await expect(client.call("send", {})).rejects.toMatchObject({
      name: "DaemonRpcError",
      code: -32602,
    });
  });

  it("unknown method returns METHOD_NOT_FOUND (-32601)", async () => {
    const gw = new ChatGateway([new StubAdapter("telegram")]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    await expect(client.call("does_not_exist", {})).rejects.toMatchObject({
      name: "DaemonRpcError",
      code: -32601,
    });
  });

  it("pipelines multiple requests on independent connections", async () => {
    const gw = new ChatGateway([new StubAdapter("telegram")]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    const results = await Promise.all([client.ping(), client.ping(), client.ping()]);
    expect(results.length).toBe(3);
    for (const r of results) expect(r.pong).toBe(true);
  });

  it("DaemonUnreachableError when no server is listening", async () => {
    // Don't start the server.
    const client = new DaemonClient({ dataRoot: tmpRoot, connectTimeoutMs: 250 });
    await expect(client.ping()).rejects.toBeInstanceOf(DaemonUnreachableError);
  });

  it("DaemonUnreachableError after server.close()", async () => {
    const gw = new ChatGateway([new StubAdapter("telegram")]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();
    await server.close();

    const client = new DaemonClient({ dataRoot: tmpRoot, connectTimeoutMs: 250 });
    await expect(client.ping()).rejects.toBeInstanceOf(DaemonUnreachableError);
  });

  it("DaemonRpcError surfaces both the message and the code", async () => {
    const gw = new ChatGateway([new StubAdapter("telegram")]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    try {
      await client.call("does_not_exist", {});
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonRpcError);
      expect((err as DaemonRpcError).code).toBe(-32601);
      expect((err as DaemonRpcError).message).toContain("unknown method");
    }
  });
});

// =====================================================================
// TPS.7 (v0.5.130) — send → TopicGoneError → handleTopicGone recovery
// =====================================================================

/**
 * Stub adapter that throws a TopicGoneError on every send. Used to
 * exercise the daemon's stale-topic recovery path end-to-end (real UDS
 * round-trip, real recovery, real JSONL append).
 */
class TopicGoneAdapter implements ChatAdapter {
  readonly platform: ChatPlatform = "telegram";
  constructor(
    private readonly chatId: string,
    private readonly topicId: number,
  ) {}
  start(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  onMessage(_: MessageHandler): void {
    /* noop */
  }
  send(_: OutboundMessage): Promise<GatewaySendResult> {
    return Promise.reject(
      new TopicGoneError(
        "Bad Request: message thread not found",
        this.chatId,
        this.topicId,
        new Error("synthetic"),
      ),
    );
  }
  identity(): Promise<{ username: string; nativeId: string }> {
    return Promise.resolve({ username: "stub-tg", nativeId: "0" });
  }
}

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await check();
    if (r !== null) return r;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("RpcServer.handleTopicGone (TPS.7)", () => {
  it("clears the bound workspace's binding + writes a topic_gone event when send throws TopicGoneError", async () => {
    // Seed a project whose auto_bound matches what the adapter will
    // report as gone.
    const uuid = "uuid-stale";
    await saveProjectChatRouting(
      uuid,
      {
        telegram: {
          report_channel: "-1001234567890",
          inbound_chat_ids: ["-1001234567890"],
          inbound_topic_ids: [42],
          auto_bound: {
            workspace_path: "/x",
            workspace_uuid: uuid,
            topic_id: 42,
            topic_name: "stale · uuid-sta",
            created_at: "2026-05-22T00:00:00Z",
            created_by: "auto-boot",
          },
        },
      },
      tmpRoot,
    );

    const gw = new ChatGateway([new TopicGoneAdapter("-1001234567890", 42)]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    // The send itself fails (caller gets the original failure).
    await expect(
      client.send({ channel: "telegram:-1001234567890:42", text: "doomed" }),
    ).rejects.toBeInstanceOf(DaemonRpcError);

    // Recovery is fire-and-forget — wait for the binding to be cleared.
    const cleared = await waitFor(async () => {
      const r = await loadProjectChatRouting(uuid, tmpRoot);
      return r?.telegram?.auto_bound === undefined ? true : null;
    });
    expect(cleared).toBe(true);

    // A topic_gone event landed in collisions.jsonl.
    const events = await loadAllTopicGoneEvents(tmpRoot);
    expect(events.length).toBe(1);
    expect(events[0]?.workspace_uuid).toBe(uuid);
    expect(events[0]?.chat_id).toBe("-1001234567890");
    expect(events[0]?.topic_id).toBe(42);
  });

  it("does NOTHING when no project owns the (chat_id, topic_id) — no orphan binding to clean", async () => {
    // No projects seeded.
    const gw = new ChatGateway([new TopicGoneAdapter("-1001234567890", 999)]);
    await gw.start();
    server = new RpcServer({ gateway: gw, dataRoot: tmpRoot });
    await server.listen();

    const client = new DaemonClient({ dataRoot: tmpRoot });
    await expect(
      client.send({ channel: "telegram:-1001234567890:999", text: "orphan" }),
    ).rejects.toBeInstanceOf(DaemonRpcError);

    // Recovery runs but finds no owner → no JSONL write, no error
    // propagated. Give it ~200ms to settle then assert empty.
    await new Promise((r) => setTimeout(r, 200));
    const events = await loadAllTopicGoneEvents(tmpRoot);
    expect(events.length).toBe(0);
  });
});
