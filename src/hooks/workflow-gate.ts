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

import { loadBundledDefaultCodex } from "../codex/loader.js";
import { OpenSquidEngine } from "../engine-client.js";

import { readActiveTaskId } from "./transcript.js";

/**
 * Resolve the set of phases that must be logged before `git commit`
 * is allowed.
 *
 * 0.7.16 (drift-as-codex chunk 3a): the required-phase list now comes
 * from `bundled-default/codex.yaml`'s `default_workflow_id` workflow,
 * filtered to phases with `required: true`. Previously this was a
 * hard-coded `REQUIRED_PHASES` array; the codex is now the single
 * source of truth, which is what drift-as-codex was for.
 *
 * Fail-open: if the codex can't be loaded (missing file, parse error,
 * missing workflow id), the gate disables itself with a stderr
 * warning rather than blocking every commit. The codex is bundled
 * in the npm package so this should be unreachable in normal use.
 */
export function getRequiredPhasesFromCodex(): readonly string[] {
  const codex = loadBundledDefaultCodex();
  const workflowId = codex.default_workflow_id;
  if (!workflowId) {
    throw new Error("bundled-default codex has no default_workflow_id");
  }
  const workflow = (codex.workflows ?? []).find((w) => w.id === workflowId);
  if (!workflow) {
    throw new Error(`bundled-default codex has no workflow with id=${workflowId}`);
  }
  return workflow.phases.filter((p) => p.required).map((p) => p.name);
}

export interface WorkflowGateInput {
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

  let requiredPhases: readonly string[];
  try {
    requiredPhases = getRequiredPhasesFromCodex();
  } catch (err) {
    // Codex unloadable (missing bundled YAML, parse error, etc.).
    // Fail-open consistent with the gate's other failure modes.
    return {
      block: false,
      stderr: `[opensquid workflow-gate] codex unloadable (proceeding): ${err instanceof Error ? err.message : err}\n`,
    };
  }

  const engine = new OpenSquidEngine();
  let ledger: { phases_logged: string[] } | null = null;
  try {
    ledger = await engine.getTaskLedger({
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
  const missing = requiredPhases.filter((p) => !logged.has(p));
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
