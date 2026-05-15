import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendCandidates,
  clearCandidates,
  decideAction,
  readCandidates,
  runAutoClassifyHook,
  type AutoClassifyCandidate,
} from "./auto-classify.js";
import type { ClassifiedUtterance } from "../utterance/llm-classifier.js";

let tmpRoot: string;
const SESSION = "auto-cls-test";

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `oscli-auto-cls-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeTranscript(userText: string): Promise<string> {
  const p = path.join(tmpRoot, "transcript.jsonl");
  await fs.writeFile(
    p,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: userText },
    }) + "\n",
  );
  return p;
}

function fact(opts: Partial<ClassifiedUtterance> = {}): ClassifiedUtterance {
  return {
    kind: "fact",
    text: "I use pnpm",
    confidence: "high",
    reasoning: "explicit fact",
    suggested_tool: "memorize",
    suggested_args: {
      description: "user uses pnpm",
      content: "User said: I use pnpm.",
    },
    ...opts,
  };
}

describe("decideAction policy", () => {
  it("hybrid: high-confidence memorize → auto-memorized", () => {
    expect(decideAction(fact({ confidence: "high" }), "hybrid")).toBe("auto-memorized");
  });
  it("hybrid: medium-confidence memorize → surfaced", () => {
    expect(decideAction(fact({ confidence: "medium" }), "hybrid")).toBe("surfaced");
  });
  it("hybrid: low-confidence memorize → surfaced", () => {
    expect(decideAction(fact({ confidence: "low" }), "hybrid")).toBe("surfaced");
  });
  it("hybrid: remember (any confidence) → surfaced (wedge invariant)", () => {
    expect(
      decideAction(
        fact({ kind: "preference", suggested_tool: "remember", confidence: "high" }),
        "hybrid",
      ),
    ).toBe("surfaced");
  });
  it("hybrid: update_memory (any confidence) → surfaced", () => {
    expect(
      decideAction(
        fact({ kind: "correction", suggested_tool: "update_memory", confidence: "high" }),
        "hybrid",
      ),
    ).toBe("surfaced");
  });
  it("auto mode: any memorize → auto-memorized", () => {
    expect(decideAction(fact({ confidence: "low" }), "auto")).toBe("auto-memorized");
  });
  it("surface mode: everything → surfaced", () => {
    expect(decideAction(fact({ confidence: "high" }), "surface")).toBe("surfaced");
  });
});

describe("candidate file IO", () => {
  it("appendCandidates + readCandidates roundtrip", async () => {
    const c1: AutoClassifyCandidate = {
      ts: "2026-05-15T00:00:00Z",
      kind: "fact",
      text: "I use pnpm",
      confidence: "high",
      reasoning: "x",
      suggested_tool: "memorize",
      suggested_args: { description: "x", content: "y" },
      action_taken: "auto-memorized",
      memory_id: "mem-abc",
    };
    await appendCandidates(SESSION, [c1], { dataRoot: tmpRoot });
    const r = await readCandidates(SESSION, { dataRoot: tmpRoot });
    expect(r).toHaveLength(1);
    expect(r[0].memory_id).toBe("mem-abc");
  });

  it("clearCandidates removes the file", async () => {
    await appendCandidates(
      SESSION,
      [
        {
          ts: "z",
          kind: "fact",
          text: "x",
          confidence: "low",
          reasoning: "x",
          suggested_tool: "memorize",
          suggested_args: { description: "x", content: "y" },
          action_taken: "surfaced",
        },
      ],
      { dataRoot: tmpRoot },
    );
    await clearCandidates(SESSION, { dataRoot: tmpRoot });
    expect(await readCandidates(SESSION, { dataRoot: tmpRoot })).toEqual([]);
  });

  it("readCandidates returns [] when file missing", async () => {
    expect(await readCandidates(SESSION, { dataRoot: tmpRoot })).toEqual([]);
  });
});

describe("runAutoClassifyHook — end-to-end", () => {
  it("does nothing when transcript user text is empty", async () => {
    const tpath = await writeTranscript("");
    await runAutoClassifyHook(
      SESSION,
      tpath,
      {
        classify: async () => ({ utterances: [fact()] }),
        createMemory: vi.fn(),
      },
      { dataRoot: tmpRoot },
    );
    expect(await readCandidates(SESSION, { dataRoot: tmpRoot })).toEqual([]);
  });

  it("does nothing when classifier returns empty", async () => {
    const tpath = await writeTranscript("hello world");
    const createMemory = vi.fn();
    await runAutoClassifyHook(
      SESSION,
      tpath,
      {
        classify: async () => ({ utterances: [] }),
        createMemory,
      },
      { dataRoot: tmpRoot },
    );
    expect(createMemory).not.toHaveBeenCalled();
    expect(await readCandidates(SESSION, { dataRoot: tmpRoot })).toEqual([]);
  });

  it("auto-memorizes a high-confidence fact in hybrid mode", async () => {
    const tpath = await writeTranscript("I use pnpm.");
    const createMemory = vi.fn(async () => ({ memory_id: "mem-1" }));
    await runAutoClassifyHook(
      SESSION,
      tpath,
      {
        classify: async () => ({ utterances: [fact({ confidence: "high" })] }),
        createMemory,
      },
      { dataRoot: tmpRoot, mode: "hybrid" },
    );
    expect(createMemory).toHaveBeenCalledTimes(1);
    const r = await readCandidates(SESSION, { dataRoot: tmpRoot });
    expect(r).toHaveLength(1);
    expect(r[0].action_taken).toBe("auto-memorized");
    expect(r[0].memory_id).toBe("mem-1");
  });

  it("surfaces (no createMemory call) for medium-confidence facts", async () => {
    const tpath = await writeTranscript("I use pnpm.");
    const createMemory = vi.fn();
    await runAutoClassifyHook(
      SESSION,
      tpath,
      {
        classify: async () => ({ utterances: [fact({ confidence: "medium" })] }),
        createMemory,
      },
      { dataRoot: tmpRoot, mode: "hybrid" },
    );
    expect(createMemory).not.toHaveBeenCalled();
    const r = await readCandidates(SESSION, { dataRoot: tmpRoot });
    expect(r).toHaveLength(1);
    expect(r[0].action_taken).toBe("surfaced");
  });

  it("surfaces remember (lesson candidate) even at high confidence — wedge invariant", async () => {
    const tpath = await writeTranscript("Always run tests before pushing.");
    const createMemory = vi.fn();
    await runAutoClassifyHook(
      SESSION,
      tpath,
      {
        classify: async () => ({
          utterances: [
            fact({
              kind: "preference",
              text: "Always run tests before pushing",
              suggested_tool: "remember",
              confidence: "high",
            }),
          ],
        }),
        createMemory,
      },
      { dataRoot: tmpRoot, mode: "hybrid" },
    );
    expect(createMemory).not.toHaveBeenCalled();
    const r = await readCandidates(SESSION, { dataRoot: tmpRoot });
    expect(r[0].action_taken).toBe("surfaced");
    expect(r[0].suggested_tool).toBe("remember");
  });

  it("dedups within a session via the hash set", async () => {
    const tpath = await writeTranscript("I use pnpm.");
    const createMemory = vi.fn(async () => ({ memory_id: "mem-1" }));
    const classifyArgs = { utterances: [fact({ confidence: "high" })] };

    // First run — should auto-memorize.
    await runAutoClassifyHook(
      SESSION,
      tpath,
      { classify: async () => classifyArgs, createMemory },
      { dataRoot: tmpRoot, mode: "hybrid" },
    );
    // Second run with the SAME utterance — should be deduped.
    await runAutoClassifyHook(
      SESSION,
      tpath,
      { classify: async () => classifyArgs, createMemory },
      { dataRoot: tmpRoot, mode: "hybrid" },
    );
    expect(createMemory).toHaveBeenCalledTimes(1);
  });

  it("respects mode='off' env override", async () => {
    const tpath = await writeTranscript("I use pnpm.");
    const createMemory = vi.fn();
    await runAutoClassifyHook(
      SESSION,
      tpath,
      {
        classify: async () => ({ utterances: [fact({ confidence: "high" })] }),
        createMemory,
      },
      { dataRoot: tmpRoot, mode: "off" },
    );
    expect(createMemory).not.toHaveBeenCalled();
    expect(await readCandidates(SESSION, { dataRoot: tmpRoot })).toEqual([]);
  });

  it("downgrades to surfaced when createMemory throws (engine down)", async () => {
    const tpath = await writeTranscript("I use pnpm.");
    const createMemory = vi.fn(async () => {
      throw new Error("engine unreachable");
    });
    await runAutoClassifyHook(
      SESSION,
      tpath,
      {
        classify: async () => ({ utterances: [fact({ confidence: "high" })] }),
        createMemory,
      },
      { dataRoot: tmpRoot, mode: "hybrid" },
    );
    const r = await readCandidates(SESSION, { dataRoot: tmpRoot });
    expect(r).toHaveLength(1);
    expect(r[0].action_taken).toBe("surfaced");
  });

  it("skips when searchMemory finds a semantic duplicate", async () => {
    const tpath = await writeTranscript("I use pnpm.");
    const createMemory = vi.fn(async () => ({ memory_id: "mem-1" }));
    const searchMemory = vi.fn(async () => ({
      results: [{ score: 0.92, source: "semantic" }],
    }));
    await runAutoClassifyHook(
      SESSION,
      tpath,
      {
        classify: async () => ({ utterances: [fact({ confidence: "high" })] }),
        createMemory,
        searchMemory,
      },
      { dataRoot: tmpRoot, mode: "hybrid" },
    );
    expect(createMemory).not.toHaveBeenCalled();
    const r = await readCandidates(SESSION, { dataRoot: tmpRoot });
    expect(r).toHaveLength(1);
    expect(r[0].action_taken).toBe("skipped-duplicate");
  });
});
