/**
 * Anti-drift declarative rule list (0.7.33 — unified-evaluator track).
 *
 * Per loop/docs/opensquid-anti-drift-unified-evaluator-design.md: one
 * declarative `Rule[]` list replaces the per-file hook handlers in
 * src/hooks/*. Each rule:
 *
 *   - `id`         stable identifier
 *   - `catches`    which D-entry (or "preexisting") this rule covers
 *   - `hook`       which lifecycle event this rule binds to
 *   - `when`       (cheap, synchronous) gate — short-circuits before
 *                  expensive `check` work
 *   - `check`      (async) returns a Verdict
 *   - `bypass`     optional env var that emergency-disables the rule
 *   - `rationale`  one-line agent-facing reason (used in error messages)
 *
 * Today the check functions DELEGATE to existing src/hooks/* helpers
 * (engine-vocab-gate, versioning-gate, workflow-gate, drift-patterns,
 * inline-report-check, etc.) so this patch ships the declarative
 * SURFACE without re-implementing every gate. The 0.7.35 cutover
 * moves the helper bodies into src/anti-drift/* and deletes the old
 * per-hook files.
 *
 * The evaluator (0.7.34) walks this list at each hook event, runs
 * applicable rules, aggregates verdicts (most-restrictive wins for
 * PreToolUse permissions; all surfaces accumulate at Stop/UPS).
 */

import { findDrifts, decide as decideDriftPatterns } from "../hooks/drift-patterns.js";
import { evaluateEngineVocabGate } from "../hooks/engine-vocab-gate.js";
import { isRecallRequired, clearRecallRequired } from "../hooks/heartbeat.js";
import { checkInlineReportFormat } from "../hooks/inline-report-check.js";
import { checkChatSendReportFormat } from "../hooks/pre-tool-use.js";
import { evaluateVersioningGate } from "../hooks/versioning-gate.js";
import { evaluateWorkflowGate } from "../hooks/workflow-gate.js";

// =====================================================================
// Types
// =====================================================================

export type HookEvent = "PreToolUse" | "Stop" | "UserPromptSubmit" | "SessionEnd";

export type Verdict =
  | { kind: "pass" }
  | { kind: "block"; message: string }
  | { kind: "warn"; message: string }
  | { kind: "surface"; message: string };

export interface HookContext {
  /** Lifecycle event this hook fire represents. */
  hookEvent: HookEvent;
  /** Claude Code session id. */
  sessionId?: string;
  /** Path to the session's JSONL transcript. */
  transcriptPath?: string;
  /** Working directory the tool will execute in. */
  cwd?: string;
  /** PreToolUse only: name of the tool about to be called. */
  toolName?: string;
  /** PreToolUse only: input object for the tool call. */
  toolInput?: Record<string, unknown>;
  /** Stop only: the just-completed assistant message text. */
  assistantText?: string;
  /** UserPromptSubmit only: the user's prompt text. */
  userPrompt?: string;
}

export interface Rule {
  id: string;
  catches: string;
  hook: HookEvent;
  when: (ctx: HookContext) => boolean;
  check: (ctx: HookContext) => Promise<Verdict>;
  bypass?: string;
  rationale: string;
}

// =====================================================================
// Helpers shared across rules
// =====================================================================

function getCommand(ctx: HookContext): string | null {
  const v = ctx.toolInput?.command;
  return typeof v === "string" ? v : null;
}

function isBypassed(rule: Rule): boolean {
  if (!rule.bypass) return false;
  return process.env[rule.bypass] === "1";
}

/** Pass-through verdict factory keeps the rule list legible. */
const PASS: Verdict = { kind: "pass" };

// =====================================================================
// The rule list (18 entries — matches the design doc)
// =====================================================================

