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

  it("calls onWarn on collision and lets the later project win", () => {
    const cfgs = new Map([
      ["uuid-a", { telegram: { inbound_chat_ids: ["100"] } }],
      ["uuid-b", { telegram: { inbound_chat_ids: ["100"] } }],
    ]);
    const warnings: string[] = [];
    const idx = buildRoutingIndex(cfgs, (m) => warnings.push(m));
    // Map iteration order on insertion → uuid-b wins.
    expect(idx.get("telegram:100")).toBe("uuid-b");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/collision.*telegram:100/);
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
