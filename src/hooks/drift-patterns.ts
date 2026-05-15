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
      "to push, override (re-run with a comment explaining).",
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
 * Remove single- and double-quoted string contents from a shell command
 * so drift patterns match REAL shell tokens, not text that happens to
 * appear inside `echo "..."`, `grep '...'`, etc.
 *
 * Approximate: doesn't handle backslash-escaped quotes, here-docs,
 * `$(...)` nesting. Sufficient for the false-positive cases we've
 * observed; tighten if a real-world counter-example surfaces.
 *
 * Replacement is empty rather than a placeholder so adjacent tokens
 * still parse correctly (e.g. `cmd "literal" && more` → `cmd  && more`).
 */
function stripQuotedStrings(s: string): string {
  return s.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "");
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
 */
export function decide(hits: DriftHit[]): {
  exit: 0 | 2;
  stderr: string;
} {
  if (hits.length === 0) return { exit: 0, stderr: "" };
  const blocks = hits.filter((h) => h.pattern.severity === "block");
  const warns = hits.filter((h) => h.pattern.severity === "warn");
  const lines: string[] = [];
  for (const h of blocks) {
    lines.push(`[opensquid drift-block] ${h.pattern.id}: ${h.pattern.message}`);
  }
  for (const h of warns) {
    lines.push(`[opensquid drift-warn]  ${h.pattern.id}: ${h.pattern.message}`);
  }
  return {
    exit: blocks.length > 0 ? 2 : 0,
    stderr: lines.join("\n") + "\n",
  };
}
