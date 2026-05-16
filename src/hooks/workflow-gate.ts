/**
 * Workflow gate — engine-backed commit-blocking check (v0.6.1).
 *
 * Wired into the PreToolUse hook when the planned tool call is
 * `git commit` (without `--amend`). Checks that the active task's
 * phase ledger has the required workflow phases logged; blocks the
 * commit with an actionable stderr message if not.
 *
 * The required-phase policy is fixed for now (per user direction):
 * `audit` + `post_research` must be logged. These are the phases
 * empirically skipped under "ship fast" pressure. The other phases
 * (pre_research, learn, code, test, fix) are either obvious from the
 * commit itself or naturally happen — gating them too creates
 * paperwork friction without catching real drift.
 *
 * Fail-open invariant: any error reaching the engine, parsing the
 * transcript, or detecting the active task → return non-blocking
 * with a stderr warning. The gate is best-effort drift protection,
 * not a hard safety wall (mirrors the honesty-ledger precedent at
 * pre-tool-use.ts).
 */

import { OpenSquidEngine } from "../engine-client.js";

import { readActiveTaskId } from "./transcript.js";

/** Phases that must be logged before `git commit` is allowed. */
const REQUIRED_PHASES = ["audit", "post_research"] as const;

export interface WorkflowGateInput {
  /** Claude Code session id. Optional — gate is no-op without it. */
  sessionId?: string;
  /** Path to the session's JSONL transcript. Optional — gate falls
   * back to allow-commit when absent (can't detect active task). */
  transcriptPath?: string;
}

export interface WorkflowGateResult {
  /** True when the commit should be blocked. */
  block: boolean;
  /** Stderr message (always present when stderr should be written;
   * non-blocking warnings also use this). */
  stderr: string;
}

/**
 * Evaluate whether the planned `git commit` should be blocked.
 * Pure function over its inputs + an engine RPC; safe to call from
 * the hook handler.
 */
export async function evaluateWorkflowGate(input: WorkflowGateInput): Promise<WorkflowGateResult> {
  // Emergency override — explicit env var bypass with loud warning.
  if (checkOverrideEnv()) {
    return {
      block: false,
      stderr: "🦑 [opensquid workflow-gate] BYPASSED via OPENSQUID_SKIP_WORKFLOW_GATE=1\n",
    };
  }
  if (!input.sessionId) {
    // Hook didn't get a session id — can't query the ledger. Allow.
    return { block: false, stderr: "" };
  }
  if (!input.transcriptPath) {
    // Can't detect active task. Allow with a debug-level warn so the
    // gate's absence is observable.
    return {
      block: false,
      stderr: "[opensquid workflow-gate] no transcript_path — gate skipped\n",
    };
  }

  let taskId: string | null = null;
  try {
    taskId = await readActiveTaskId(input.transcriptPath);
  } catch (err) {
    return {
      block: false,
      stderr: `[opensquid workflow-gate] transcript read failed (proceeding): ${err instanceof Error ? err.message : err}\n`,
    };
  }
  if (!taskId) {
    // No active task — nothing to gate. Common case: ad-hoc commits
    // outside any TaskCreate flow. Allow silently.
    return { block: false, stderr: "" };
  }

  const engine = new OpenSquidEngine();
  let ledger: { phases_logged: string[] } | null = null;
  try {
    ledger = await engine.getTaskLedger({
      session_id: input.sessionId,
      task_id: taskId,
    });
  } catch (err) {
    // Engine unreachable, binary missing, RPC error. Fail-open.
    return {
      block: false,
      stderr: `[opensquid workflow-gate] engine unreachable (proceeding): ${err instanceof Error ? err.message : err}\n`,
    };
  } finally {
    // The OpenSquidEngine wrapper spawns a subprocess; shut it down
    // so the hook process can exit cleanly.
    try {
      engine.shutdown();
    } catch {
      /* best-effort */
    }
  }

  const logged = new Set(ledger.phases_logged);
  const missing = REQUIRED_PHASES.filter((p) => !logged.has(p));
  if (missing.length === 0) {
    return { block: false, stderr: "" };
  }

  return {
    block: true,
    stderr: buildBlockMessage(taskId, missing, ledger.phases_logged),
  };
}

function buildBlockMessage(
  taskId: string,
  missing: readonly string[],
  loggedPhases: readonly string[],
): string {
  const loggedList = loggedPhases.length === 0 ? "(none)" : loggedPhases.join(", ");
  return (
    `🦑 [opensquid workflow-gate] commit blocked for task ${taskId}\n` +
    `  missing phases: ${missing.join(", ")}\n` +
    `  logged phases:  ${loggedList}\n` +
    `  Log the missing phases via the \`log_phase\` MCP tool, then retry the commit.\n` +
    `  Override (genuine emergency): set OPENSQUID_SKIP_WORKFLOW_GATE=1 for this command.\n`
  );
}

/**
 * Emergency-override env var. Lets the user bypass the gate when they
 * know what they're doing. Logged loudly to stderr so the bypass is
 * always visible in scrollback / CI logs.
 *
 * Exported for the test suite.
 */
export function checkOverrideEnv(): boolean {
  return process.env.OPENSQUID_SKIP_WORKFLOW_GATE === "1";
}
