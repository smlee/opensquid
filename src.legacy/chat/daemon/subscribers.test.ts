/**
 * subscribers.ts unit tests — TPS.6 patch 1 (v0.5.125).
 *
 * Covers spec tests #1-#7 (subscribers.test.ts plan) + idempotent
 * re-register + auto-eviction on socket.close.
 *
 * Socket is faked with a thin EventEmitter-backed stub — no real net
 * server. The stub exposes the write/close/error/drain events the
 * registry attaches to, plus a write() that records calls and lets
 * tests force the "buffer full" path.
 */

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SUBSCRIBER_QUEUE_CAP,
  SubscriberRegistry,
} from "./subscribers.js";
import type { InboundMessageNotification } from "./protocol.js";

interface FakeSocket extends EventEmitter {
  writes: string[];
  writeReturn: boolean;
  ended: boolean;
  write(line: string): boolean;
  end(): void;
}

function makeFakeSocket(): FakeSocket {
  const sock = new EventEmitter() as FakeSocket;
  sock.writes = [];
  sock.writeReturn = true;
  sock.ended = false;
  sock.write = (line: string): boolean => {
    sock.writes.push(line);
    return sock.writeReturn;
  };
  sock.end = (): void => {
    sock.ended = true;
    sock.emit("close");
  };
  return sock;
}

function exampleNotification(overrides?: Partial<InboundMessageNotification["params"]>): InboundMessageNotification {
  return {
    jsonrpc: "2.0",
    method: "inbound_message",
    params: {
      delivery_id: "d-1",
      message_id: "m-1",
      platform: "telegram",
      channel: "telegram:-100",
      sender: "alice",
      sender_id: "111",
      text: "hi",
      received_at: "2026-05-23T19:00:00Z",
      mentions_bot: false,
      ...overrides,
    },
  };
}

let registry: SubscriberRegistry;
let stderrCalls: string[];
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  registry = new SubscriberRegistry();
  // Silence + capture stderr to keep test output clean.
  stderrCalls = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrCalls.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

// ---------------------------------------------------------------------
// #1 Register + lookup by chat_id
// ---------------------------------------------------------------------

describe("SubscriberRegistry — register + forChatId", () => {
  it("1: single subscriber single chat_id is returned by forChatId", () => {
    const sock = makeFakeSocket();
    const record = registry.register({
      session_id: "s1",
      workspace_uuid: "uuid-a",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: sock,
    });
    expect(record.wildcard).toBe(false);
    expect(registry.forChatId("telegram:-100")).toHaveLength(1);
    expect(registry.forChatId("telegram:-100")[0]?.session_id).toBe("s1");
    expect(registry.forChatId("telegram:-200")).toHaveLength(0);
  });

  it("2: wildcard subscriber (chat_ids=[]) matches any chat_id", () => {
    const sock = makeFakeSocket();
    registry.register({
      session_id: "wild",
      workspace_uuid: "uuid-w",
      workspace_path: "/y",
      chat_ids: [],
      socket: sock,
    });
    expect(registry.forChatId("telegram:any")).toHaveLength(1);
    expect(registry.forChatId("telegram:other")).toHaveLength(1);
    expect(registry.get("wild")?.wildcard).toBe(true);
  });

  it("3: N subscribers for same chat_id all surface in forChatId", () => {
    for (let i = 0; i < 3; i++) {
      registry.register({
        session_id: `s${String(i)}`,
        workspace_uuid: `u${String(i)}`,
        workspace_path: "/x",
        chat_ids: ["telegram:-100"],
        socket: makeFakeSocket(),
      });
    }
    expect(registry.forChatId("telegram:-100")).toHaveLength(3);
  });

  it("4: subscribers for different chat_ids stay independent", () => {
    registry.register({
      session_id: "sa",
      workspace_uuid: "ua",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: makeFakeSocket(),
    });
    registry.register({
      session_id: "sb",
      workspace_uuid: "ub",
      workspace_path: "/y",
      chat_ids: ["telegram:-200"],
      socket: makeFakeSocket(),
    });
    expect(registry.forChatId("telegram:-100").map((s) => s.session_id)).toEqual(["sa"]);
    expect(registry.forChatId("telegram:-200").map((s) => s.session_id)).toEqual(["sb"]);
  });
});

// ---------------------------------------------------------------------
// #5 Unregister
// ---------------------------------------------------------------------

describe("SubscriberRegistry — unregister", () => {
  it("5: explicit unregister removes from both indexes", () => {
    registry.register({
      session_id: "sa",
      workspace_uuid: "ua",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: makeFakeSocket(),
    });
    expect(registry.unregister("sa")).toBe(true);
    expect(registry.get("sa")).toBeUndefined();
    expect(registry.forChatId("telegram:-100")).toHaveLength(0);
    expect(registry.unregister("sa")).toBe(false); // idempotent
  });
});

// ---------------------------------------------------------------------
// #6 Re-register same session_id evicts old slot + closes old socket
// ---------------------------------------------------------------------

