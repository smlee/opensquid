/**
 * inbox-read.test.ts — pollInbox happy paths (v0.7.1 Phase E).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../gateway.js";
import { appendToInbox } from "./inbox.js";
import { pollInbox } from "./inbox-read.js";

let tmpRoot: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensquid-inbox-read-test-"));
  prevHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = tmpRoot;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prevHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    platform: "telegram",
    channel: "telegram:100",
    sender: "u",
    senderId: "100",
    text: "hello",
    receivedAt: new Date("2026-05-16T10:00:00Z"),
    mentionsBot: false,
    ...overrides,
  };
}

describe("pollInbox", () => {
  it("returns empty messages + empty platforms list when inbox dir is missing", async () => {
    const r = await pollInbox({ projectUuid: "no-such-uuid", dataRoot: tmpRoot });
    expect(r.messages).toEqual([]);
    expect(r.scanned_platforms).toEqual([]);
  });

  it("returns messages from a single platform inbox", async () => {
    await appendToInbox(makeMsg({ id: "a", text: "first" }), "uuid-1", tmpRoot);
    await appendToInbox(makeMsg({ id: "b", text: "second" }), "uuid-1", tmpRoot);

    const r = await pollInbox({ projectUuid: "uuid-1", dataRoot: tmpRoot });
    expect(r.messages.length).toBe(2);
    expect(r.messages[0].id).toBe("a");
    expect(r.messages[1].id).toBe("b");
    expect(r.scanned_platforms).toEqual(["telegram"]);
  });

  it("scans all platforms when `platform` is omitted", async () => {
    await appendToInbox(
      makeMsg({ platform: "telegram", channel: "telegram:1" }),
      "uuid-2",
      tmpRoot,
    );
    await appendToInbox(makeMsg({ platform: "discord", channel: "discord:2" }), "uuid-2", tmpRoot);
    const r = await pollInbox({ projectUuid: "uuid-2", dataRoot: tmpRoot });
    expect(r.messages.length).toBe(2);
    expect(r.scanned_platforms).toEqual(expect.arrayContaining(["telegram", "discord"]));
  });

  it("restricts to a single platform when `platform` is given", async () => {
    await appendToInbox(
      makeMsg({ platform: "telegram", channel: "telegram:1" }),
      "uuid-3",
      tmpRoot,
    );
    await appendToInbox(makeMsg({ platform: "discord", channel: "discord:2" }), "uuid-3", tmpRoot);
    const r = await pollInbox({ projectUuid: "uuid-3", platform: "discord", dataRoot: tmpRoot });
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].platform).toBe("discord");
    expect(r.scanned_platforms).toEqual(["discord"]);
  });

  it("honors limit (returns the tail)", async () => {
    for (let i = 0; i < 5; i++) {
      await appendToInbox(makeMsg({ id: `m${i}` }), "uuid-4", tmpRoot);
    }
    const r = await pollInbox({ projectUuid: "uuid-4", limit: 2, dataRoot: tmpRoot });
    expect(r.messages.length).toBe(2);
    // Last two by chronological order.
    expect(r.messages[0].id).toBe("m3");
    expect(r.messages[1].id).toBe("m4");
  });

  it("filters by `since` (strict greater-than on enqueued_at)", async () => {
    await appendToInbox(makeMsg({ id: "x" }), "uuid-5", tmpRoot);
    // Small wait so enqueued_at differs.
    await new Promise((r) => setTimeout(r, 5));
    const marker = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await appendToInbox(makeMsg({ id: "y" }), "uuid-5", tmpRoot);

    const r = await pollInbox({ projectUuid: "uuid-5", since: marker, dataRoot: tmpRoot });
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].id).toBe("y");
  });

  it("survives a malformed line in the inbox (skips it, returns valid ones)", async () => {
    await appendToInbox(makeMsg({ id: "good-1" }), "uuid-6", tmpRoot);
    // Append a broken line by writing directly.
    const inboxFile = path.join(tmpRoot, "projects", "uuid-6", "inbox", "telegram.jsonl");
    await fs.appendFile(inboxFile, "{ not json\n");
    await appendToInbox(makeMsg({ id: "good-2" }), "uuid-6", tmpRoot);
    const r = await pollInbox({ projectUuid: "uuid-6", dataRoot: tmpRoot });
    expect(r.messages.map((m) => m.id)).toEqual(["good-1", "good-2"]);
  });
});
