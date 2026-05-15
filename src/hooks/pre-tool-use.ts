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

interface ClaudeHookInput {
  /** Tool name (e.g. "Bash", "Edit", "Write"). */
  tool_name?: string;
  /** Tool input object — shape varies by tool. */
  tool_input?: Record<string, unknown>;
  /** Claude Code session id — used to scope the honesty ledger. */
  session_id?: string;
  // Other fields Claude Code may send (transcript_path etc.) are ignored.
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
  process.exit(exit);
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
