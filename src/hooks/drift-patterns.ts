/**
 * Drift pattern catalog — known anti-patterns opensquid intercepts at
 * the Claude Code PreToolUse hook before the agent commits the action.
 *
 * Each pattern has:
 *  - `id` — stable identifier for the rule
 *  - `trigger` — matcher against tool call input
 *  - `lesson` — short reference to the lesson that owns this rule
 *  - `message` — what the agent sees in stderr when intercepted
 *  - `severity` — "block" (exit 2 stops the call) or "warn" (stderr
 *    only, call proceeds)
 *
 * Patterns are CONSERVATIVE on purpose: we'd rather miss a drift than
 * spam false positives. The catalog grows lesson-by-lesson as new
 * drifts are observed and the user endorses the rule.
 */

export type DriftSeverity = "block" | "warn";

export interface DriftPattern {
  id: string;
  /** Tool name to match (e.g. "Bash", "Edit", "Write"). */
  tool: "Bash" | "Edit" | "Write" | "*";
  /** Matcher applied to the relevant tool input field. */
  trigger: DriftTrigger;
  /** Lesson id (in the workflow codex) that owns this rule. */
  lesson: string;
  /** Short, agent-facing explanation surfaced when triggered. */
  message: string;
  severity: DriftSeverity;
}

export type DriftTrigger =
  | { kind: "bash_contains"; needle: string; strip_quotes?: boolean }
  | { kind: "bash_regex"; pattern: string; strip_quotes?: boolean }
  | { kind: "text_regex"; pattern: string; field: string };

// ---------------------------------------------------------------------
// Catalog — start with drifts observed in actual build sessions
// ---------------------------------------------------------------------

export const DRIFT_PATTERNS: DriftPattern[] = [
  // 1. git commit --amend — never amend (locked override, 2026-05-15)
  {
    id: "never-amend",
    tool: "Bash",
    trigger: { kind: "bash_regex", pattern: "git\\s+commit\\b[^\\n]*\\s--amend\\b" },
    lesson: "auto-commit",
    severity: "block",
    message:
      "BLOCKED: `git commit --amend` violates the never-amend rule (CLAUDE.md " +
      "claude-overrides:v1, feedback_auto_commit). Even on unpushed commits — " +
      "make a follow-up commit instead. Override only if the user explicitly " +
      "requested an amend in THIS turn.",
  },

  // 2. git push without explicit user request — block by default
  {
    id: "no-implicit-push",
    tool: "Bash",
    trigger: { kind: "bash_regex", pattern: "git\\s+push\\b" },
    lesson: "auto-commit",
    severity: "block",
    message:
      "BLOCKED: `git push` requires explicit user authorization. " +
      "Commits stay local until the user says push. If the user just said " +
      "to push (or has pre-authorized pushes per CLAUDE.md), bypass with " +
      "OPENSQUID_SKIP_DRIFT=1 for this command.",
  },

  // 3. Engine commit subject containing consumer-product strings
  //    (substrate-purity rule). Heuristic: matches `git commit -m` in a
  //    bash command whose body contains `codex`, `opensquid`, or
  //    `MindCraftor` AND is running inside engine/.
  //
  //    This one INTENTIONALLY peeks inside the -m "..." quoted message,
  //    so it opts out of the default quote stripping.
  {
    id: "substrate-purity",
    tool: "Bash",
    trigger: {
      kind: "bash_regex",
      pattern: "loop/engine.*git\\s+commit[^\\n]*-m[^\\n]*(codex|opensquid|MindCraftor)",
      strip_quotes: false,
    },
    lesson: "code-quality",
    severity: "warn",
    message:
      "WARN: engine commit message appears to reference a consumer-product " +
      "concept (codex / opensquid / MindCraftor). Engine commit messages " +
      "must stay substrate-pure — engine speaks in engine types only. " +
      "Re-word using Pack provenance / lesson / authorship terminology.",
  },

  // 4. Force-push to main/master — extra protection on top of #2
  {
    id: "no-force-push-main",
    tool: "Bash",
    trigger: {
      kind: "bash_regex",
      pattern: "git\\s+push\\b[^\\n]*(--force|-f)\\b[^\\n]*\\b(main|master)\\b",
    },
    lesson: "auto-commit",
    severity: "block",
    message:
      "BLOCKED: force-push to main/master is destructive. Requires explicit " +
      "user request — and even then, prefer a regular push or a new branch.",
  },
];

