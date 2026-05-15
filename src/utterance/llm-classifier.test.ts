import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClassifierResponseSchema, classifyWithLLM } from "./llm-classifier.js";

describe("ClassifierResponseSchema", () => {
  it("accepts a minimal valid response", () => {
    const parsed = ClassifierResponseSchema.safeParse({ utterances: [] });
    expect(parsed.success).toBe(true);
  });

  it("accepts a full utterance entry", () => {
    const parsed = ClassifierResponseSchema.safeParse({
      utterances: [
        {
          kind: "preference",
          text: "I prefer kebab-case",
          confidence: "high",
          reasoning: "explicit preference statement",
          suggested_tool: "remember",
          suggested_args: {
            description: "user prefers kebab-case",
            content: "User said: I prefer kebab-case for file names.",
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown kind", () => {
    const parsed = ClassifierResponseSchema.safeParse({
      utterances: [
        {
          kind: "vibes", // invalid
          text: "x",
          confidence: "high",
          reasoning: "y",
          suggested_tool: "memorize",
          suggested_args: { description: "x", content: "y" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty text", () => {
    const parsed = ClassifierResponseSchema.safeParse({
      utterances: [
        {
          kind: "fact",
          text: "",
          confidence: "high",
          reasoning: "y",
          suggested_tool: "memorize",
          suggested_args: { description: "x", content: "y" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing suggested_args fields", () => {
    const parsed = ClassifierResponseSchema.safeParse({
      utterances: [
        {
          kind: "fact",
          text: "I use pnpm",
          confidence: "medium",
          reasoning: "y",
          suggested_tool: "memorize",
          suggested_args: { description: "", content: "" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("classifyWithLLM — fail-open paths", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty for empty input", async () => {
    const r = await classifyWithLLM("");
    expect(r.utterances).toEqual([]);
  });

  it("returns empty for whitespace input", async () => {
    const r = await classifyWithLLM("   \n\t");
    expect(r.utterances).toEqual([]);
  });

  it('returns empty when provider="off"', async () => {
    const r = await classifyWithLLM("I prefer pnpm.", { provider: "off" });
    expect(r.utterances).toEqual([]);
  });

  it("returns empty when fetch rejects (connection refused)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await classifyWithLLM("I use vim.", { timeoutMs: 500 });
    expect(r.utterances).toEqual([]);
  });

  it("returns empty when fetch returns non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    const r = await classifyWithLLM("I use vim.", { timeoutMs: 500 });
    expect(r.utterances).toEqual([]);
  });

  it("returns empty when response body is malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: { content: "{not json" } }), { status: 200 }),
    );
    const r = await classifyWithLLM("I use vim.", { timeoutMs: 500 });
    expect(r.utterances).toEqual([]);
  });

  it("returns empty when response fails Zod schema", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { content: JSON.stringify({ wrongfield: true }) },
        }),
        { status: 200 },
      ),
    );
    const r = await classifyWithLLM("I use vim.", { timeoutMs: 500 });
    expect(r.utterances).toEqual([]);
  });

  it("times out gracefully when fetch never resolves", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise(() => undefined), // never resolves
    );
    const r = await classifyWithLLM("I use vim.", { timeoutMs: 50 });
    expect(r.utterances).toEqual([]);
  });
});

describe("classifyWithLLM — hallucination guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops items whose text is NOT a substring of the input", async () => {
    const userText = "I prefer pnpm.";
    const llmBody = {
      utterances: [
        {
          kind: "preference",
          text: "I prefer yarn", // NOT in input
          confidence: "high",
          reasoning: "hallucinated",
          suggested_tool: "remember",
          suggested_args: { description: "x", content: "y" },
        },
        {
          kind: "fact",
          text: "I prefer pnpm",
          confidence: "high",
          reasoning: "real",
          suggested_tool: "memorize",
          suggested_args: { description: "x", content: "y" },
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: { content: JSON.stringify(llmBody) } }), {
        status: 200,
      }),
    );
    const r = await classifyWithLLM(userText, { timeoutMs: 500 });
    expect(r.utterances).toHaveLength(1);
    expect(r.utterances[0].text).toBe("I prefer pnpm");
  });

  it("keeps all items when all texts are substrings", async () => {
    const userText = "I prefer pnpm and I use vim.";
    const llmBody = {
      utterances: [
        {
          kind: "preference",
          text: "I prefer pnpm",
          confidence: "high",
          reasoning: "ok",
          suggested_tool: "remember",
          suggested_args: { description: "x", content: "y" },
        },
        {
          kind: "fact",
          text: "I use vim",
          confidence: "high",
          reasoning: "ok",
          suggested_tool: "memorize",
          suggested_args: { description: "x", content: "y" },
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: { content: JSON.stringify(llmBody) } }), {
        status: 200,
      }),
    );
    const r = await classifyWithLLM(userText, { timeoutMs: 500 });
    expect(r.utterances).toHaveLength(2);
  });
});
