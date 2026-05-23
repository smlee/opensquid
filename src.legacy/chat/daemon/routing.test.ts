/**
 * routing.ts unit tests (v0.7.1 Phase C).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildRoutingIndex,
  collectInboundChannels,
  loadAllProjectChatRouting,
  loadProjectChatRouting,
  projectChatRoutingPath,
  projectInboxDir,
  projectsRootPath,
  saveProjectChatRouting,
  type CollisionInfo,
} from "./routing.js";

let tmpRoot: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensquid-routing-test-"));
  prevHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = tmpRoot;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prevHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("path derivation", () => {
  it("projectsRootPath = <dataRoot>/projects", () => {
    expect(projectsRootPath(tmpRoot)).toBe(path.join(tmpRoot, "projects"));
  });
  it("projectChatRoutingPath = <dataRoot>/projects/<uuid>/chat-routing.json", () => {
    expect(projectChatRoutingPath("abc-uuid", tmpRoot)).toBe(
      path.join(tmpRoot, "projects", "abc-uuid", "chat-routing.json"),
    );
  });
  it("projectInboxDir = <dataRoot>/projects/<uuid>/inbox", () => {
    expect(projectInboxDir("abc-uuid", tmpRoot)).toBe(
      path.join(tmpRoot, "projects", "abc-uuid", "inbox"),
    );
  });
});

describe("loadProjectChatRouting", () => {
  it("returns null when the routing file is missing", async () => {
    const r = await loadProjectChatRouting("missing-uuid", tmpRoot);
    expect(r).toBeNull();
  });

  it("loads a valid routing file", async () => {
    const uuid = "test-uuid";
    await fs.mkdir(path.join(tmpRoot, "projects", uuid), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "projects", uuid, "chat-routing.json"),
      JSON.stringify({
        telegram: { report_channel: "telegram:-100", inbound_chat_ids: ["-100", "-200"] },
      }),
    );
    const r = await loadProjectChatRouting(uuid, tmpRoot);
    expect(r).not.toBeNull();
    expect(r?.telegram?.report_channel).toBe("telegram:-100");
    expect(r?.telegram?.inbound_chat_ids).toEqual(["-100", "-200"]);
  });

  it("returns null on malformed JSON (does not throw)", async () => {
    const uuid = "bad-uuid";
    await fs.mkdir(path.join(tmpRoot, "projects", uuid), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "projects", uuid, "chat-routing.json"), "{ not json");
    const r = await loadProjectChatRouting(uuid, tmpRoot);
    expect(r).toBeNull();
  });

  // v0.5.120+ (TPS.2) — auto_bound block round-trip
  it("loads a routing file with the v0.5.120+ auto_bound block", async () => {
    const uuid = "tps2-uuid";
    await fs.mkdir(path.join(tmpRoot, "projects", uuid), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "projects", uuid, "chat-routing.json"),
      JSON.stringify({
        telegram: {
          report_channel: "telegram:-100",
          inbound_chat_ids: ["-100"],
          inbound_topic_ids: [15],
          auto_bound: {
            workspace_path: "/Users/test/projects/loop",
            workspace_uuid: "tps2-uuid",
            topic_id: 15,
            topic_name: "loop · tps2-uui",
            created_at: "2026-05-23T04:00:00Z",
            created_by: "wizard",
          },
        },
      }),
    );
    const r = await loadProjectChatRouting(uuid, tmpRoot);
    expect(r).not.toBeNull();
    expect(r?.telegram?.auto_bound?.workspace_uuid).toBe("tps2-uuid");
    expect(r?.telegram?.auto_bound?.topic_id).toBe(15);
    expect(r?.telegram?.auto_bound?.created_by).toBe("wizard");
    expect(r?.telegram?.auto_bound?.topic_name).toBe("loop · tps2-uui");
  });

  it("schema backwards-compat: routing file without auto_bound block still loads", async () => {
    const uuid = "legacy-uuid";
    await fs.mkdir(path.join(tmpRoot, "projects", uuid), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "projects", uuid, "chat-routing.json"),
      JSON.stringify({
        telegram: {
          report_channel: "telegram:-100",
          inbound_chat_ids: ["-100"],
          inbound_topic_ids: [15],
        },
      }),
    );
    const r = await loadProjectChatRouting(uuid, tmpRoot);
    expect(r?.telegram?.auto_bound).toBeUndefined();
    expect(r?.telegram?.inbound_topic_ids).toEqual([15]);
  });
});

describe("loadAllProjectChatRouting", () => {
  it("returns empty map when projects root doesn't exist", async () => {
    const r = await loadAllProjectChatRouting(tmpRoot);
    expect(r.size).toBe(0);
  });

  it("collects all valid routing files, skipping hidden entries", async () => {
    const projectsDir = path.join(tmpRoot, "projects");
    await fs.mkdir(path.join(projectsDir, "uuid-a"), { recursive: true });
    await fs.mkdir(path.join(projectsDir, "uuid-b"), { recursive: true });
    await fs.mkdir(path.join(projectsDir, ".hidden"), { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, "uuid-a", "chat-routing.json"),
      JSON.stringify({ telegram: { inbound_chat_ids: ["1"] } }),
    );
    await fs.writeFile(
      path.join(projectsDir, "uuid-b", "chat-routing.json"),
      JSON.stringify({ discord: { inbound_channel_ids: ["2"] } }),
    );
    await fs.writeFile(
      path.join(projectsDir, ".hidden", "chat-routing.json"),
      JSON.stringify({ slack: { inbound_channel_ids: ["3"] } }),
    );

    const all = await loadAllProjectChatRouting(tmpRoot);
    expect(all.size).toBe(2);
    expect(all.has("uuid-a")).toBe(true);
    expect(all.has("uuid-b")).toBe(true);
    expect(all.has(".hidden")).toBe(false);
  });
});

describe("collectInboundChannels", () => {
  it("returns empty list for empty config", () => {
    expect(collectInboundChannels({})).toEqual([]);
  });

  it("formats telegram ids as telegram:<id>", () => {
    const ch = collectInboundChannels({ telegram: { inbound_chat_ids: ["100", "200"] } });
    expect(ch).toEqual(["telegram:100", "telegram:200"]);
  });

  it("collects across all platforms", () => {
    const ch = collectInboundChannels({
      telegram: { inbound_chat_ids: ["t1"] },
      discord: { inbound_channel_ids: ["d1"] },
      slack: { inbound_channel_ids: ["s1"] },
    });
    expect(ch).toEqual(["telegram:t1", "discord:d1", "slack:s1"]);
  });
});

// v0.5.94 (WAB.2 Part A / TG.1 (a)) — DM allowlist key emission.
describe("collectInboundChannels — v0.5.94 DM allowlist", () => {
  it("emits DM keys as telegram:dm:<user_id> when inbound_dm_user_ids is set", () => {
    const ch = collectInboundChannels({
      telegram: { inbound_dm_user_ids: ["123"] },
    });
    expect(ch).toEqual(["telegram:dm:123"]);
  });

  it("supports multiple DM user_ids", () => {
    const ch = collectInboundChannels({
      telegram: { inbound_dm_user_ids: ["123", "456"] },
    });
    expect(ch).toEqual(["telegram:dm:123", "telegram:dm:456"]);
  });

  it("emits both group + topic + DM keys when all are configured", () => {
    const ch = collectInboundChannels({
      telegram: {
        inbound_chat_ids: ["-100super"],
        inbound_topic_ids: [15],
        inbound_dm_user_ids: ["8075471258"],
      },
    });
    expect(ch).toEqual(["telegram:-100super:15", "telegram:dm:8075471258"]);
  });

  it("schema backwards-compat: config without inbound_dm_user_ids still works", () => {
    const ch = collectInboundChannels({
      telegram: { inbound_chat_ids: ["-100"] },
    });
    expect(ch).toEqual(["telegram:-100"]);
  });

  it("empty inbound_dm_user_ids list emits no DM keys", () => {
    const ch = collectInboundChannels({
      telegram: { inbound_dm_user_ids: [] },
    });
    expect(ch).toEqual([]);
  });
});

describe("buildRoutingIndex — v0.5.94 DM key indexing", () => {
  it("indexes DM keys so worker can look up by telegram:dm:<user_id>", () => {
    const cfgs = new Map([
      ["uuid-dm", { telegram: { inbound_dm_user_ids: ["8075471258"] } }],
    ]);
    const idx = buildRoutingIndex(cfgs);
    expect(idx.get("telegram:dm:8075471258")).toBe("uuid-dm");
    expect(idx.size).toBe(1);
  });

  it("two projects can each have their own DM allowlist (no collision)", () => {
    const cfgs = new Map([
      ["uuid-a", { telegram: { inbound_dm_user_ids: ["111"] } }],
      ["uuid-b", { telegram: { inbound_dm_user_ids: ["222"] } }],
    ]);
    const idx = buildRoutingIndex(cfgs);
    expect(idx.get("telegram:dm:111")).toBe("uuid-a");
    expect(idx.get("telegram:dm:222")).toBe("uuid-b");
    expect(idx.size).toBe(2);
  });

  it("same DM user across two projects: collision warned, last wins (consistent with existing behavior)", () => {
    const cfgs = new Map([
      ["uuid-a", { telegram: { inbound_dm_user_ids: ["999"] } }],
      ["uuid-b", { telegram: { inbound_dm_user_ids: ["999"] } }],
    ]);
    const collisions: CollisionInfo[] = [];
    const idx = buildRoutingIndex(cfgs, (info) => collisions.push(info));
    expect(idx.get("telegram:dm:999")).toBe("uuid-b");
    expect(collisions.length).toBe(1);
    expect(collisions[0]?.channel_key).toBe("telegram:dm:999");
    expect(collisions[0]?.existing_uuid).toBe("uuid-a");
    expect(collisions[0]?.newcomer_uuid).toBe("uuid-b");
  });

  it("group + DM in same project: both keys index to same uuid", () => {
    const cfgs = new Map([
      [
        "uuid-x",
        {
          telegram: {
            inbound_chat_ids: ["-100"],
            inbound_topic_ids: [15],
            inbound_dm_user_ids: ["8075471258"],
          },
        },
      ],
    ]);
    const idx = buildRoutingIndex(cfgs);
    expect(idx.get("telegram:-100:15")).toBe("uuid-x");
    expect(idx.get("telegram:dm:8075471258")).toBe("uuid-x");
    expect(idx.get("telegram:-100")).toBeUndefined(); // strict topic whitelist preserved
    expect(idx.size).toBe(2);
  });
});

describe("buildRoutingIndex — v0.7.2 topic-aware keys", () => {
  it("emits topic-specific keys when inbound_topic_ids is set", () => {
    const cfgs = new Map([
      [
        "uuid-a",
        {
          telegram: {
            inbound_chat_ids: ["-1001234567890"],
            inbound_topic_ids: [5, 12],
          },
        },
      ],
    ]);
    const idx = buildRoutingIndex(cfgs);
    expect(idx.get("telegram:-1001234567890:5")).toBe("uuid-a");
    expect(idx.get("telegram:-1001234567890:12")).toBe("uuid-a");
    // Chat-only key NOT registered when topic_ids are set — we want
    // routing to be topic-strict.
    expect(idx.get("telegram:-1001234567890")).toBeUndefined();
  });

  it("two projects sharing one supergroup but different topics get distinct routing", () => {
    const cfgs = new Map([
      ["uuid-a", { telegram: { inbound_chat_ids: ["-100common"], inbound_topic_ids: [5] } }],
      ["uuid-b", { telegram: { inbound_chat_ids: ["-100common"], inbound_topic_ids: [10] } }],
    ]);
    const idx = buildRoutingIndex(cfgs);
    expect(idx.get("telegram:-100common:5")).toBe("uuid-a");
    expect(idx.get("telegram:-100common:10")).toBe("uuid-b");
    expect(idx.size).toBe(2);
  });

  it("falls back to chat-only key when inbound_topic_ids is empty/unset (legacy v0.7.1)", () => {
    const cfgs = new Map([["uuid-legacy", { telegram: { inbound_chat_ids: ["-100legacy"] } }]]);
    const idx = buildRoutingIndex(cfgs);
    expect(idx.get("telegram:-100legacy")).toBe("uuid-legacy");
    expect(idx.size).toBe(1);
  });
});

describe("buildRoutingIndex", () => {
  it("builds a chat_id → uuid map", () => {
    const cfgs = new Map([
      ["uuid-a", { telegram: { inbound_chat_ids: ["100", "200"] } }],
      ["uuid-b", { discord: { inbound_channel_ids: ["d1"] } }],
    ]);
    const idx = buildRoutingIndex(cfgs);
    expect(idx.get("telegram:100")).toBe("uuid-a");
    expect(idx.get("telegram:200")).toBe("uuid-a");
    expect(idx.get("discord:d1")).toBe("uuid-b");
    expect(idx.size).toBe(3);
  });

  it("calls onCollision with structured info and lets the later project win", () => {
    const cfgs = new Map([
      ["uuid-a", { telegram: { inbound_chat_ids: ["100"] } }],
      ["uuid-b", { telegram: { inbound_chat_ids: ["100"] } }],
    ]);
    const collisions: CollisionInfo[] = [];
    const idx = buildRoutingIndex(cfgs, (info) => collisions.push(info));
    // Map iteration order on insertion → uuid-b wins.
    expect(idx.get("telegram:100")).toBe("uuid-b");
    expect(collisions.length).toBe(1);
    expect(collisions[0]?.channel_key).toBe("telegram:100");
    expect(collisions[0]?.existing_uuid).toBe("uuid-a");
    expect(collisions[0]?.newcomer_uuid).toBe("uuid-b");
  });
});

describe("saveProjectChatRouting", () => {
  it("writes a routing file atomically, creating the project dir if missing", async () => {
    const uuid = "save-test";
    const res = await saveProjectChatRouting(
      uuid,
      { telegram: { report_channel: "telegram:abc", inbound_chat_ids: ["abc"] } },
      tmpRoot,
    );
    expect(res.path).toBe(path.join(tmpRoot, "projects", uuid, "chat-routing.json"));
    const back = await loadProjectChatRouting(uuid, tmpRoot);
    expect(back?.telegram?.report_channel).toBe("telegram:abc");
  });

  it("overwrites an existing routing file (rename-over)", async () => {
    const uuid = "overwrite-test";
    await saveProjectChatRouting(uuid, { telegram: { report_channel: "telegram:v1" } }, tmpRoot);
    await saveProjectChatRouting(uuid, { telegram: { report_channel: "telegram:v2" } }, tmpRoot);
    const back = await loadProjectChatRouting(uuid, tmpRoot);
    expect(back?.telegram?.report_channel).toBe("telegram:v2");
  });
});
