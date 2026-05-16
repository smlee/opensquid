/**
 * inbox.ts tests (v0.7.1 Phase C) — exercise appendToInbox end-to-end
 * (real files, real JSONL parsing) so the wire format AND the
 * project/orphan routing decision are both covered.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../gateway.js";
import { appendToInbox } from "./inbox.js";
import { orphanInboxDir, projectInboxDir } from "./routing.js";

let tmpRoot: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensquid-inbox-test-"));
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
    id: "msg-1",
    platform: "telegram",
    channel: "telegram:8075471258",
    sender: "tester",
    senderId: "8075471258",
    text: "hello inbox",
    receivedAt: new Date("2026-05-16T10:00:00Z"),
    mentionsBot: false,
    ...overrides,
  };
}

describe("appendToInbox — project path", () => {
  it("writes a JSONL line into projects/<uuid>/inbox/<platform>.jsonl", async () => {
    const res = await appendToInbox(makeMsg(), "uuid-x", tmpRoot);
    expect(res.destination).toBe("project");
    expect(res.project_uuid).toBe("uuid-x");
    expect(res.inbox_path).toBe(path.join(projectInboxDir("uuid-x", tmpRoot), "telegram.jsonl"));

    const content = await fs.readFile(res.inbox_path, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(content.trim());
    expect(parsed.v).toBe(1);
    expect(parsed.id).toBe("msg-1");
    expect(parsed.platform).toBe("telegram");
    expect(parsed.channel).toBe("telegram:8075471258");
    expect(parsed.text).toBe("hello inbox");
    expect(parsed.received_at).toBe("2026-05-16T10:00:00.000Z");
    expect(parsed.enqueued_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.mentions_bot).toBe(false);
  });

  it("appends multiple lines, one per message", async () => {
    const res = await appendToInbox(makeMsg({ id: "a" }), "uuid-y", tmpRoot);
    await appendToInbox(makeMsg({ id: "b", text: "second" }), "uuid-y", tmpRoot);

    const content = await fs.readFile(res.inbox_path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).id).toBe("a");
    expect(JSON.parse(lines[1]).id).toBe("b");
  });

  it("separates inboxes by platform", async () => {
    await appendToInbox(
      makeMsg({ platform: "telegram", channel: "telegram:1" }),
      "uuid-z",
      tmpRoot,
    );
    await appendToInbox(makeMsg({ platform: "discord", channel: "discord:2" }), "uuid-z", tmpRoot);
    const dir = projectInboxDir("uuid-z", tmpRoot);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(expect.arrayContaining(["telegram.jsonl", "discord.jsonl"]));
  });
});

describe("appendToInbox — orphan path", () => {
  it("writes to <dataRoot>/inbox/orphan/<platform>.jsonl when projectUuid is null", async () => {
    const res = await appendToInbox(makeMsg(), null, tmpRoot);
    expect(res.destination).toBe("orphan");
    expect(res.project_uuid).toBeUndefined();
    expect(res.inbox_path).toBe(path.join(orphanInboxDir(tmpRoot), "telegram.jsonl"));
    const exists = await fs
      .stat(res.inbox_path)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });
});

describe("appendToInbox — line format details", () => {
  it("preserves mentions_bot flag", async () => {
    const res = await appendToInbox(makeMsg({ mentionsBot: true }), "uuid-m", tmpRoot);
    const line = (await fs.readFile(res.inbox_path, "utf8")).trim();
    const parsed = JSON.parse(line);
    expect(parsed.mentions_bot).toBe(true);
  });

  it("preserves sender_id (native id) separately from display sender", async () => {
    const res = await appendToInbox(
      makeMsg({ sender: "Display Name", senderId: "native-987" }),
      "uuid-s",
      tmpRoot,
    );
    const line = (await fs.readFile(res.inbox_path, "utf8")).trim();
    const parsed = JSON.parse(line);
    expect(parsed.sender).toBe("Display Name");
    expect(parsed.sender_id).toBe("native-987");
  });

  it("handles multi-line text without breaking JSONL framing", async () => {
    // JSON.stringify escapes newlines as \\n; one logical line on disk.
    const res = await appendToInbox(
      makeMsg({ text: "line one\nline two\nline three" }),
      "uuid-multi",
      tmpRoot,
    );
    const content = await fs.readFile(res.inbox_path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.text).toBe("line one\nline two\nline three");
  });
});
