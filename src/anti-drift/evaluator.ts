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

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";

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

  // Preserve legacy turn-ledger side effect (honesty reconciliation
  // needs the turn-ledger populated for Stop hook). Best-effort.
  if (payload.session_id) {
    try {
      const { recordToolCall } = await import("../hooks/honesty-ledger.js");
      const summary = summarizeToolInput(payload.tool_name, payload.tool_input ?? {});
      await recordToolCall(payload.session_id, payload.tool_name, summary);
    } catch {
      /* non-fatal */
    }
  }

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

/** Tight summary of tool input for the honesty ledger (matches legacy). */
function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
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
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return "";
  }
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
  // the existing helper).
  let assistantText = "";
  if (payload.transcript_path) {
    try {
      const { readLastAssistantText } = await import("../hooks/transcript.js");
      assistantText = await readLastAssistantText(payload.transcript_path);
    } catch {
      /* fail-open */
    }
  }

  const stderrLines: string[] = [];

  // ---- Legacy side effect 1: honesty-ledger reconciliation ----
  try {
    const ledger = await import("../hooks/honesty-ledger.js");
    const turnLedger = await ledger.readTurnLedger(payload.session_id);
    const broken = ledger.reconcile(assistantText, turnLedger);
    const existing = await ledger.readBrokenPromises(payload.session_id);
    const existingKeys = new Set(existing.map((p) => `${p.claim_id}|${p.matched_text}`));
    for (const p of broken) {
      if (existingKeys.has(`${p.claim_id}|${p.matched_text}`)) continue;
      try {
        await ledger.recordBrokenPromise(payload.session_id, p);
        stderrLines.push(`🦑 [opensquid honesty] ${p.claim_id}: ${p.reason}`);
      } catch {
        /* non-fatal */
      }
    }
    try {
      await ledger.clearTurnLedger(payload.session_id);
    } catch {
      /* non-fatal */
    }
  } catch {
    /* fail-open */
  }

  // ---- Rule walk (inline-report-missing-phases + future Stop rules) ----
  const ctx: HookContext = {
    hookEvent: "Stop",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    assistantText,
  };
  const verdicts = await evaluateRules(ctx);
  for (const v of verdicts) {
    if (v.kind === "surface") {
      try {
        await appendViolation(payload.session_id, {
          ts: new Date().toISOString(),
          rule_id: "stop-surface",
          verdict: "surface",
          reason: v.message,
        });
        // ALSO route to the legacy broken-promises stream so the
        // existing UPS surface pipeline picks it up.
        const ledger = await import("../hooks/honesty-ledger.js");
        await ledger.recordBrokenPromise(payload.session_id, {
          ts: new Date().toISOString(),
          claim_id: "inline-report-missing-phases",
          claim_label: "PHASES block per feedback_telegram_reports",
          matched_text: v.message.slice(0, 200),
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

  // ---- Legacy side effect 2: heartbeat arm ----
  if (payload.transcript_path) {
    try {
      const { checkAndMaybeArm } = await import("../hooks/heartbeat.js");
      const armed = await checkAndMaybeArm(payload.session_id, payload.transcript_path);
      if (armed) stderrLines.push(`🦑 [opensquid heartbeat-armed] ${armed}`);
    } catch {
      /* non-fatal */
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

  const stdoutLines: string[] = [];

  // ---- Legacy 1: resumed-session detection ----
  try {
    const { detectResumeAndUpdateMarker } = await import("../hooks/user-prompt-submit.js");
    const resumeMsg = await detectResumeAndUpdateMarker(payload.session_id);
    if (resumeMsg) stdoutLines.push(resumeMsg);
  } catch {
    /* non-fatal */
  }

  // ---- Legacy 2: broken-promises consume + surface ----
  try {
    const broken = await consumeBrokenPromises(payload.session_id);
    if (broken.length > 0) {
      stdoutLines.push("🦑 [opensquid honesty-ledger] unresolved claims from the previous turn:");
      for (const p of broken) {
        stdoutLines.push(`  🦑 ${p.claim_id}: "${p.matched_text}" — needed ${p.claim_label}`);
      }
      stdoutLines.push(
        "Acknowledge these in your reply: either do the missing action now, or " +
          "retract the claim explicitly. Don't repeat the pattern.",
      );
    }
  } catch {
    /* non-fatal */
  }

  // ---- Legacy 3: heartbeat-pending consume + mark recall required ----
  try {
    const { consumePendingHeartbeat, markRecallRequired } = await import("../hooks/heartbeat.js");
    const heartbeat = await consumePendingHeartbeat(payload.session_id);
    if (heartbeat) {
      if (stdoutLines.length > 0) stdoutLines.push("");
      stdoutLines.push(heartbeat);
      await markRecallRequired(payload.session_id);
    }
  } catch {
    /* non-fatal */
  }

  // ---- Rule walk (multi-task-plan-injection + future UPS rules) ----
  const ctx: HookContext = {
    hookEvent: "UserPromptSubmit",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    userPrompt: payload.prompt,
  };
  const verdicts = await evaluateRules(ctx);
  for (const v of verdicts) {
    if (v.kind === "surface" || v.kind === "warn") {
      stdoutLines.push(v.message);
    }
  }
  return { stdout: stdoutLines.length > 0 ? stdoutLines.join("\n") + "\n" : "" };
}

interface BrokenPromiseLite {
  claim_id: string;
  claim_label: string;
  matched_text: string;
}

/**
 * Atomically claim broken-promises.jsonl content (rename-then-read-
 * then-delete). Mirrors the legacy UPS handler's `consumeJsonl`
 * pattern.
 */
async function consumeBrokenPromises(sessionId: string): Promise<BrokenPromiseLite[]> {
  const root = resolveDataRoot();
  const filePath = path.join(root, "sessions", sessionId, "broken-promises.jsonl");
  const claimed = `${filePath}.consuming.${crypto.randomUUID()}`;
  try {
    await fs.rename(filePath, claimed);
  } catch {
    return [];
  }
  let raw: string;
  try {
    raw = await fs.readFile(claimed, "utf8");
  } catch {
    raw = "";
  }
  try {
    await fs.rm(claimed);
  } catch {
    /* already gone */
  }
  if (!raw.trim()) return [];
  const items: BrokenPromiseLite[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      items.push(JSON.parse(t) as BrokenPromiseLite);
    } catch {
      /* skip malformed */
    }
  }
  return items;
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
