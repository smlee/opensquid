import { describe, expect, it } from "vitest";

import { CodexParseError, parseCodex, parseCodexYaml } from "./parse.js";
import { isCompositeCodex, isFocusedCodex } from "./types.js";

describe("parseCodex — focused codex", () => {
  it("accepts a minimal focused codex (id + version only)", () => {
    const c = parseCodex({ id: "minimal", version: "1.0.0" });
    expect(c.id).toBe("minimal");
    expect(isFocusedCodex(c)).toBe(true);
    expect(isCompositeCodex(c)).toBe(false);
  });

  it("accepts a fully-featured developer codex", () => {
    const c = parseCodex({
      id: "react-19",
      version: "1.0.0",
      author: { name: "anon", contact: "x@y.z" },
      license: "MIT",
      foundation: {
        tools: [{ name: "react", semver: ">=19,<20" }],
        domains: ["software-engineering", "frontend"],
      },
      activation_scope: "project",
      detected_by: [
        {
          kind: "file_match",
          path: "package.json",
          matches: { "dependencies.react": ">=19" },
        },
      ],
      seed_lessons: [
        {
          id: "atomic-search",
          trigger: "before creating a new React component",
          priority: "high",
          bank_strategy: "full",
          body_path: "lessons/atomic-search/lesson.md",
        },
      ],
      verify_gates: [
        {
          id: "atomic-boundary",
          before: { tool_call: "Write", file_pattern: "src/components/**/*.tsx" },
          require: [{ search_completed: "atoms/" }],
        },
      ],
      doc_fetch: [
        {
          trigger: "React hooks",
          url: "https://react.dev/reference/react/hooks",
          ttl_days: 30,
        },
      ],
      evolves: true,
    });
    expect(c.id).toBe("react-19");
    expect(isFocusedCodex(c)).toBe(true);
    if (isFocusedCodex(c)) {
      expect(c.foundation?.tools?.[0]?.name).toBe("react");
      expect(c.seed_lessons).toHaveLength(1);
      expect(c.evolves).toBe(true);
    }
  });

  it("accepts a methodology-only codex (no tools, no domain)", () => {
    const c = parseCodex({
      id: "tdd",
      version: "1.0.0",
      foundation: { methodologies: ["tdd"] },
      detected_by: [{ kind: "dir_exists", path: "tests/" }],
    });
    expect(isFocusedCodex(c)).toBe(true);
  });

  it("accepts a user-pinned codex (no filesystem signals)", () => {
    const c = parseCodex({
      id: "positive-discipline",
      version: "1.0.0",
      foundation: { domains: ["parenting"] },
      activation_scope: "user",
      detected_by: [{ kind: "user_pinned" }],
    });
    expect(isFocusedCodex(c)).toBe(true);
    if (isFocusedCodex(c)) {
      expect(c.activation_scope).toBe("user");
    }
  });

  it("accepts structured trigger objects", () => {
    const c = parseCodex({
      id: "x",
      version: "1.0.0",
      seed_lessons: [
        {
          id: "l1",
          trigger: {
            intent: "before doing X",
            prescriptive_form: "You MUST do X first",
          },
          body_path: "lessons/l1/lesson.md",
        },
      ],
    });
    expect(isFocusedCodex(c)).toBe(true);
  });

  it("accepts nested all_of / any_of detection", () => {
    const c = parseCodex({
      id: "x",
      version: "1.0.0",
      detected_by: [
        {
          kind: "all_of",
          conditions: [
            { kind: "file_exists", path: "a" },
            {
              kind: "any_of",
              conditions: [
                { kind: "dir_exists", path: "b" },
                { kind: "dir_exists", path: "c" },
              ],
            },
          ],
        },
      ],
    });
    expect(isFocusedCodex(c)).toBe(true);
  });
});

