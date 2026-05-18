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
import { evaluateEngineVocabGate } from "./engine-vocab-gate.js";
import { recordToolCall } from "./honesty-ledger.js";
import { readActiveTaskId } from "./transcript.js";
import { evaluateVersioningGate } from "./versioning-gate.js";
import { evaluateWorkflowGate } from "./workflow-gate.js";

/**
 * MCP tools that participate in the drift-protection track. When any
 * of these is called WITHOUT an in_progress TodoWrite task in the
 * transcript, the workflow-gate / chat-routing signals end up writing
 * to a ledger that no gate validates against. We can't BLOCK these
 * calls (legitimate ad-hoc usage exists), but emit a loud stderr
 * warning so the gap is visible. #173 / drift D1 structural fix
 * (locked 2026-05-17).
 */
const ACTIVE_TASK_GATED_MCP_TOOLS: ReadonlySet<string> = new Set([
  "mcp__opensquid__log_phase",
  "mcp__opensquid__chat_send",
]);

/**
 * #173 — return a warning string when an active-task-gated MCP tool is
 * about to be called without an in_progress TodoWrite task in the
 * transcript. Returns `null` when the tool isn't gated, no transcript
 * path is available, or an active task is detected.
 *
 * Transcript-read failures (missing file, malformed JSONL) swallow to
 * null — the hook must never block a legitimate call on its own bug.
 * The workflow-gate fail-opens silently in this case
 * (workflow-gate.ts:97-100); this surface makes that fail-open
 * observable from the call site.
 *
 * Exported for direct testing.
 */
export async function checkActiveTaskRequirement(
  call: ToolCallInput,
  transcriptPath: string | undefined,
): Promise<string | null> {
  if (!ACTIVE_TASK_GATED_MCP_TOOLS.has(call.tool)) return null;
  if (!transcriptPath) return null;
  try {
    const activeTaskId = await readActiveTaskId(transcriptPath);
    if (activeTaskId) return null;
  } catch {
    return null;
  }
  return (
    `🦑 [opensquid] ${call.tool} called without an in_progress TodoWrite task — ` +
    `the entries it writes WON'T be validated by the workflow-gate. ` +
    `Call TaskCreate (and set in_progress) first so the gate has an active task to enforce against.\n`
  );
}

/**
 * 0.7.25 / D3 — when `chat_send` is called with a body that looks like
 * a task-completion report (starts with the agent's `🦑 #<N>` marker),
 * verify the body includes a `PHASES` heading + at least 7 phase
 * lines per `[[feedback_telegram_reports]]`. Returns a non-blocking
 * warning string when the format is missing, null otherwise.
 *
 * Catches D3: paragraph summary sent instead of the locked 7-phase
 * format. Detection is heuristic (the agent could write a real
 * non-report message starting with `🦑 #N` — accepted noise).
 *
 * Exported for direct testing.
 */
export function checkChatSendReportFormat(call: ToolCallInput): string | null {
  if (call.tool !== "mcp__opensquid__chat_send") return null;
  const text = (call.input as { text?: unknown }).text;
  if (typeof text !== "string") return null;
  // Trigger: message starts with the report marker `🦑 #N`.
  if (!/^\s*🦑\s+#\d/.test(text)) return null;
  // Format requirement: must include a PHASES heading and the 7 phase
  // names. The phase names match the codex's default workflow.
  if (!/\bPHASES\b/.test(text)) {
    return (
      `🦑 [opensquid] chat_send body looks like a task-completion report ` +
      `(starts with \`🦑 #N\`) but is missing the \`PHASES\` block. ` +
      `Per [[feedback_telegram_reports]] reports must list each phase ` +
      `(pre_research, learn, code, test, audit, post_research, fix) ` +
      `with a concrete one-line finding — not just ✅. Catches drift D3.\n`
    );
  }
  return null;
}

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
  /** Working directory the tool will execute in. Provided by Claude
   * Code's hook payload (per the official hooks reference). Used by
   * engine-vocab-gate (0.7.21 / D6) to detect engine-repo commits. */
  cwd?: string;
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

  // #173 (D1 fix): when an active-task-gated MCP tool is called
  // without an in_progress TodoWrite task in the transcript, warn
  // loudly so the gap is visible. Non-blocking.
  const taskWarning = await checkActiveTaskRequirement(call, payload.transcript_path);
  if (taskWarning) {
    process.stderr.write(taskWarning);
  }

  // 0.7.25 / D3 — when chat_send body looks like a report but is missing
  // the 7-phase format, warn. Non-blocking.
  const formatWarning = checkChatSendReportFormat(call);
  if (formatWarning) {
    process.stderr.write(formatWarning);
  }

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
  const { exit, stderr } = decide(hits, call);
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

    // v0.6.3 versioning gate — enforce per-commit patch bumps. Local
    // git diff inspection only (no RPC), so cheap. Same fail-open
    // invariant as the workflow gate.
    try {
      const versionResult = await evaluateVersioningGate({ cwd: payload.cwd });
      if (versionResult.block) {
        process.stderr.write(versionResult.stderr);
        process.exit(2);
      } else if (versionResult.stderr) {
        process.stderr.write(versionResult.stderr);
      }
    } catch (err) {
      process.stderr.write(
        `[opensquid hook] versioning-gate failed (proceeding): ${err instanceof Error ? err.message : err}\n`,
      );
    }

    // 0.7.21 / D6 — engine vocabulary gate. Blocks engine commits whose
    // -m message OR staged diff content references consumer-product
    // names (opensquid, claude code, etc.). Early-exits on non-engine
    // cwd; cheap when not applicable.
    try {
      const bashCmd = stringField(call.input, "command");
      const vocabResult = await evaluateEngineVocabGate({
        cwd: payload.cwd,
        bashCommand: bashCmd ?? undefined,
      });
      if (vocabResult.block) {
        process.stderr.write(vocabResult.stderr);
        process.exit(2);
      } else if (vocabResult.stderr) {
        process.stderr.write(vocabResult.stderr);
      }
    } catch (err) {
      process.stderr.write(
        `[opensquid hook] engine-vocab-gate failed (proceeding): ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
  process.exit(0);
}

function stringField(input: Record<string, unknown>, field: string): string | null {
  const v = input[field];
  return typeof v === "string" ? v : null;
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