// ---------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------

export interface ToolCallInput {
  tool: string;
  input: Record<string, unknown>;
}

export interface DriftHit {
  pattern: DriftPattern;
}

/**
 * Run the catalog against a tool call. Returns every matching pattern;
 * caller decides block-vs-warn based on highest severity.
 */
export function findDrifts(call: ToolCallInput): DriftHit[] {
  const hits: DriftHit[] = [];
  for (const pattern of DRIFT_PATTERNS) {
    if (pattern.tool !== "*" && pattern.tool !== call.tool) continue;
    if (matches(pattern.trigger, call)) {
      hits.push({ pattern });
    }
  }
  return hits;
}

function matches(trigger: DriftTrigger, call: ToolCallInput): boolean {
  switch (trigger.kind) {
    case "bash_contains": {
      const cmd = stringField(call.input, "command");
      if (cmd === null) return false;
      const haystack = trigger.strip_quotes === false ? cmd : stripQuotedStrings(cmd);
      return haystack.includes(trigger.needle);
    }
    case "bash_regex": {
      const cmd = stringField(call.input, "command");
      if (cmd === null) return false;
      const haystack = trigger.strip_quotes === false ? cmd : stripQuotedStrings(cmd);
      try {
        return new RegExp(trigger.pattern).test(haystack);
      } catch {
        return false;
      }
    }
    case "text_regex": {
      const text = stringField(call.input, trigger.field);
      if (text === null) return false;
      try {
        return new RegExp(trigger.pattern).test(text);
      } catch {
        return false;
      }
    }
  }
}

/**
 * Remove single- and double-quoted string contents PLUS HEREDOC bodies
 * from a shell command so drift patterns match REAL shell tokens, not
 * text that happens to appear inside `echo "..."`, `grep '...'`, or a
 * `git commit -m "$(cat <<'EOF' ... EOF)"` body.
 *
 * Approximate: doesn't handle backslash-escaped quotes or `$(...)`
 * nesting beyond the HEREDOC. Sufficient for the false-positive cases
 * observed in real Claude Code sessions; tighten if a real-world
 * counter-example surfaces.
 *
 * v0.6.5 (#136) — added HEREDOC body stripping. Previously, a
 * `git commit -m` with a HEREDOC message body containing the literal
 * string "git push" would false-fire the no-implicit-push drift block
 * because the entire HEREDOC body was part of the bash command string.
 * Now the body is stripped before pattern matching. Caught dogfooding
 * the v0.6.4 commit (commit message described regex patterns containing
 * the word "git push" and the drift-block fired against itself).
 *
 * Replacement is empty rather than a placeholder so adjacent tokens
 * still parse correctly (e.g. `cmd "literal" && more` → `cmd  && more`).
 */
function stripQuotedStrings(s: string): string {
  return stripHeredocBodies(s)
    .replace(/'[^']*'/g, "")
    .replace(/"[^"]*"/g, "");
}

/**
 * Strip HEREDOC bodies (`<<DELIM ... DELIM` and variants) from a
 * shell command.
 *
 * Recognizes:
 *   <<EOF ... \nEOF        (unquoted delimiter, expansion-allowing)
 *   <<'EOF' ... \nEOF      (single-quoted, literal body)
 *   <<"EOF" ... \nEOF      (double-quoted, literal body)
 *   <<-EOF ... \nEOF       (tab-stripping mode)
 *   <<-'EOF' ... \nEOF     (combined)
 *
 * Delimiter is any word-char sequence (EOF, END, HERE, MARKER, etc.).
 * Lazy `[\s\S]*?` matches across newlines; `\b` after the backref
 * ensures `EOFX` doesn't close an `<<EOF` block.
 *
 * If a HEREDOC has no closing delimiter (truncated input), regex
 * doesn't match and the body stays intact — fail-open behavior.
 *
 * Exported for direct unit testing.
 */
