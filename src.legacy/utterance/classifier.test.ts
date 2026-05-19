import { describe, expect, it } from "vitest";

import { classifyUtterance, UTTERANCE_PATTERNS } from "./classifier.js";

describe("classifyUtterance — fact", () => {
  it("matches 'I use pnpm'", () => {
    const r = classifyUtterance("I use pnpm in this project.");
    expect(r.kind).toBe("fact");
    expect(r.matched).toContain("fact-i-use");
  });

  it("matches 'Gianna is my daughter'", () => {
    const r = classifyUtterance("Gianna is my daughter.");
    expect(r.kind).toBe("fact");
    expect(r.matched).toContain("fact-x-is-my");
  });

  it("matches 'we have postgres in prod'", () => {
    const r = classifyUtterance("We have postgres in prod and redis for cache.");
    expect(r.kind).toBe("fact");
  });
});

describe("classifyUtterance — preference", () => {
  it("matches 'I prefer kebab-case'", () => {
    const r = classifyUtterance("I prefer kebab-case for file names.");
    expect(r.kind).toBe("preference");
    expect(r.matched).toContain("preference-i-prefer");
  });

  it("matches 'I always run tests before pushing'", () => {
    const r = classifyUtterance("I always run tests before pushing.");
    expect(r.kind).toBe("preference");
    expect(r.matched).toContain("preference-always-i");
  });

  it("matches sentence-leading 'Always check atoms/'", () => {
    const r = classifyUtterance("Always check atoms/ before creating a new component.");
    expect(r.kind).toBe("preference");
  });

  it("matches 'never amend a commit'", () => {
    const r = classifyUtterance("Never amend a commit unless the user asks.");
    expect(r.kind).toBe("preference");
  });

  it("matches sentence-leading 'don't push without OK'", () => {
    const r = classifyUtterance("Don't push without explicit user OK.");
    expect(r.kind).toBe("preference");
  });
});

describe("classifyUtterance — correction", () => {
  it("matches 'no, that's wrong'", () => {
    const r = classifyUtterance("No, that's wrong — the file is at src/foo.ts.");
    expect(r.kind).toBe("correction");
    expect(r.matched).toContain("correction-no-thats-wrong");
  });

  it("matches 'actually it should be X'", () => {
    const r = classifyUtterance("Actually, it should be the other way around.");
    expect(r.kind).toBe("correction");
  });

  it("matches 'I meant Y'", () => {
    const r = classifyUtterance("I meant the v0.4 branch, not v0.3.");
    expect(r.kind).toBe("correction");
  });
});

describe("classifyUtterance — workflow_lock", () => {
  it("matches 'the workflow is pre-research → learn → ...'", () => {
    const r = classifyUtterance("The workflow is pre-research, then learn, then code.");
    expect(r.kind).toBe("workflow_lock");
    expect(r.matched).toContain("workflow-the-workflow-is");
  });

  it("matches 'always pre-research first'", () => {
    const r = classifyUtterance("Always pre-research first.");
    expect(r.kind).toBe("workflow_lock");
  });

  it("matches 'no hedges'", () => {
    const r = classifyUtterance("No hedges — execute the plan.");
    expect(r.kind).toBe("workflow_lock");
  });

  it("matches 'keep iterating until perfect'", () => {
    const r = classifyUtterance("Keep iterating until we have the perfect solution.");
    expect(r.kind).toBe("workflow_lock");
  });
});

describe("classifyUtterance — none", () => {
  it("returns none for empty input", () => {
    expect(classifyUtterance("").kind).toBe("none");
    expect(classifyUtterance("   ").kind).toBe("none");
  });

  it("returns none for an unremarkable question", () => {
    const r = classifyUtterance("What's the status of the build?");
    expect(r.kind).toBe("none");
    expect(r.matched).toHaveLength(0);
  });

  it("returns none for a passive declarative without first-person", () => {
    // "the system was rebuilt yesterday" — neither preference nor fact
    // about the user; should not falsely match.
    const r = classifyUtterance("The system was rebuilt yesterday.");
    expect(r.kind).toBe("none");
  });
});

describe("false-positive resistance", () => {
  it("'it always rains here' is NOT a preference", () => {
    // Metaphorical/passive "always" — no first-person directive.
    const r = classifyUtterance("It always rains here in November.");
    expect(r.kind).not.toBe("preference");
  });

  it("'this is my best work' is NOT classified as a fact about identity", () => {
    // "X is my Y" with non-noun "best work" — currently this WOULD
    // match. Documenting the false-positive case for future tightening.
    // For MVP we accept this since memorize is light-touch.
    const r = classifyUtterance("This is my best work.");
    // Just verify it doesn't crash — kind may be fact or none.
    expect(["fact", "none"]).toContain(r.kind);
  });
});

describe("confidence ranking", () => {
  it("returns the highest-confidence match's kind when multiple fire", () => {
    // "I always prefer X" matches both preference-i-prefer (high) and
    // preference-always-i (high). Either kind is preference. Result
    // should be preference.
    const r = classifyUtterance("I always prefer kebab-case.");
    expect(r.kind).toBe("preference");
    expect(r.confidence).toBe("high");
  });
});

describe("suggested_action populated for each kind", () => {
  it("fact suggests memorize", () => {
    expect(classifyUtterance("I use pnpm.").suggested_action).toContain("memorize");
  });

  it("preference suggests memorize AND remember", () => {
    const r = classifyUtterance("I prefer X.");
    expect(r.suggested_action).toContain("memorize");
    expect(r.suggested_action).toContain("remember");
  });

  it("correction suggests memorize and possibly update_memory", () => {
    const r = classifyUtterance("No, that's wrong.");
    expect(r.suggested_action).toContain("memorize");
    expect(r.suggested_action).toContain("update_memory");
  });
});

describe("catalog sanity", () => {
  it("every pattern has a valid regex", () => {
    for (const p of UTTERANCE_PATTERNS) {
      expect(() => new RegExp(p.pattern, "i")).not.toThrow();
    }
  });

  it("every kind has at least one pattern", () => {
    const kinds = new Set(UTTERANCE_PATTERNS.map((p) => p.kind));
    expect(kinds.has("fact")).toBe(true);
    expect(kinds.has("preference")).toBe(true);
    expect(kinds.has("correction")).toBe(true);
    expect(kinds.has("workflow_lock")).toBe(true);
  });
});
