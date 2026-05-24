/**
 * workspace-topic.ts unit tests (TPS.3 / v0.5.120+).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProjectChatRouting } from "./routing.js";
import {
  clearBinding,
  deriveTopicName,
  findOwnerOfBinding,
  mergeChatIds,
  mergeTopicIds,
  resolveOrCreateTopic,
  type TopicCreatorClient,
} from "./workspace-topic.js";

let tmpRoot: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensquid-workspace-topic-test-"));
  prevHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = tmpRoot;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prevHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeRecordingClient(): {
  client: TopicCreatorClient;
  calls: Array<{ chat_id: string; name: string }>;
} {
  const calls: Array<{ chat_id: string; name: string }> = [];
  return {
    calls,
    client: {
      createTopic: ({ chat_id, name }) => {
        calls.push({ chat_id, name });
        // Echo back a fake topic id; tests assert this propagates.
        return Promise.resolve({ message_thread_id: 7777, name });
      },
    },
  };
}

describe("deriveTopicName", () => {
  it("combines basename + 8-char uuid prefix with the · separator", () => {
    expect(deriveTopicName("/Users/slee/projects/loop", "da96385b-8d0d-43c0-a637")).toBe(
      "loop · da96385b",
    );
  });

  it("falls back to 'root' for / and other empty-basename paths", () => {
    expect(deriveTopicName("/", "abc12345-xyz")).toBe("root · abc12345");
  });

  it("caps long basenames at 48 chars with ellipsis (pre-research verdict #4)", () => {
    const longName = "x".repeat(60);
    const result = deriveTopicName(`/projects/${longName}`, "abcd1234-xyz");
    // basename ≤ 48 + " · " (3) + uuid prefix (8) = 59 max
    expect(result.length).toBeLessThanOrEqual(48 + 3 + 8);
    expect(result).toContain("...");
    expect(result).toContain(" · abcd1234");
    // 48 cap = 45 chars of name + "..." (3 chars) = 48
    const basenamePart = result.split(" · ")[0] ?? "";
    expect(basenamePart.length).toBe(48);
  });

  it("does NOT truncate basenames that fit under the 48-char limit", () => {
    const exactly48 = "x".repeat(48);
    const result = deriveTopicName(`/projects/${exactly48}`, "abcd1234-xyz");
    const basenamePart = result.split(" · ")[0] ?? "";
    expect(basenamePart).toBe(exactly48);
    expect(basenamePart).not.toContain("...");
  });
});

describe("mergeTopicIds", () => {
  it("creates a new array for undefined existing", () => {
    expect(mergeTopicIds(undefined, 15)).toEqual([15]);
  });
  it("appends when not already present", () => {
    expect(mergeTopicIds([3], 7)).toEqual([3, 7]);
  });
  it("dedupes when already present", () => {
    expect(mergeTopicIds([3, 7], 7)).toEqual([3, 7]);
  });
});

describe("mergeChatIds", () => {
  it("creates a new array for undefined existing", () => {
    expect(mergeChatIds(undefined, "-100")).toEqual(["-100"]);
  });
  it("dedupes", () => {
    expect(mergeChatIds(["-100"], "-100")).toEqual(["-100"]);
  });
});

describe("resolveOrCreateTopic — cold start (no existing binding)", () => {
  it("calls createTopic, persists auto_bound + inbound_topic_ids, returns created=true", async () => {
    const { client, calls } = makeRecordingClient();
    const result = await resolveOrCreateTopic({
      workspaceUuid: "uuid-cold",
      workspacePath: "/tmp/test-workspace-cold",
      chatId: "-1001234",
      mode: "wizard",
      rpcClient: client,
      dataRoot: tmpRoot,
    });
    expect(result.created).toBe(true);
    expect(result.topicId).toBe(7777);
    expect(result.topicName).toBe("test-workspace-cold · uuid-col");
    expect(calls).toEqual([{ chat_id: "-1001234", name: "test-workspace-cold · uuid-col" }]);

    const loaded = await loadProjectChatRouting("uuid-cold", tmpRoot);
    expect(loaded?.telegram?.inbound_topic_ids).toEqual([7777]);
    expect(loaded?.telegram?.inbound_chat_ids).toEqual(["-1001234"]);
    expect(loaded?.telegram?.auto_bound?.topic_id).toBe(7777);
    expect(loaded?.telegram?.auto_bound?.workspace_uuid).toBe("uuid-cold");
    expect(loaded?.telegram?.auto_bound?.created_by).toBe("wizard");
  });
});

describe("resolveOrCreateTopic — warm start (existing binding)", () => {
  it("returns existing binding without calling createTopic", async () => {
    // Seed an existing auto_bound config
    const uuid = "uuid-warm";
    const dir = path.join(tmpRoot, "projects", uuid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chat-routing.json"),
      JSON.stringify({
        telegram: {
          inbound_chat_ids: ["-1001234"],
          inbound_topic_ids: [42],
          auto_bound: {
            workspace_path: "/tmp/old-path",
            workspace_uuid: uuid,
            topic_id: 42,
            topic_name: "existing-topic-name",
            created_at: "2026-05-22T00:00:00Z",
            created_by: "manual",
          },
        },
      }),
    );

    const { client, calls } = makeRecordingClient();
    const result = await resolveOrCreateTopic({
      workspaceUuid: uuid,
      workspacePath: "/tmp/new-path",
      chatId: "-1001234",
      mode: "wizard",
      rpcClient: client,
      dataRoot: tmpRoot,
    });
    expect(result.created).toBe(false);
    expect(result.topicId).toBe(42);
    expect(result.topicName).toBe("existing-topic-name");
    expect(calls).toHaveLength(0); // No new topic was created
  });
});

describe("resolveOrCreateTopic — RPC failure", () => {
  it("propagates the error without persisting partial config", async () => {
    const failingClient: TopicCreatorClient = {
      createTopic: () => Promise.reject(new Error("403 bot not admin")),
    };
    await expect(
      resolveOrCreateTopic({
        workspaceUuid: "uuid-fail",
        workspacePath: "/tmp/fail",
        chatId: "-1001234",
        mode: "wizard",
        rpcClient: failingClient,
        dataRoot: tmpRoot,
      }),
    ).rejects.toThrow(/403/);

    // Config should not have an auto_bound block written
    const loaded = await loadProjectChatRouting("uuid-fail", tmpRoot);
    expect(loaded?.telegram?.auto_bound).toBeUndefined();
  });
});

describe("resolveOrCreateTopic — concurrency", () => {
  it("two concurrent calls for same workspace result in exactly one createTopic call", async () => {
    const { client, calls } = makeRecordingClient();
    const args = {
      workspaceUuid: "uuid-race",
      workspacePath: "/tmp/race",
      chatId: "-1001234",
      mode: "auto-boot" as const,
      rpcClient: client,
      dataRoot: tmpRoot,
    };
    const [a, b] = await Promise.all([
      resolveOrCreateTopic(args),
      resolveOrCreateTopic(args),
    ]);
    expect(calls).toHaveLength(1); // Lock serialized them
    // Both calls return the same topicId; one has created=true, the other false
    expect(a.topicId).toBe(b.topicId);
    const createdCount = [a, b].filter((r) => r.created).length;
    expect(createdCount).toBe(1);
  });
});

describe("resolveOrCreateTopic — merges into existing routing", () => {
  it("preserves existing inbound_chat_ids + inbound_topic_ids while adding the new topic", async () => {
    const uuid = "uuid-merge";
    const dir = path.join(tmpRoot, "projects", uuid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chat-routing.json"),
      JSON.stringify({
        telegram: {
          report_channel: "telegram:-1001234",
          inbound_chat_ids: ["-1001234"],
          inbound_topic_ids: [3],
        },
      }),
    );

    const { client } = makeRecordingClient();
    const result = await resolveOrCreateTopic({
      workspaceUuid: uuid,
      workspacePath: "/tmp/merge",
      chatId: "-1001234",
      mode: "wizard",
      rpcClient: client,
      dataRoot: tmpRoot,
    });
    expect(result.created).toBe(true);

    const loaded = await loadProjectChatRouting(uuid, tmpRoot);
    // Existing report_channel preserved
    expect(loaded?.telegram?.report_channel).toBe("telegram:-1001234");
    // inbound_topic_ids grew from [3] to [3, 7777]
    expect(loaded?.telegram?.inbound_topic_ids).toEqual([3, 7777]);
    // inbound_chat_ids unchanged (no duplicates added)
    expect(loaded?.telegram?.inbound_chat_ids).toEqual(["-1001234"]);
  });
});

describe("resolveOrCreateTopic — pre-research verdict #6 (partial-failure orphan recovery)", () => {
  it("logs an orphan-topic record when createTopic succeeds but persist fails", async () => {
    const { client } = makeRecordingClient();
    // Make persistRoutingAtomic fail by writing a directory where the
    // routing file should be — the tmp + rename will fail.
    const uuid = "uuid-orphan";
    const projectDir = path.join(tmpRoot, "projects", uuid);
    await fs.mkdir(projectDir, { recursive: true });
    // Create chat-routing.json AS A DIRECTORY so fs.writeFile(tmp) →
    // fs.rename(tmp, target) fails on rename (cannot replace a dir
    // with a file via rename on most fs).
    await fs.mkdir(path.join(projectDir, "chat-routing.json.dir-clash"));
    // ... actually a simpler trigger: make the target a directory
    await fs.rm(path.join(projectDir, "chat-routing.json.dir-clash"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "chat-routing.json"), { recursive: true });

    await expect(
      resolveOrCreateTopic({
        workspaceUuid: uuid,
        workspacePath: "/tmp/orphan",
        chatId: "-1001234",
        mode: "wizard",
        rpcClient: client,
        dataRoot: tmpRoot,
      }),
    ).rejects.toThrow();

    // Verify orphan record was written
    const orphanPath = path.join(tmpRoot, "orphan-topics.jsonl");
    const orphanContent = await fs.readFile(orphanPath, "utf8").catch(() => "");
    expect(orphanContent.length).toBeGreaterThan(0);
    const lines = orphanContent.trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.topic_id).toBe(7777);
    expect(record.workspace_uuid).toBe(uuid);
    expect(record.mode).toBe("wizard");
    expect(record.persist_error).toMatch(/.+/);
  });
});

describe("resolveOrCreateTopic — pre-research verdict #9 (invariant warning)", () => {
  it("logs a warning when auto_bound.topic_id is not in inbound_topic_ids (but does not auto-repair)", async () => {
    const uuid = "uuid-invariant";
    const dir = path.join(tmpRoot, "projects", uuid);
    await fs.mkdir(dir, { recursive: true });
    // Construct an intentionally-inconsistent config: auto_bound says
    // topic 42 but inbound_topic_ids says [3].
    await fs.writeFile(
      path.join(dir, "chat-routing.json"),
      JSON.stringify({
        telegram: {
          inbound_chat_ids: ["-1001234"],
          inbound_topic_ids: [3],
          auto_bound: {
            workspace_path: "/tmp/invariant",
            workspace_uuid: uuid,
            topic_id: 42,
            topic_name: "stale-name",
            created_at: "2026-05-22T00:00:00Z",
            created_by: "manual",
          },
        },
      }),
    );

    // Capture stderr — using spyOn keeps the test self-contained.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      captured.push(text);
      return true;
    }) as typeof process.stderr.write;
    try {
      const { client } = makeRecordingClient();
      const result = await resolveOrCreateTopic({
        workspaceUuid: uuid,
        workspacePath: "/tmp/invariant",
        chatId: "-1001234",
        mode: "wizard",
        rpcClient: client,
        dataRoot: tmpRoot,
      });
      // Existing binding returned (idempotent path), not re-created
      expect(result.created).toBe(false);
      expect(result.topicId).toBe(42);
      // Invariant warning fired
      const warned = captured.some((c) =>
        c.includes("invariant warning") && c.includes("topic_id=42"),
      );
      expect(warned).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }

    // Config NOT auto-repaired
    const loaded = await loadProjectChatRouting(uuid, tmpRoot);
    expect(loaded?.telegram?.inbound_topic_ids).toEqual([3]); // not [3, 42]
    expect(loaded?.telegram?.auto_bound?.topic_id).toBe(42);
  });
});

describe("clearBinding (TPS.7 prep)", () => {
  it("removes the auto_bound block + its topic_id from inbound_topic_ids", async () => {
    // Seed
    const uuid = "uuid-clear";
    const dir = path.join(tmpRoot, "projects", uuid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chat-routing.json"),
      JSON.stringify({
        telegram: {
          inbound_chat_ids: ["-1001234"],
          inbound_topic_ids: [3, 42],
          auto_bound: {
            workspace_path: "/tmp/clear",
            workspace_uuid: uuid,
            topic_id: 42,
            topic_name: "clear · uuid-cle",
            created_at: "2026-05-22T00:00:00Z",
            created_by: "auto-boot",
          },
        },
      }),
    );

    const cleared = await clearBinding({ workspaceUuid: uuid, dataRoot: tmpRoot });
    expect(cleared).toBe(true);

    const loaded = await loadProjectChatRouting(uuid, tmpRoot);
    expect(loaded?.telegram?.auto_bound).toBeUndefined();
    // 42 removed; 3 preserved
    expect(loaded?.telegram?.inbound_topic_ids).toEqual([3]);
  });

  it("returns false when there's no binding to clear", async () => {
    const uuid = "uuid-noop";
    const dir = path.join(tmpRoot, "projects", uuid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chat-routing.json"),
      JSON.stringify({ telegram: { inbound_chat_ids: ["-1001234"] } }),
    );
    const cleared = await clearBinding({ workspaceUuid: uuid, dataRoot: tmpRoot });
    expect(cleared).toBe(false);
  });
});

describe("findOwnerOfBinding (TPS.7)", () => {
  async function seedProject(uuid: string, routing: object): Promise<void> {
    const dir = path.join(tmpRoot, "projects", uuid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "chat-routing.json"), JSON.stringify(routing, null, 2));
  }

  const exampleAutoBound = {
    workspace_path: "/x",
    workspace_uuid: "uuid-match",
    topic_id: 42,
    topic_name: "match · uuid-mat",
    created_at: "2026-05-22T00:00:00Z",
    created_by: "auto-boot",
  } as const;

  it("returns the uuid of the project whose auto_bound matches (chat_id, topic_id)", async () => {
    await seedProject("uuid-match", {
      telegram: {
        inbound_chat_ids: ["-1001234567890"],
        inbound_topic_ids: [42],
        auto_bound: exampleAutoBound,
      },
    });
    const uuid = await findOwnerOfBinding({
      chatId: "-1001234567890",
      topicId: 42,
      dataRoot: tmpRoot,
    });
    expect(uuid).toBe("uuid-match");
  });

  it("returns null when no project has any auto_bound block", async () => {
    await seedProject("uuid-no-bind", {
      telegram: { inbound_chat_ids: ["-1001234567890"], inbound_topic_ids: [42] },
    });
    const uuid = await findOwnerOfBinding({
      chatId: "-1001234567890",
      topicId: 42,
      dataRoot: tmpRoot,
    });
    expect(uuid).toBeNull();
  });

  it("returns null when topic_id matches but chat_id does NOT (cross-supergroup safety)", async () => {
    await seedProject("uuid-other-chat", {
      telegram: {
        inbound_chat_ids: ["-9999999999999"],
        inbound_topic_ids: [42],
        auto_bound: { ...exampleAutoBound, workspace_uuid: "uuid-other-chat" },
      },
    });
    const uuid = await findOwnerOfBinding({
      chatId: "-1001234567890",
      topicId: 42,
      dataRoot: tmpRoot,
    });
    expect(uuid).toBeNull();
  });

  it("returns null when chat_id matches but topic_id does NOT", async () => {
    await seedProject("uuid-other-topic", {
      telegram: {
        inbound_chat_ids: ["-1001234567890"],
        inbound_topic_ids: [99],
        auto_bound: {
          ...exampleAutoBound,
          workspace_uuid: "uuid-other-topic",
          topic_id: 99,
        },
      },
    });
    const uuid = await findOwnerOfBinding({
      chatId: "-1001234567890",
      topicId: 42,
      dataRoot: tmpRoot,
    });
    expect(uuid).toBeNull();
  });

  it("picks the right project when multiple coexist (different topic_ids)", async () => {
    await seedProject("uuid-a", {
      telegram: {
        inbound_chat_ids: ["-1001234567890"],
        inbound_topic_ids: [10],
        auto_bound: { ...exampleAutoBound, workspace_uuid: "uuid-a", topic_id: 10 },
      },
    });
    await seedProject("uuid-b", {
      telegram: {
        inbound_chat_ids: ["-1001234567890"],
        inbound_topic_ids: [20],
        auto_bound: { ...exampleAutoBound, workspace_uuid: "uuid-b", topic_id: 20 },
      },
    });
    expect(
      await findOwnerOfBinding({
        chatId: "-1001234567890",
        topicId: 10,
        dataRoot: tmpRoot,
      }),
    ).toBe("uuid-a");
    expect(
      await findOwnerOfBinding({
        chatId: "-1001234567890",
        topicId: 20,
        dataRoot: tmpRoot,
      }),
    ).toBe("uuid-b");
  });

  it("returns null when projects directory is missing entirely", async () => {
    const uuid = await findOwnerOfBinding({
      chatId: "-1001234567890",
      topicId: 42,
      dataRoot: tmpRoot,
    });
    expect(uuid).toBeNull();
  });
});