export function stripHeredocBodies(s: string): string {
  // `\n[ \t]*\1\b` — allow leading whitespace before the closing
  // delimiter so the `<<-DELIM` (tab-stripping) variant matches its
  // indented closing line (`\t\tEOF`). The permissive whitespace
  // also covers the plain `<<DELIM` case where users sometimes
  // accidentally indent the closing line — no real harm.
  return s.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n[ \t]*\1\b/g, "");
}

function stringField(input: Record<string, unknown>, field: string): string | null {
  const v = input[field];
  return typeof v === "string" ? v : null;
}

/**
 * Decide the final exit code + message from a list of hits.
 *
 * - Any "block" hit → exit 2 with all blocking messages
 * - Only "warn" hits → exit 0, print warnings to stderr
 * - No hits → exit 0 silently
 *
 * Emergency bypass: `OPENSQUID_SKIP_DRIFT=1` downgrades every block to
 * an audit-trail warning (exit 0, stderr explains the bypass). Two ways
 * to set it:
 *
 *   1. Parent process env — useful for whole-session bypass (e.g. set
 *      before launching Claude Code).
 *   2. Inline command prefix — e.g. `OPENSQUID_SKIP_DRIFT=1 git push`.
 *      The hook reads the COMMAND STRING from the Bash tool input and
 *      sees the prefix even though the env var never reaches the hook's
 *      own process.env (the hook is a sibling subprocess spawned by
 *      Claude Code, not a child of the would-be Bash subprocess).
 *
 * Matches the shape of the version-gate (`OPENSQUID_SKIP_VERSION_GATE=1`)
 * and workflow-gate (`OPENSQUID_SKIP_WORKFLOW_GATE=1`) bypasses so the
 * operator only has one mental model — except those two only check
 * process.env (their hooks happen before any command runs); drift-
 * patterns additionally checks the command-string prefix so the bypass
 * can be requested per-command from within an existing session.
 */
export function decide(hits: DriftHit[], call?: ToolCallInput): {
  exit: 0 | 2;
  stderr: string;
} {
  if (hits.length === 0) return { exit: 0, stderr: "" };
  if (isDriftBypassed(call)) {
    const ids = hits.map((h) => h.pattern.id).join(", ");
    return {
      exit: 0,
      stderr: `🦑 [opensquid drift-patterns] BYPASSED via OPENSQUID_SKIP_DRIFT=1 (hits: ${ids})\n`,
    };
  }
  const blocks = hits.filter((h) => h.pattern.severity === "block");
  const warns = hits.filter((h) => h.pattern.severity === "warn");
  const lines: string[] = [];
  for (const h of blocks) {
    lines.push(`🦑 [opensquid drift-block] ${h.pattern.id}: ${h.pattern.message}`);
  }
  for (const h of warns) {
    lines.push(`🦑 [opensquid drift-warn]  ${h.pattern.id}: ${h.pattern.message}`);
  }
  return {
    exit: blocks.length > 0 ? 2 : 0,
    stderr: lines.join("\n") + "\n",
  };
}

function isDriftBypassed(call?: ToolCallInput): boolean {
  if (process.env.OPENSQUID_SKIP_DRIFT === "1") return true;
  if (!call) return false;
  const cmd = stringField(call.input, "command");
  if (cmd === null) return false;
  // Inline prefix: zero or more env-var assignments may precede the
  // bypass var. Permissive on whitespace; strict on the value (must be
  // literally "1" to match the env-var semantics).
  return /(^|\s|;|&&)\s*OPENSQUID_SKIP_DRIFT=1(\s|$)/.test(cmd);
}