describe("parseCodex — composite codex", () => {
  it("accepts a composite codex (pure aggregator)", () => {
    const c = parseCodex({
      id: "fullstack-react-atomic",
      kind: "composite",
      version: "1.0.0",
      includes: [
        { id: "react", semver: ">=18,<20" },
        { id: "tailwindcss", semver: ">=4" },
        { id: "atomic-design", semver: ">=1" },
      ],
    });
    expect(isCompositeCodex(c)).toBe(true);
    if (isCompositeCodex(c)) {
      expect(c.includes).toHaveLength(3);
    }
  });

  it("rejects composite without includes", () => {
    expect(() => parseCodex({ id: "x", kind: "composite", version: "1.0.0" })).toThrow(
      CodexParseError,
    );
  });

  it("rejects composite with empty includes array", () => {
    expect(() =>
      parseCodex({ id: "x", kind: "composite", version: "1.0.0", includes: [] }),
    ).toThrow(CodexParseError);
  });
});

describe("parseCodex — validation errors", () => {
  it("rejects missing id", () => {
    expect(() => parseCodex({ version: "1.0.0" })).toThrow(CodexParseError);
  });

  it("rejects missing version", () => {
    expect(() => parseCodex({ id: "x" })).toThrow(CodexParseError);
  });

  it("rejects invalid activation_scope", () => {
    expect(() => parseCodex({ id: "x", version: "1.0.0", activation_scope: "bogus" })).toThrow(
      CodexParseError,
    );
  });

  it("rejects invalid bank_strategy", () => {
    expect(() =>
      parseCodex({
        id: "x",
        version: "1.0.0",
        seed_lessons: [
          {
            id: "l1",
            trigger: "t",
            body_path: "p",
            bank_strategy: "weird",
          },
        ],
      }),
    ).toThrow(CodexParseError);
  });

  it("rejects unknown detection kind", () => {
    expect(() =>
      parseCodex({
        id: "x",
        version: "1.0.0",
        detected_by: [{ kind: "bogus_kind", path: "x" }],
      }),
    ).toThrow(CodexParseError);
  });

  it("rejects non-https URL in doc_fetch", () => {
    expect(() =>
      parseCodex({
        id: "x",
        version: "1.0.0",
        doc_fetch: [{ trigger: "t", url: "not-a-url" }],
      }),
    ).toThrow(CodexParseError);
  });

  it("includes structured zod issues in error", () => {
    try {
      parseCodex({ version: "1.0.0" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexParseError);
      const e = err as CodexParseError;
      expect(e.issues).toBeDefined();
      expect(e.issues?.length).toBeGreaterThan(0);
    }
  });
});

describe("parseCodexYaml", () => {
  it("parses minimal YAML", () => {
    const yaml = `
id: minimal
version: 1.0.0
`;
    const c = parseCodexYaml(yaml);
    expect(c.id).toBe("minimal");
  });

  it("parses fully-featured YAML round-trip", () => {
    const yaml = `
id: react-19
version: 1.0.0
foundation:
  tools:
    - { name: react, semver: ">=19,<20" }
  domains: [software-engineering, frontend]
activation_scope: project
detected_by:
  - kind: dir_exists
    path: "src/components/atoms"
seed_lessons:
  - id: atomic-search
    trigger: "before creating a component"
    priority: high
    bank_strategy: full
    body_path: "lessons/atomic-search/lesson.md"
evolves: true
`;
    const c = parseCodexYaml(yaml);
    expect(isFocusedCodex(c)).toBe(true);
    if (isFocusedCodex(c)) {
      expect(c.foundation?.tools?.[0]?.name).toBe("react");
      expect(c.detected_by?.[0]?.kind).toBe("dir_exists");
    }
  });

  it("throws CodexParseError on YAML syntax error", () => {
    expect(() => parseCodexYaml("id: x\n  bad: indentation: here")).toThrow(CodexParseError);
  });

  it("throws CodexParseError on non-object root", () => {
    expect(() => parseCodexYaml("just a string")).toThrow(CodexParseError);
  });
});