export const RULES: Rule[] = [
  // ---------- Hard blocks (PreToolUse) ----------
  {
    id: "active-task-required",
    catches: "D1",
    hook: "PreToolUse",
    bypass: "OPENSQUID_SKIP_ACTIVE_TASK_GATE",
    rationale:
      "log_phase / chat_send without an in_progress task means the workflow-gate has nothing to validate against — exactly the D1 headline drift.",
    when: (ctx) =>
      ctx.toolName === "mcp__opensquid__log_phase" || ctx.toolName === "mcp__opensquid__chat_send",
    check: async (ctx) => {
      // Delegated to the existing readActiveTaskId for now (transcript
      // parsing). 0.7.35 cutover swaps this to state.readActiveTask.
      if (!ctx.transcriptPath) return PASS;
      const { readActiveTaskId } = await import("../hooks/transcript.js");
      try {
        const id = await readActiveTaskId(ctx.transcriptPath);
        if (id) return PASS;
      } catch {
        return PASS;
      }
      return {
        kind: "block",
        message: `🦑 [opensquid] ${ctx.toolName} called without an in_progress task. Call TaskCreate first.`,
      };
    },
  },

  {
    id: "never-amend",
    catches: "preexisting",
    hook: "PreToolUse",
    rationale:
      "git commit --amend hides iteration history per feedback_auto_commit; use a follow-up commit instead.",
    when: (ctx) => ctx.toolName === "Bash",
    check: async (ctx) => deriveDriftPatternVerdict(ctx, "never-amend"),
  },

  {
    id: "no-implicit-push",
    catches: "preexisting",
    hook: "PreToolUse",
    bypass: "OPENSQUID_SKIP_DRIFT",
    rationale: "git push requires explicit user authorization; commits stay local by default.",
    when: (ctx) => ctx.toolName === "Bash",
    check: async (ctx) => deriveDriftPatternVerdict(ctx, "no-implicit-push"),
  },

  {
    id: "no-force-push-main",
    catches: "preexisting",
    hook: "PreToolUse",
    rationale: "force-push to main/master is destructive and bypasses normal authorization.",
    when: (ctx) => ctx.toolName === "Bash",
    check: async (ctx) => deriveDriftPatternVerdict(ctx, "no-force-push-main"),
  },

  {
    id: "engine-vocab-leak",
    catches: "D6",
    hook: "PreToolUse",
    bypass: "OPENSQUID_SKIP_ENGINE_VOCAB_GATE",
    rationale:
      "engine artifacts must not name consumer products per feedback_engine_vocabulary_discipline.",
    when: (ctx) => ctx.toolName === "Bash" && /\bgit\s+commit\b/.test(getCommand(ctx) ?? ""),
    check: async (ctx) => {
      const r = await evaluateEngineVocabGate({
        cwd: ctx.cwd,
        bashCommand: getCommand(ctx) ?? undefined,
      });
      if (r.block) return { kind: "block", message: r.stderr };
      if (r.stderr) return { kind: "warn", message: r.stderr };
      return PASS;
    },
  },

  {
    id: "versioning-bump-required",
    catches: "D5+preexisting",
    hook: "PreToolUse",
    bypass: "OPENSQUID_SKIP_VERSION_GATE",
    rationale:
      "every src commit ships a matching patch bump per feedback_pre1_versioning v4 PATCH-ONLY rule.",
    when: (ctx) => ctx.toolName === "Bash" && /\bgit\s+commit\b/.test(getCommand(ctx) ?? ""),
    check: async (ctx) => {
      const r = await evaluateVersioningGate({ cwd: ctx.cwd });
      if (r.block) return { kind: "block", message: r.stderr };
      if (r.stderr) return { kind: "warn", message: r.stderr };
      return PASS;
    },
  },

  {
    id: "workflow-phases-required",
    catches: "preexisting",
    hook: "PreToolUse",
    bypass: "OPENSQUID_SKIP_WORKFLOW_GATE",
    rationale:
      "git commit requires required phases logged for the active task per feedback_workflow_cycle.",
    when: (ctx) => ctx.toolName === "Bash" && /\bgit\s+commit\b/.test(getCommand(ctx) ?? ""),
    check: async (ctx) => {
      const r = await evaluateWorkflowGate({ transcriptPath: ctx.transcriptPath });
      if (r.block) return { kind: "block", message: r.stderr };
      if (r.stderr) return { kind: "warn", message: r.stderr };
      return PASS;
    },
  },

  {
    id: "seven-phase-report-format",
    catches: "D3",
    hook: "PreToolUse",
    rationale:
      "chat_send body matching the task-report marker must include the PHASES heading per feedback_telegram_reports.",
    when: (ctx) => ctx.toolName === "mcp__opensquid__chat_send",
    check: async (ctx) => {
      const msg = checkChatSendReportFormat({
        tool: ctx.toolName ?? "",
        input: ctx.toolInput ?? {},
      });
      return msg ? { kind: "warn", message: msg } : PASS;
    },
  },

  {
    id: "heartbeat-recall-required",
    catches: "D7",
    hook: "PreToolUse",
    bypass: "OPENSQUID_SKIP_RECALL_GATE",
    rationale:
      "after a heartbeat surfaces, the next mcp__opensquid__* call must be recall to re-anchor.",
    when: (ctx) => typeof ctx.toolName === "string" && ctx.toolName.startsWith("mcp__opensquid__"),
    check: async (ctx) => {
      if (!ctx.sessionId) return PASS;
      const required = await isRecallRequired(ctx.sessionId);
      if (!required) return PASS;
      if (ctx.toolName === "mcp__opensquid__recall") {
        await clearRecallRequired(ctx.sessionId);
        return PASS;
      }
      return {
        kind: "block",
        message: `🦑 [opensquid recall-gate] ${ctx.toolName} blocked — heartbeat surfaced this turn; call mcp__opensquid__recall first.`,
      };
    },
  },

  // ---------- Soft warns (PreToolUse) ----------
  {
    id: "telegram-redirect-report",
    catches: "D2",
    hook: "PreToolUse",
    rationale:
      "task-completion reports go via mcp__opensquid__chat_send to the project report_channel, not plugin:telegram reply (DM).",
    when: (ctx) => ctx.toolName === "mcp__plugin_telegram_telegram__reply",
    check: async (ctx) => deriveDriftPatternVerdict(ctx, "telegram-redirect-report"),
  },

  {
    id: "bundled-commit",
    catches: "D4",
    hook: "PreToolUse",
    rationale:
      "prefer multiple small logical commits over one large catchall per feedback_auto_commit.",
    when: (ctx) => ctx.toolName === "Bash",
    check: async (ctx) => deriveDriftPatternVerdict(ctx, "bundled-commit"),
  },

  // ---------- Stop hook ----------
  {
    id: "inline-report-missing-phases",
    catches: "D3-inline",
    hook: "Stop",
    rationale:
      "in-session status reports must include the PHASES heading too, not just chat_send — feedback_telegram_reports applies to both surfaces.",
    when: (ctx) => Boolean(ctx.assistantText),
    check: async (ctx) => {
      const v = checkInlineReportFormat(ctx.assistantText ?? "");
      if (!v) return PASS;
      return {
        kind: "surface",
        message: `inline-report-missing-phases: message shape suggests a completion report (version_refs=${v.signals.version_refs}, commit_hashes=${v.signals.hash_refs}) but PHASES heading missing.`,
      };
    },
  },

  {
    id: "false-stop-haiku",
    catches: "D9",
    hook: "Stop",
    rationale:
      "trailing pause-prompts violate feedback_full_automation_mode; Claude Code's native prompt-type Stop hook (installed via hooks-cli) handles the Haiku classification + re-prompt loop.",
    when: () => false, // implemented as a `type: "prompt"` settings.json entry, not via this Rule.check path
    check: async () => PASS,
  },

  // ---------- UserPromptSubmit ----------
  {
    id: "multi-task-plan-injection",
    catches: "D8",
    hook: "UserPromptSubmit",
    rationale:
      "when the user lists multiple task identifiers, mirror back the parsed plan before executing to catch a misread per feedback_user_words_have_top_weight.",
    when: (ctx) => typeof ctx.userPrompt === "string",
    check: async (ctx) => {
      const { detectMultiTaskDirective } = await import("../hooks/user-prompt-submit.js");
      const msg = detectMultiTaskDirective(ctx.userPrompt ?? "");
      return msg ? { kind: "surface", message: msg } : PASS;
    },
  },

  // ---------- SessionEnd ----------
  {
    id: "drift-catalog-auto",
    catches: "D10",
    hook: "SessionEnd",
    rationale:
      "auto-catalog drift markers (user corrections, rule citations, mea culpas) so the dogfood proof writes itself.",
    when: () => true,
    check: async (ctx) => {
      if (!ctx.sessionId) return PASS;
      const { runDriftCatalogScan } = await import("../hooks/drift-catalog.js");
      try {
        const count = await runDriftCatalogScan({
          sessionId: ctx.sessionId,
          transcriptPath: ctx.transcriptPath,
          cwd: ctx.cwd,
        });
        if (count > 0) {
          return {
            kind: "warn",
            message: `🦑 [opensquid drift-catalog] recorded ${count} drift marker(s)`,
          };
        }
      } catch {
        /* fail-open per Stop/SessionEnd precedent */
      }
      return PASS;
    },
  },

  {
    id: "session-state-cleanup",
    catches: "preexisting",
    hook: "SessionEnd",
    rationale: "remove per-session ledger + state files to bound disk usage.",
    when: () => true,
    check: async (ctx) => {
      if (!ctx.sessionId) return PASS;
      const { clearSession } = await import("../hooks/honesty-ledger.js");
      try {
        await clearSession(ctx.sessionId);
      } catch {
        /* non-fatal */
      }
      return PASS;
    },
  },

  // ---------- Honesty + heartbeat (Stop hook auto-actions) ----------
  {
    id: "honesty-reconcile",
    catches: "preexisting",
    hook: "Stop",
    rationale:
      "reconcile claims-vs-actions for the just-completed turn; broken promises surface next UPS.",
    when: (ctx) => Boolean(ctx.sessionId && ctx.transcriptPath),
    check: async () => PASS, // orchestrated by the evaluator (multi-step IO); kept here for catalog completeness
  },

  {
    id: "heartbeat-arm",
    catches: "preexisting",
    hook: "Stop",
    rationale:
      "arm the heartbeat nudge when the transcript crosses the configured token threshold.",
    when: (ctx) => Boolean(ctx.sessionId && ctx.transcriptPath),
    check: async () => PASS, // orchestrated by the evaluator; same kept-for-catalog reason
  },
];