describe("SubscriberRegistry — idempotent re-register", () => {
  it("6: re-register on the same session_id replaces the slot and closes old socket", () => {
    const oldSock = makeFakeSocket();
    const newSock = makeFakeSocket();
    registry.register({
      session_id: "shared",
      workspace_uuid: "u",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: oldSock,
    });
    registry.register({
      session_id: "shared",
      workspace_uuid: "u",
      workspace_path: "/x",
      chat_ids: ["telegram:-200"],
      socket: newSock,
    });
    expect(oldSock.ended).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.forChatId("telegram:-100")).toHaveLength(0);
    expect(registry.forChatId("telegram:-200")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// #7 Auto-eviction on socket close / error
// ---------------------------------------------------------------------

describe("SubscriberRegistry — auto-eviction on socket events", () => {
  it("7a: socket 'close' triggers unregister", () => {
    const sock = makeFakeSocket();
    registry.register({
      session_id: "sa",
      workspace_uuid: "u",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: sock,
    });
    sock.emit("close");
    expect(registry.get("sa")).toBeUndefined();
    expect(registry.forChatId("telegram:-100")).toHaveLength(0);
  });

  it("7b: socket 'error' triggers unregister", () => {
    const sock = makeFakeSocket();
    registry.register({
      session_id: "sa",
      workspace_uuid: "u",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: sock,
    });
    sock.emit("error", new Error("boom"));
    expect(registry.get("sa")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Broadcast + push + backpressure
// ---------------------------------------------------------------------

describe("SubscriberRegistry — broadcast + backpressure", () => {
  it("broadcast writes the notification to every matching subscriber", () => {
    const sa = makeFakeSocket();
    const sb = makeFakeSocket();
    const sc = makeFakeSocket();
    registry.register({
      session_id: "sa",
      workspace_uuid: "ua",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: sa,
    });
    registry.register({
      session_id: "sb",
      workspace_uuid: "ub",
      workspace_path: "/y",
      chat_ids: ["telegram:-100"],
      socket: sb,
    });
    registry.register({
      session_id: "sc",
      workspace_uuid: "uc",
      workspace_path: "/z",
      chat_ids: ["telegram:-999"],
      socket: sc,
    });
    const count = registry.broadcast("telegram:-100", exampleNotification());
    expect(count).toBe(2);
    expect(sa.writes).toHaveLength(1);
    expect(sb.writes).toHaveLength(1);
    expect(sc.writes).toHaveLength(0);
  });

  it("write returning false queues subsequent notifications until 'drain'", () => {
    const sock = makeFakeSocket();
    sock.writeReturn = false;
    registry.register({
      session_id: "s1",
      workspace_uuid: "u",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: sock,
    });
    // First push hits the wire; second + third get queued.
    registry.push("s1", exampleNotification({ delivery_id: "d-A" }));
    registry.push("s1", exampleNotification({ delivery_id: "d-B" }));
    registry.push("s1", exampleNotification({ delivery_id: "d-C" }));
    expect(sock.writes).toHaveLength(1);
    expect(sock.writes[0]).toContain("d-A");
    sock.writeReturn = true;
    sock.emit("drain");
    expect(sock.writes).toHaveLength(3);
    expect(sock.writes[1]).toContain("d-B");
    expect(sock.writes[2]).toContain("d-C");
  });

  it("queue overflow drops oldest beyond SUBSCRIBER_QUEUE_CAP + records dropped_count", () => {
    const sock = makeFakeSocket();
    sock.writeReturn = false;
    const record = registry.register({
      session_id: "s1",
      workspace_uuid: "u",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: sock,
    });
    for (let i = 0; i < SUBSCRIBER_QUEUE_CAP + 5; i++) {
      registry.push("s1", exampleNotification({ delivery_id: `d-${String(i)}` }));
    }
    expect(record.dropped_count).toBeGreaterThanOrEqual(4);
    expect(stderrCalls.some((c) => c.includes("queue overflow"))).toBe(true);
  });

  it("shutdown notifies + closes all subscribers", () => {
    const sa = makeFakeSocket();
    const sb = makeFakeSocket();
    registry.register({
      session_id: "sa",
      workspace_uuid: "ua",
      workspace_path: "/x",
      chat_ids: ["telegram:-100"],
      socket: sa,
    });
    registry.register({
      session_id: "sb",
      workspace_uuid: "ub",
      workspace_path: "/y",
      chat_ids: [],
      socket: sb,
    });
    registry.shutdown("SIGTERM");
    expect(sa.writes.some((w) => w.includes("daemon_shutdown"))).toBe(true);
    expect(sb.writes.some((w) => w.includes("daemon_shutdown"))).toBe(true);
    expect(sa.ended).toBe(true);
    expect(sb.ended).toBe(true);
    // After shutdown, the close event from end() also unregisters.
    expect(registry.size()).toBe(0);
  });
});
