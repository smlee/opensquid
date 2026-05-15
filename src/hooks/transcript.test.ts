import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLastAssistantText, readLastUserText } from "./transcript.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `oscli-transcript-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeTranscript(events: object[]): Promise<string> {
  const p = path.join(tmpRoot, "transcript.jsonl");
  await fs.writeFile(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

describe("readLastUserText", () => {
  it("returns '' when the file does not exist", async () => {
    const r = await readLastUserText(path.join(tmpRoot, "missing.jsonl"));
    expect(r).toBe("");
  });

  it("returns the most recent plain-string user message", async () => {
    const p = await writeTranscript([
      { type: "user", message: { role: "user", content: "first thing" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "user", message: { role: "user", content: "second thing" } },
    ]);
    const r = await readLastUserText(p);
    expect(r).toBe("second thing");
  });

  it("skips user events with array content (tool_result events)", async () => {
    const p = await writeTranscript([
      { type: "user", message: { role: "user", content: "real prompt" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ tool_use_id: "abc", type: "tool_result", content: "tool result text" }],
        },
      },
    ]);
    const r = await readLastUserText(p);
    expect(r).toBe("real prompt");
  });

  it("returns '' when no plain-string user message exists", async () => {
    const p = await writeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ tool_use_id: "x", type: "tool_result", content: "y" }],
        },
      },
    ]);
    const r = await readLastUserText(p);
    expect(r).toBe("");
  });

  it("ignores malformed lines", async () => {
    const p = path.join(tmpRoot, "mixed.jsonl");
    await fs.writeFile(
      p,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
        "{ malformed",
        JSON.stringify({ type: "user", message: { role: "user", content: "world" } }),
      ].join("\n"),
    );
    const r = await readLastUserText(p);
    expect(r).toBe("world");
  });

  it("returns '' when content is whitespace only", async () => {
    const p = await writeTranscript([
      { type: "user", message: { role: "user", content: "   \n\t" } },
    ]);
    const r = await readLastUserText(p);
    expect(r).toBe("");
  });
});

describe("readLastAssistantText (back-compat)", () => {
  it("returns the most recent assistant text from array content", async () => {
    const p = await writeTranscript([
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "first chunk" },
            { type: "text", text: "second chunk" },
          ],
        },
      },
    ]);
    const r = await readLastAssistantText(p);
    expect(r).toBe("first chunk\nsecond chunk");
  });

  it("returns string content directly when used", async () => {
    const p = await writeTranscript([{ type: "assistant", message: { content: "direct string" } }]);
    const r = await readLastAssistantText(p);
    expect(r).toBe("direct string");
  });
});
