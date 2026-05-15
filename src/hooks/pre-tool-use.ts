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

interface ClaudeHookInput {
  /** Tool name (e.g. "Bash", "Edit", "Write"). */
  tool_name?: string;
  /** Tool input object — shape varies by tool. */
  tool_input?: Record<string, unknown>;
  // Other fields Claude Code may send (session_id, transcript_path, etc.)
  // are ignored here; we only care about the planned call.
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

  const hits = findDrifts(call);
  const { exit, stderr } = decide(hits);
  if (stderr) process.stderr.write(stderr);
  process.exit(exit);
}
