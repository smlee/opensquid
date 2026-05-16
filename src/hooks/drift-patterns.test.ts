import { afterEach, describe, expect, it } from "vitest";

import { decide, findDrifts, stripHeredocBodies, type ToolCallInput } from "./drift-patterns.js";

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

// =====================================================================
// v0.6.5 (#136) — HEREDOC body stripping. Caught while dogfooding the
// v0.6.4 commit: the no-implicit-push drift fired against a `git commit`
// whose HEREDOC commit message body contained the literal string
// describing a regex pattern (the words `git push` appeared in prose
// describing a pattern). The hook scanned the entire bash command
// string including HEREDOC bodies → false-positive block.
//
// Fix: stripHeredocBodies runs before stripQuotedStrings so the body
// is removed before any drift regex sees it.
// =====================================================================

describe("stripHeredocBodies (v0.6.5)", () => {
  it("strips single-quoted-delimiter HEREDOC body", () => {
    const cmd = `git commit -m "$(cat <<'EOF'
This body contains git push origin main
EOF
)"`;
    expect(stripHeredocBodies(cmd)).not.toContain("git push");
  });

  it("strips unquoted-delimiter HEREDOC body", () => {
    const cmd = `cat <<MARKER
inner content with git push verbatim
MARKER`;
    expect(stripHeredocBodies(cmd)).not.toContain("git push");
  });

  it("strips double-quoted-delimiter HEREDOC body", () => {
    const cmd = `cat <<"END"
git push --force here
END`;
    expect(stripHeredocBodies(cmd)).not.toContain("git push");
  });

  it("strips tab-stripping (<<-) variant", () => {
    const cmd = `cat <<-EOF
\t\tgit push danger
\tEOF`;
    expect(stripHeredocBodies(cmd)).not.toContain("git push");
  });

  it("strips multiple HEREDOCs in one command", () => {
    const cmd = `cat <<'A'
contains git push
A
echo "between"
cat <<'B'
contains git commit --amend
B`;
    const stripped = stripHeredocBodies(cmd);
    expect(stripped).not.toContain("git push");
    expect(stripped).not.toContain("git commit --amend");
  });

  it("leaves a truncated HEREDOC (no closing delimiter) intact (fail-open)", () => {
    const cmd = `cat <<EOF
truncated body with git push but no EOF closing`;
    // No \nEOF\b on its own → regex doesn't match → fail-open
    expect(stripHeredocBodies(cmd)).toContain("git push");
  });
});

describe("drift catalog — HEREDOC false-positive resistance (v0.6.5 #136)", () => {
  it("no-implicit-push does NOT fire when 'git push' appears only in a HEREDOC commit message", () => {
    // This is the exact pattern that bit me during the v0.6.4 commit.
    const cmd = `git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat: blah

- pushed (bash_regex git push) — this LITERAL string in the message
  body would have tripped the no-implicit-push drift block before
  the v0.6.5 fix.
EOF
)"`;
    const hits = findDrifts(bash(cmd));
    expect(hits.map((h) => h.pattern.id)).not.toContain("no-implicit-push");
  });

  it("never-amend does NOT fire on 'git commit --amend' in HEREDOC commit body", () => {
    const cmd = `git commit -m "$(cat <<'EOF'
Mentioning git commit --amend in the message body for context.
EOF
)"`;
    const hits = findDrifts(bash(cmd));
    expect(hits.map((h) => h.pattern.id)).not.toContain("never-amend");
  });

  it("STILL fires when 'git push' is the actual command after a HEREDOC", () => {
    // The HEREDOC ends, then a real git push follows. Must still block.
    const cmd = `cat <<'EOF'
some prose
EOF
git push origin main`;
    const hits = findDrifts(bash(cmd));
    expect(hits.map((h) => h.pattern.id)).toContain("no-implicit-push");
  });
});

// =====================================================================
// v0.6.6 (#137) — OPENSQUID_SKIP_DRIFT emergency bypass. Mirrors
// OPENSQUID_SKIP_VERSION_GATE / OPENSQUID_SKIP_WORKFLOW_GATE shape so
// the operator only has one mental model for "this hook is wrong, get
// out of my way". The documented uninstall-hooks workaround doesn't
// actually work mid-session because Claude Code caches the settings.json
// hook command at session start.
// =====================================================================

describe("OPENSQUID_SKIP_DRIFT bypass (v0.6.6)", () => {
  // Vitest runs tests serially within a file by default; we restore the
  // env var after each test so other tests aren't tainted.
  afterEach(() => {
    delete process.env.OPENSQUID_SKIP_DRIFT;
  });

  it("ALLOWS (exit 0) with bypass warning when OPENSQUID_SKIP_DRIFT=1 and a block would fire", () => {
    process.env.OPENSQUID_SKIP_DRIFT = "1";
    const hits = findDrifts(bash("git push origin main"));
    expect(hits.length).toBeGreaterThan(0);
    const { exit, stderr } = decide(hits);
    expect(exit).toBe(0);
    expect(stderr).toContain("BYPASSED via OPENSQUID_SKIP_DRIFT=1");
    expect(stderr).toContain("no-implicit-push");
  });

  it("includes ALL hit ids in the bypass message (operator audit trail)", () => {
    process.env.OPENSQUID_SKIP_DRIFT = "1";
    const hits = findDrifts(bash("git push --force origin main"));
    const { stderr } = decide(hits);
    expect(stderr).toContain("no-implicit-push");
    expect(stderr).toContain("no-force-push-main");
  });

  it("does NOT bypass when env var is unset or != '1'", () => {
    process.env.OPENSQUID_SKIP_DRIFT = "true";
    const hits = findDrifts(bash("git push origin main"));
    const { exit } = decide(hits);
    expect(exit).toBe(2);
  });

  it("emits nothing on empty hits regardless of env var", () => {
    process.env.OPENSQUID_SKIP_DRIFT = "1";
    const { exit, stderr } = decide([]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
  });
});
