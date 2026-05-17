/**
 * Token-threshold heartbeat — opensquid's in-ecosystem replacement for
 * the auto-classifier subprocess.
 *
 * The agent (Claude Code itself) is the LLM in the loop and is already
 * authenticated. There is no reason to spawn a second LLM subprocess
 * to classify what the user said — the agent can do that work inline
 * per the CLAUDE.md classify-and-act block.
 *
 * What the agent IS bad at: noticing when its in-context understanding
 * has drifted enough that it should re-anchor via `recall`. That's a
 * timing problem opensquid can solve cleanly: count tokens in the
 * transcript, compare to a checkpoint, and if the delta crosses a
 * threshold, drop a one-line nudge into the next turn's UserPromptSubmit
 * stdout so the agent sees it at the top of its system context.
 *
 * Flow:
 *   Stop hook (every turn) → `checkAndMaybeArm(sessionId, transcriptPath)`
 *     - Estimates total transcript tokens (char count / 4)
 *     - Loads last checkpoint from `<data-root>/sessions/<sid>/heartbeat-checkpoint.json`
 *     - If (current - last) >= threshold, writes a marker at
 *       `<data-root>/sessions/<sid>/heartbeat-pending.txt` AND updates
 *       the checkpoint to the current count
 *   UserPromptSubmit hook (next turn) → `consumePendingHeartbeat(sessionId)`
 *     - Reads marker if present, returns its contents (for stdout injection)
 *     - Deletes the marker so the nudge fires exactly once per crossing
 *
 * Threshold: `OPENSQUID_HEARTBEAT_TOKENS` env, default 20000.
 *   Calibrated against the existing CLAUDE.md "drifts after ~10 unrelated
 *   turns" observation (~2000 tokens per turn typical).
 *
 * Zero subprocess. Zero external LLM. Zero new dependency. The agent
 * (which already exists in the loop) does the actual recall + classify
 * work inline after seeing the nudge.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";

/** Default threshold — see file docstring for rationale. */
export const DEFAULT_HEARTBEAT_TOKENS = 20_000;

/**
 * Resolve the configured heartbeat threshold. Env var `OPENSQUID_HEARTBEAT_TOKENS`
 * overrides; values <= 0 or non-numeric fall back to the default. Returning a
 * sentinel `Infinity` would let callers disable cheaply, but we keep the
 * contract simple: any positive integer is honored.
 */
export function heartbeatThresholdTokens(): number {
  const raw = process.env.OPENSQUID_HEARTBEAT_TOKENS;
  if (!raw) return DEFAULT_HEARTBEAT_TOKENS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HEARTBEAT_TOKENS;
  return n;
}

/**
 * Rough token estimate from raw text — char-count / 4. Cheap, dependency-
 * free, and accurate enough for "did the conversation grow by 20K tokens
 * since last checkpoint" decisions. Real tokenizers (tiktoken,
 * @anthropic-ai/tokenizer) would be more accurate but add a runtime dep
 * for marginal gain on a threshold comparison.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Read the Claude Code transcript file and estimate the agent-facing
 * token count for "did the conversation drift since last checkpoint."
 *
 * 0.7.7 (#161) — replaces the previous whole-file char/4 estimate
 * which inflated massively on long sessions because the transcript
 * JSONL contains tool_result bodies (file reads, base64 images, git
 * logs), thinking blocks, attachments, system frames, and
 * permission-mode entries that don't represent conversation pressure.
 *
 * On a real session today this dropped a 125 MB transcript from
 * reporting "31 million tokens" to a number that actually reflects
 * the user+assistant exchange, so heartbeat fires when it should
 * instead of constantly off inflated numbers.
 *
 * Counts:
 *   - user message text/string content
 *   - assistant text content
 *   - tool_result content — capped at 2000 chars per result, since
 *     the agent does read these but they shouldn't dominate
 *
 * Skips:
 *   - thinking blocks (agent internal CoT)
 *   - tool_use args (compact, plus they're outbound work not context)
 *   - system / file-history-snapshot / permission-mode / ai-title /
 *     last-prompt / attachment frames
 *
 * Returns 0 on any read failure (graceful, gate stays open).
 */
const TOOL_RESULT_CAP_CHARS = 2000;

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

export async function estimateTranscriptTokens(transcriptPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(transcriptPath, "utf8");
    let total = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      if (parsed.type !== "user" && parsed.type !== "assistant") continue;
      total += countContentChars(parsed.message?.content);
    }
    return Math.ceil(total / 4);
  } catch {
    return 0;
  }
}

function countContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; content?: unknown };
    switch (b.type) {
      case "text":
        if (typeof b.text === "string") chars += b.text.length;
        break;
      case "tool_result": {
        // tool_result content can be a string OR an array of blocks
        const c = b.content;
        if (typeof c === "string") {
          chars += Math.min(c.length, TOOL_RESULT_CAP_CHARS);
        } else if (Array.isArray(c)) {
          let inner = 0;
          for (const part of c) {
            if (part && typeof part === "object") {
              const p = part as { text?: string };
              if (typeof p.text === "string") inner += p.text.length;
            }
          }
          chars += Math.min(inner, TOOL_RESULT_CAP_CHARS);
        }
        break;
      }
      // thinking / tool_use / image / etc. — intentionally not counted
    }
  }
  return chars;
}

// ---------------------------------------------------------------------
// Checkpoint + pending-marker file IO
// ---------------------------------------------------------------------

interface Checkpoint {
  last_token_count: number;
  last_checkpoint_at: string;
}

function checkpointPath(sessionId: string, dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "sessions", sessionId, "heartbeat-checkpoint.json");
}

function pendingPath(sessionId: string, dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "sessions", sessionId, "heartbeat-pending.txt");
}

export async function readCheckpoint(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<Checkpoint | null> {
  try {
    const raw = await fs.readFile(checkpointPath(sessionId, options.dataRoot), "utf8");
    const parsed = JSON.parse(raw) as Checkpoint;
    if (
      parsed &&
      typeof parsed.last_token_count === "number" &&
      typeof parsed.last_checkpoint_at === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeCheckpoint(
  sessionId: string,
  checkpoint: Checkpoint,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const p = checkpointPath(sessionId, options.dataRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
}

/**
 * Build the one-line nudge that gets injected into the agent's next-
 * turn system context. Kept short — the agent's existing system prompt
 * (CLAUDE.md classify-and-act + the user-is-god promoted lesson)
 * already tells it what to do with classification work.
 */
export function formatHeartbeatNudge(delta: number, threshold: number): string {
  return (
    `🦑 [opensquid heartbeat] ${delta.toLocaleString()} tokens since last re-anchor ` +
    `(threshold: ${threshold.toLocaleString()}). Before answering: ` +
    `(1) call \`recall\` with your current task to refresh context; ` +
    `(2) scan recent user turns for substantive items needing memorize / remember / promote.`
  );
}

/**
 * Stop-hook entrypoint: check whether the transcript has grown past
 * the threshold since the last checkpoint. If so, arm a pending
 * heartbeat marker for UserPromptSubmit to surface on the next turn,
 * and bump the checkpoint to the current count.
 *
 * Returns the nudge text written (or null if no arming happened) for
 * test introspection and Stop-hook stderr surfacing.
 */
export async function checkAndMaybeArm(
  sessionId: string,
  transcriptPath: string,
  options: { dataRoot?: string; thresholdTokens?: number } = {},
): Promise<string | null> {
  const threshold = options.thresholdTokens ?? heartbeatThresholdTokens();
  const currentTokens = await estimateTranscriptTokens(transcriptPath);
  if (currentTokens === 0) return null;

  const previous = await readCheckpoint(sessionId, { dataRoot: options.dataRoot });
  let baseline = previous?.last_token_count ?? 0;
  // 0.7.7 (#161, audit MED #3): the estimator was rewritten in 0.7.7
  // to count only conversation bodies (not whole-file char/4) — typical
  // 20x deflation vs the old value. Existing checkpoints written by
  // the old estimator now show wildly higher numbers than the new
  // estimator returns, which would make `delta = current - baseline`
  // permanently negative → heartbeat never fires. Detect that case
  // (baseline > 10x current) and reset the baseline to 0 so the next
  // crossing is the first under the new regime.
  if (baseline > currentTokens * 10) {
    baseline = 0;
  }
  const delta = currentTokens - baseline;
  if (delta < threshold) return null;

  const nudge = formatHeartbeatNudge(delta, threshold);
  const p = pendingPath(sessionId, options.dataRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, nudge + "\n", "utf8");
  await writeCheckpoint(
    sessionId,
    { last_token_count: currentTokens, last_checkpoint_at: new Date().toISOString() },
    { dataRoot: options.dataRoot },
  );
  return nudge;
}

/**
 * UserPromptSubmit-hook entrypoint: consume any armed heartbeat marker
 * and return its text. Caller injects via stdout. Marker is removed so
 * the nudge fires exactly once per threshold crossing.
 */
export async function consumePendingHeartbeat(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<string | null> {
  const p = pendingPath(sessionId, options.dataRoot);
  let nudge: string;
  try {
    nudge = (await fs.readFile(p, "utf8")).trim();
  } catch {
    return null;
  }
  try {
    await fs.rm(p);
  } catch {
    // already gone — concurrent UserPromptSubmit or test cleanup
  }
  return nudge.length === 0 ? null : nudge;
}

/** Test/SessionEnd helper — paths the cleanup phase removes. */
export function heartbeatSessionFiles(sessionId: string, dataRoot?: string): string[] {
  return [checkpointPath(sessionId, dataRoot), pendingPath(sessionId, dataRoot)];
}
