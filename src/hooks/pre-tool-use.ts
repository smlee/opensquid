/**
 * `opensquid hook pre-tool-use` — Claude Code PreToolUse hook handler.
 *
 * Wired in `~/.claude/settings.json`:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Bash",
 *           "hooks": [
 *             { "type": "command",
 *               "command": "node /path/to/opensquid/dist/index.js hook pre-tool-use" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * Stdin: JSON describing the planned tool call (Claude Code's hook
 * input schema). Stdout: empty on no-op. Stderr: drift findings.
 * Exit code: 0 to proceed, 2 to block the call.
 *
 * The catalog of intercepts lives in src/hooks/drift-patterns.ts and
 * grows lesson-by-lesson as drifts are observed and the user endorses
 * the rule.
 */

import { decide, findDrifts, type ToolCallInput } from "./drift-patterns.js";
import { recordToolCall } from "./honesty-ledger.js";
import { evaluateWorkflowGate } from "./workflow-gate.js";

interface ClaudeHookInput {
  /** Tool name (e.g. "Bash", "Edit", "Write"). */
  tool_name?: string;
  /** Tool input object — shape varies by tool. */
  tool_input?: Record<string, unknown>;
  /** Claude Code session id — used to scope the honesty ledger. */
  session_id?: string;
  /** v0.6.1 — path to the session's JSONL transcript. Used by the
   * workflow gate to detect the active task id from the most-recent
   * TodoWrite in_progress entry. Absent on some hook configurations;
   * gate is fail-open in that case. */
  transcript_path?: string;
}

/**
 * Read JSON from stdin, evaluate drifts, exit with the appropriate code.
 */
export async function runPreToolUseHook(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  // Empty stdin → nothing to evaluate. Some hook configurations may
  // pipe nothing during tests; bail gracefully.
  if (!raw.trim()) {
    process.exit(0);
  }

  let payload: ClaudeHookInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Malformed input — don't block on opensquid's own bug.
    process.stderr.write("[opensquid hook] malformed PreToolUse input — proceeding\n");
    process.exit(0);
  }

  if (!payload.tool_name || typeof payload.tool_name !== "string") {
    process.exit(0);
  }

  const call: ToolCallInput = {
    tool: payload.tool_name,
    input: payload.tool_input ?? {},
  };

  // v0.4: append to the honesty ledger so the Stop hook can reconcile
  // assistant claims against tool calls. Best-effort — never block the
  // call on a ledger write failure.
  if (payload.session_id) {
    try {
      const inputSummary = summarizeInput(call.tool, call.input);
      await recordToolCall(payload.session_id, call.tool, inputSummary);
    } catch (err) {
      process.stderr.write(
        `[opensquid hook] honesty-ledger write failed (non-fatal): ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  const hits = findDrifts(call);
  const { exit, stderr } = decide(hits);
  if (stderr) process.stderr.write(stderr);
  if (exit !== 0) {
    // Existing drift gate already blocking; don't spend RPC budget on
    // the workflow gate.
    process.exit(exit);
  }

  // v0.6.1 workflow gate — when the tool call is `git commit` (not
  // --amend, which has its own gate), check that the active task's
  // phase ledger has the required phases logged. Engine-RPC-backed,
  // so only fires when the engine binary is reachable. Fail-open on
  // any error (per [[honesty-ledger]] precedent — never block on
  // opensquid's own bug). Spawning the engine just for this check is
  // expensive (~hundreds of ms per hook), so it's scoped tightly to
  // commit commands.
  if (looksLikeGitCommit(call)) {
    try {
      const gateResult = await evaluateWorkflowGate({
        sessionId: payload.session_id,
        transcriptPath: payload.transcript_path,
      });
      if (gateResult.block) {
        process.stderr.write(gateResult.stderr);
        process.exit(2);
      } else if (gateResult.stderr) {
        // Warning only — proceed.
        process.stderr.write(gateResult.stderr);
      }
    } catch (err) {
      process.stderr.write(
        `[opensquid hook] workflow-gate failed (proceeding): ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
  process.exit(0);
}

function looksLikeGitCommit(call: ToolCallInput): boolean {
  if (call.tool !== "Bash") return false;
  const cmd = (call.input as { command?: unknown }).command;
  if (typeof cmd !== "string") return false;
  // Match `git commit ...` but NOT `git commit --amend` (handled by
  // existing drift pattern). Also skip cases where the command is
  // clearly a comment or inside quotes (drift-patterns.ts uses the
  // same quote-stripping; we duplicate the minimal version here).
  const stripped = cmd.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
  if (!/\bgit\s+commit\b/.test(stripped)) return false;
  if (/\bgit\s+commit\b[^|;&]*--amend/.test(stripped)) return false;
  return true;
}

/**
 * Tight summary of tool input for the ledger. We keep just enough to
 * reconcile claims (e.g. "did the agent run npm test?") without writing
 * the whole tool_input blob.
 */
function summarizeInput(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash") {
    const cmd = input.command;
    return typeof cmd === "string" ? cmd.slice(0, 500) : "";
  }
  if (tool === "Edit" || tool === "Write" || tool === "Read") {
    const fp = input.file_path;
    return typeof fp === "string" ? fp : "";
  }
  if (tool === "Agent") {
    const desc = input.description ?? input.subagent_type ?? "";
    return typeof desc === "string" ? desc.slice(0, 200) : "";
  }
  // Default — short JSON peek for unknown tools.
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return "";
  }
}
