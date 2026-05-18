/**
 * Anti-drift evaluator (0.7.34 — unified-evaluator track).
 *
 * Single orchestrator that replaces the per-file hook handlers in
 * src/hooks/. Binds the 4 Claude Code hook events (PreToolUse, Stop,
 * UserPromptSubmit, SessionEnd) to the declarative RULES list from
 * rules.ts.
 *
 * Each runner:
 *   1. Reads JSON from stdin (Claude Code's hook payload)
 *   2. Builds a HookContext from the payload + transcript scan
 *   3. Calls evaluateRules(ctx) to walk applicable rules
 *   4. Aggregates verdicts per event semantic:
 *        PreToolUse → exit 2 on first block; warns → stderr + exit 0
 *        Stop       → surfaces → violations.log (UPS picks up); +
 *                     honesty-reconcile + heartbeat-arm legacy
 *        UPS        → surfaces → stdout (Claude Code injects);
 *                     + resume detection + broken-promises +
 *                     heartbeat-pending consume (preexisting)
 *        SessionEnd → auto-actions only (catalog + cleanup)
 *
 * Lives alongside src/hooks/ until the 0.7.35 cutover deletes the
 * old per-file handlers and points hooks-cli at this entrypoint.
 */

import { evaluateRules, type HookContext, type Verdict } from "./rules.js";
import { appendViolation } from "./state.js";

// =====================================================================
// Stdin helpers
// =====================================================================

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
}

function parsePayload(raw: string): HookPayload | null {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return null;
  }
}

// =====================================================================
// PreToolUse runner
// =====================================================================

/**
 * PreToolUse: walk PreToolUse rules. First block-verdict short-circuits
 * exit 2; warns accumulate to stderr; pass through otherwise.
 *
 * Exported for direct testing.
 */
export async function runPreToolUseEvaluator(payload: HookPayload): Promise<{
  exit: 0 | 2;
  stderr: string;
}> {
  if (!payload.tool_name) return { exit: 0, stderr: "" };

  const ctx: HookContext = {
    hookEvent: "PreToolUse",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    toolName: payload.tool_name,
    toolInput: payload.tool_input ?? {},
  };

  const verdicts = await evaluateRules(ctx);
  return aggregatePreToolUse(verdicts);
}

export function aggregatePreToolUse(verdicts: Verdict[]): { exit: 0 | 2; stderr: string } {
  const blocks: Verdict[] = [];
  const warns: Verdict[] = [];
  for (const v of verdicts) {
    if (v.kind === "block") blocks.push(v);
    else if (v.kind === "warn") warns.push(v);
  }
  const messages: string[] = [];
  for (const b of blocks) messages.push(b.kind === "block" ? b.message : "");
  for (const w of warns) messages.push(w.kind === "warn" ? w.message : "");
  const stderr = messages.filter(Boolean).join("\n");
  return {
    exit: blocks.length > 0 ? 2 : 0,
    stderr: stderr ? stderr + (stderr.endsWith("\n") ? "" : "\n") : "",
  };
}

// =====================================================================
// Stop runner
// =====================================================================

/**
 * Stop: walk Stop rules. Surfaces → violations.log (next UPS picks up).
 * Always exit 0 (Stop is observational, not blocking — exit 2 would
 * trigger Claude Code's re-prompt loop which is D9 territory).
 *
 * Exported for direct testing.
 */