// =====================================================================
// Evaluation helpers — used by the evaluator (0.7.34) to walk RULES
// =====================================================================

/**
 * Pick the rules that apply to a given hook event AND that aren't
 * bypassed. Exported so the evaluator and tests share the same filter.
 */
export function rulesForEvent(event: HookEvent): Rule[] {
  return RULES.filter((r) => r.hook === event && !isBypassed(r));
}

/**
 * Walk applicable rules and collect verdicts. Stops at the first
 * `block` for PreToolUse events; aggregates all surfaces/warns for
 * Stop/UPS/SessionEnd events.
 */
export async function evaluateRules(ctx: HookContext): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const rule of rulesForEvent(ctx.hookEvent)) {
    if (!rule.when(ctx)) continue;
    const v = await rule.check(ctx);
    verdicts.push(v);
    // Short-circuit on PreToolUse block — match the existing
    // most-restrictive-wins semantic.
    if (ctx.hookEvent === "PreToolUse" && v.kind === "block") break;
  }
  return verdicts;
}

// =====================================================================
// Internal: drift-patterns delegation (shared by 4 rules)
// =====================================================================

/**
 * Run the existing drift-patterns catalog against the tool call and
 * extract the verdict for a specific pattern id. Returns PASS when
 * the pattern doesn't fire OR when the verdict is bypass-only.
 *
 * Lets RULES delegate to the legacy catalog while presenting the
 * declarative shape externally. The 0.7.35 cutover inlines these.
 */
async function deriveDriftPatternVerdict(ctx: HookContext, patternId: string): Promise<Verdict> {
  if (!ctx.toolName) return PASS;
  const call = { tool: ctx.toolName, input: ctx.toolInput ?? {} };
  const hits = findDrifts(call).filter((h) => h.pattern.id === patternId);
  if (hits.length === 0) return PASS;
  const { exit, stderr } = decideDriftPatterns(hits, call);
  if (exit === 2) return { kind: "block", message: stderr };
  return { kind: "warn", message: stderr };
}
