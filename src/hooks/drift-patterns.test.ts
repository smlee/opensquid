import { describe, expect, it } from "vitest";

import { decide, findDrifts, type ToolCallInput } from "./drift-patterns.js";

function bash(command: string): ToolCallInput {
  return { tool: "Bash", input: { command } };
}

describe("drift catalog — never-amend", () => {
  it("blocks `git commit --amend`", () => {
    const hits = findDrifts(bash('git commit --amend -m "fix typo"'));
    expect(hits.map((h) => h.pattern.id)).toContain("never-amend");
    expect(decide(hits).exit).toBe(2);
  });

  it("blocks `git commit -a --amend`", () => {
    const hits = findDrifts(bash("git commit -a --amend"));
    expect(hits.map((h) => h.pattern.id)).toContain("never-amend");
  });

  it("doesn't fire on a normal `git commit -m`", () => {
    const hits = findDrifts(bash('git commit -m "regular commit"'));
    expect(hits.map((h) => h.pattern.id)).not.toContain("never-amend");
  });
});

describe("drift catalog — no-implicit-push", () => {
  it("blocks `git push`", () => {
    const hits = findDrifts(bash("git push origin main"));
    expect(hits.map((h) => h.pattern.id)).toContain("no-implicit-push");
    expect(decide(hits).exit).toBe(2);
  });

  it("blocks `git push -u origin feature`", () => {
    const hits = findDrifts(bash("git push -u origin feature/x"));
    expect(hits.map((h) => h.pattern.id)).toContain("no-implicit-push");
  });

  it("force-push to main is ALSO caught by both rules", () => {
    const hits = findDrifts(bash("git push --force origin main"));
    const ids = hits.map((h) => h.pattern.id);
    expect(ids).toContain("no-implicit-push");
    expect(ids).toContain("no-force-push-main");
    expect(decide(hits).exit).toBe(2);
  });

  it("doesn't fire on `git pull` or `git status`", () => {
    expect(findDrifts(bash("git pull")).length).toBe(0);
    expect(findDrifts(bash("git status")).length).toBe(0);
  });
});

describe("drift catalog — substrate-purity (engine commits)", () => {
  it("warns on engine commit message referencing 'codex'", () => {
    const hits = findDrifts(
      bash('cd /Users/slee/projects/loop/engine && git commit -m "v1.1: codex support"'),
    );
    expect(hits.map((h) => h.pattern.id)).toContain("substrate-purity");
    // Severity = warn, so exit stays 0 (call proceeds).
    expect(decide(hits).exit).toBe(0);
  });

  it("warns on engine commit referencing 'opensquid'", () => {
    const hits = findDrifts(
      bash('cd ~/projects/loop/engine && git commit -m "support for opensquid pack"'),
    );
    expect(hits.map((h) => h.pattern.id)).toContain("substrate-purity");
  });

  it("doesn't fire on substrate-pure engine commits", () => {
    const hits = findDrifts(
      bash('cd /Users/slee/projects/loop/engine && git commit -m "v1.1: Pack authorship"'),
    );
    expect(hits.map((h) => h.pattern.id)).not.toContain("substrate-purity");
  });

  it("doesn't fire on opensquid commits mentioning codex (correct context)", () => {
    const hits = findDrifts(
      bash('cd /Users/slee/projects/opensquid && git commit -m "v0.4: codex CLI"'),
    );
    expect(hits.map((h) => h.pattern.id)).not.toContain("substrate-purity");
  });
});

describe("decide — combining hits", () => {
  it("returns exit 0 + empty stderr on no hits", () => {
    const { exit, stderr } = decide([]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
  });

  it("returns exit 2 if any hit is severity=block", () => {
    const hits = findDrifts(bash("git push --force origin main"));
    const { exit, stderr } = decide(hits);
    expect(exit).toBe(2);
    expect(stderr).toContain("BLOCKED");
  });

  it("returns exit 0 + stderr on warn-only hits", () => {
    const hits = findDrifts(
      bash('cd /Users/slee/projects/loop/engine && git commit -m "codex stuff"'),
    );
    const { exit, stderr } = decide(hits);
    expect(exit).toBe(0);
    expect(stderr).toContain("WARN");
  });
});

describe("non-bash tools are not matched by bash rules", () => {
  it("Edit calls bypass git rules", () => {
    const call: ToolCallInput = {
      tool: "Edit",
      input: { file_path: "/x/y", old_string: "git commit --amend", new_string: "" },
    };
    expect(findDrifts(call).length).toBe(0);
  });
});

describe("false-positive resistance — patterns inside quoted strings", () => {
  it("never-amend ignores --amend inside double-quoted string", () => {
    const hits = findDrifts(bash('echo "git commit --amend in a string literal"'));
    expect(hits.map((h) => h.pattern.id)).not.toContain("never-amend");
  });

  it("never-amend ignores --amend inside single-quoted string", () => {
    const hits = findDrifts(bash("grep 'git commit --amend' file.txt"));
    expect(hits.map((h) => h.pattern.id)).not.toContain("never-amend");
  });

  it("no-implicit-push ignores 'git push' in an echo literal", () => {
    const hits = findDrifts(bash('echo "to deploy run git push origin main"'));
    expect(hits.map((h) => h.pattern.id)).not.toContain("no-implicit-push");
  });

  it("never-amend STILL fires when amend is a real shell token", () => {
    const hits = findDrifts(bash('git commit --amend -m "fix typo"'));
    expect(hits.map((h) => h.pattern.id)).toContain("never-amend");
  });

  it("never-amend fires after shell continuation (&&, ;, |)", () => {
    expect(findDrifts(bash("cd /repo && git commit --amend")).map((h) => h.pattern.id)).toContain(
      "never-amend",
    );
    expect(findDrifts(bash("foo; git commit --amend")).map((h) => h.pattern.id)).toContain(
      "never-amend",
    );
  });
});