export async function runStopEvaluator(payload: HookPayload): Promise<{ stderr: string }> {
  if (!payload.session_id) return { stderr: "" };

  // Read the last assistant text from the transcript (delegated to
  // the existing helper for now; 0.7.35 cutover migrates).
  let assistantText = "";
  if (payload.transcript_path) {
    try {
      const { readLastAssistantText } = await import("../hooks/transcript.js");
      assistantText = await readLastAssistantText(payload.transcript_path);
    } catch {
      /* fail-open */
    }
  }

  const ctx: HookContext = {
    hookEvent: "Stop",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    assistantText,
  };

  const verdicts = await evaluateRules(ctx);
  const stderrLines: string[] = [];

  for (const v of verdicts) {
    if (v.kind === "surface") {
      try {
        await appendViolation(payload.session_id, {
          ts: new Date().toISOString(),
          rule_id: "stop-surface",
          verdict: "surface",
          reason: v.message,
        });
      } catch {
        /* best-effort */
      }
      stderrLines.push(`🦑 [opensquid] ${v.message}`);
    } else if (v.kind === "warn") {
      stderrLines.push(v.message);
    }
  }

  return { stderr: stderrLines.join("\n") + (stderrLines.length > 0 ? "\n" : "") };
}

// =====================================================================
// UserPromptSubmit runner
// =====================================================================

/**
 * UserPromptSubmit: walk UPS rules. Surfaces → stdout (Claude Code
 * injects into agent context). Always exit 0.
 *
 * Exported for direct testing.
 */
export async function runUserPromptSubmitEvaluator(
  payload: HookPayload,
): Promise<{ stdout: string }> {
  if (!payload.session_id) return { stdout: "" };

  const ctx: HookContext = {
    hookEvent: "UserPromptSubmit",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    userPrompt: payload.prompt,
  };

  const verdicts = await evaluateRules(ctx);
  const stdoutLines: string[] = [];
  for (const v of verdicts) {
    if (v.kind === "surface" || v.kind === "warn") {
      stdoutLines.push(v.message);
    }
  }
  return { stdout: stdoutLines.length > 0 ? stdoutLines.join("\n") + "\n" : "" };
}

// =====================================================================
// SessionEnd runner
// =====================================================================

/**
 * SessionEnd: walk SessionEnd rules (auto-actions like drift-catalog
 * scan + state cleanup). Always exit 0.
 *
 * Exported for direct testing.
 */
export async function runSessionEndEvaluator(payload: HookPayload): Promise<{ stderr: string }> {
  if (!payload.session_id) return { stderr: "" };

  const ctx: HookContext = {
    hookEvent: "SessionEnd",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
  };

  const verdicts = await evaluateRules(ctx);
  const stderrLines: string[] = [];
  for (const v of verdicts) {
    if (v.kind === "warn" || v.kind === "surface") {
      stderrLines.push(v.message);
    }
  }
  return { stderr: stderrLines.join("\n") + (stderrLines.length > 0 ? "\n" : "") };
}

// =====================================================================
// Unified dispatcher — used by the CLI entrypoint
// =====================================================================

export type HookEventName = "pre-tool-use" | "stop" | "user-prompt-submit" | "session-end";

/**
 * Run the evaluator for the specified hook event by reading stdin,
 * dispatching to the right runner, writing the output, and exiting.
 *
 * Wired into the CLI as `opensquid anti-drift <event>` at the 0.7.35
 * cutover; until then, the existing `opensquid hook <event>` handlers
 * in src/hooks/* run.
 */
export async function runEvaluator(event: HookEventName): Promise<void> {
  const raw = await readStdin();
  const payload = parsePayload(raw);
  if (!payload) {
    process.exit(0);
  }

  switch (event) {
    case "pre-tool-use": {
      const { exit, stderr } = await runPreToolUseEvaluator(payload);
      if (stderr) process.stderr.write(stderr);
      process.exit(exit);
      break;
    }
    case "stop": {
      const { stderr } = await runStopEvaluator(payload);
      if (stderr) process.stderr.write(stderr);
      process.exit(0);
      break;
    }
    case "user-prompt-submit": {
      const { stdout } = await runUserPromptSubmitEvaluator(payload);
      if (stdout) process.stdout.write(stdout);
      process.exit(0);
      break;
    }
    case "session-end": {
      const { stderr } = await runSessionEndEvaluator(payload);
      if (stderr) process.stderr.write(stderr);
      process.exit(0);
      break;
    }
  }
}
