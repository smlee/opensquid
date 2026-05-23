/**
 * collisions.ts unit tests — TPS.5 (v0.5.124).
 *
 * Coverage matches the spec's tests-planned list:
 *   1. Record + format
 *   2. Debounce within window
 *   3. Debounce escape
 *   4. Different channel_keys
 *   5. Daemon-restart preserves debounce
 *   6. notifyCollision failure does not block JSONL write
 *   7. No report_channel configured
 *   8. getRecentCollisions filtered tail
 *   9. Malformed line in JSONL
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEBOUNCE_WINDOW_MS,
  collisionsPath,
  getRecentCollisions,
  loadAllCollisions,
  recordCollision,
  type CollisionEntry,
} from "./collisions.js";
import { saveProjectChatRouting } from "./routing.js";
import type { CollisionInfo } from "./routing.js";
import type { ChatGateway } from "../gateway.js";

let tmpRoot: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensquid-tps5-"));
  prevHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = tmpRoot;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prevHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const exampleInfo: CollisionInfo = {
  channel_key: "telegram:-1001234567890:15",
  existing_uuid: "uuid-a",
  newcomer_uuid: "uuid-b",
};

// Minimal gateway stub: records calls, returns a fake SendResult.
interface FakeGateway {
  sent: { channel: string; text: string; threadId?: string }[];
  shouldThrow: boolean;
  asChatGateway(): ChatGateway;
}
function makeFakeGateway(): FakeGateway {
  const fake: FakeGateway = {
    sent: [],
    shouldThrow: false,
    asChatGateway(): ChatGateway {
      const stub = {
        send: async (msg: { channel: string; text: string; threadId?: string }) => {
          if (fake.shouldThrow) throw new Error("simulated gateway failure");
          fake.sent.push(msg);
          return {
            platform: "telegram" as const,
            messageId: "fake-mid",
            deliveredAt: new Date(),
          };
        },
      } as unknown as ChatGateway;
      return stub;
    },
  };
  return fake;
}

// ---------------------------------------------------------------------
// 1. record + format
// ---------------------------------------------------------------------

describe("recordCollision — record + format", () => {
  it("writes a well-formed JSONL line with v=1 + claimants + winner", async () => {
    const entry = await recordCollision({ info: exampleInfo });
    expect(entry.v).toBe(1);
    expect(entry.channel_key).toBe(exampleInfo.channel_key);
    expect(entry.claimants).toEqual(["uuid-a", "uuid-b"]);
    expect(entry.winner_uuid).toBe("uuid-b");
    expect(entry.notified_via_telegram).toBe(false); // no gateway
    expect(Number.isFinite(Date.parse(entry.occurred_at))).toBe(true);

    // File on disk matches.
    const raw = await fs.readFile(collisionsPath(), "utf8");
    expect(raw.trim().split("\n").length).toBe(1);
    const parsed = JSON.parse(raw.trim()) as CollisionEntry;
    expect(parsed.channel_key).toBe(exampleInfo.channel_key);
  });
});

// ---------------------------------------------------------------------
// 2 + 3. debounce within / escape window
// ---------------------------------------------------------------------

describe("recordCollision — debounce", () => {
  it("2: second call within 60 min does NOT notify, but JSONL line still appended", async () => {
    const fake = makeFakeGateway();
    await seedProjectWithReportChannel("uuid-a");
    // First call — should notify.
    const e1 = await recordCollision({
      info: exampleInfo,
      gateway: fake.asChatGateway(),
      nowMs: () => 1_000_000,
    });
    expect(e1.notified_via_telegram).toBe(true);
    expect(fake.sent.length).toBe(1);
    // Second call 1ms later — within debounce window.
    const e2 = await recordCollision({
      info: exampleInfo,
      gateway: fake.asChatGateway(),
      nowMs: () => 1_000_001,
    });
    expect(e2.notified_via_telegram).toBe(false);
    expect(fake.sent.length).toBe(1); // no second send
    // Both records on disk.
    const all = await loadAllCollisions();
    expect(all.length).toBe(2);
  });

  it("3: second call AFTER 60 min escapes debounce + notifies again", async () => {
    const fake = makeFakeGateway();
    await seedProjectWithReportChannel("uuid-a");
    const t0 = 5_000_000_000;
    await recordCollision({
      info: exampleInfo,
      gateway: fake.asChatGateway(),
      nowMs: () => t0,
    });
    expect(fake.sent.length).toBe(1);
    // 61 min later.
    const e2 = await recordCollision({
      info: exampleInfo,
      gateway: fake.asChatGateway(),
      nowMs: () => t0 + DEBOUNCE_WINDOW_MS + 1,
    });
    expect(e2.notified_via_telegram).toBe(true);
    expect(fake.sent.length).toBe(2);
  });

  it("4: different channel_keys have independent debounce windows", async () => {
    const fake = makeFakeGateway();
    await seedProjectWithReportChannel("uuid-a");
    await recordCollision({
      info: exampleInfo,
      gateway: fake.asChatGateway(),
      nowMs: () => 100,
    });
    await recordCollision({
      info: { ...exampleInfo, channel_key: "telegram:-100other" },
      gateway: fake.asChatGateway(),
      nowMs: () => 101,
    });
    expect(fake.sent.length).toBe(2);
  });

  it("5: daemon-restart preserves debounce (state derived from JSONL)", async () => {
    const fake1 = makeFakeGateway();
    const fake2 = makeFakeGateway(); // simulate restart with fresh gateway instance
    await seedProjectWithReportChannel("uuid-a");
    const t0 = 9_000_000_000;
    await recordCollision({
      info: exampleInfo,
      gateway: fake1.asChatGateway(),
      nowMs: () => t0,
    });
    expect(fake1.sent.length).toBe(1);
    // Simulate restart: brand-new gateway, 30 min later.
    const e2 = await recordCollision({
      info: exampleInfo,
      gateway: fake2.asChatGateway(),
      nowMs: () => t0 + 30 * 60 * 1000,
    });
    expect(e2.notified_via_telegram).toBe(false);
    expect(fake2.sent.length).toBe(0); // debounce honored across "restart"
  });
});

// ---------------------------------------------------------------------
// 6 + 7. failure isolation
// ---------------------------------------------------------------------

describe("recordCollision — failure isolation", () => {
  it("6: gateway send failure does not block JSONL write", async () => {
    const fake = makeFakeGateway();
    fake.shouldThrow = true;
    await seedProjectWithReportChannel("uuid-a");
    const entry = await recordCollision({
      info: exampleInfo,
      gateway: fake.asChatGateway(),
    });
    expect(entry.notified_via_telegram).toBe(false);
    const all = await loadAllCollisions();
    expect(all.length).toBe(1);
    expect(all[0]?.channel_key).toBe(exampleInfo.channel_key);
  });

  it("7: no report_channel configured → no notify, JSONL still writes", async () => {
    const fake = makeFakeGateway();
    // No projects with report_channel.
    const entry = await recordCollision({
      info: exampleInfo,
      gateway: fake.asChatGateway(),
    });
    expect(entry.notified_via_telegram).toBe(false);
    expect(fake.sent.length).toBe(0);
    expect((await loadAllCollisions()).length).toBe(1);
  });
});

// ---------------------------------------------------------------------
// 8 + 9. read path (used by MCP)
// ---------------------------------------------------------------------

describe("getRecentCollisions / loadAllCollisions — read path", () => {
  it("8: getRecentCollisions filters by maxAgeMinutes", async () => {
    await recordCollision({
      info: exampleInfo,
      nowMs: () => Date.now() - 25 * 60 * 60 * 1000, // 25h ago
    });
    await recordCollision({
      info: { ...exampleInfo, channel_key: "telegram:-100recent" },
      nowMs: () => Date.now() - 10 * 60 * 1000, // 10min ago
    });
    const recent = await getRecentCollisions(24 * 60); // 24h window
    expect(recent.length).toBe(1);
    expect(recent[0]?.channel_key).toBe("telegram:-100recent");
  });

  it("9: malformed line is skipped on read", async () => {
    await recordCollision({ info: exampleInfo });
    // Corrupt the file by appending a malformed line.
    await fs.appendFile(collisionsPath(), "this is not json\n", "utf8");
    const all = await loadAllCollisions();
    expect(all.length).toBe(1); // only the valid line
  });

  it("returns empty array when collisions.jsonl is missing", async () => {
    const all = await loadAllCollisions();
    expect(all).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------

async function seedProjectWithReportChannel(uuid: string): Promise<void> {
  await saveProjectChatRouting(
    uuid,
    {
      telegram: {
        report_channel: "-1001234567890",
        inbound_chat_ids: ["-1001234567890"],
      },
    },
    tmpRoot,
  );
}
