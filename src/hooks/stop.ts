/**
 * `opensquid hook stop` — Claude Code Stop hook handler.
 *
 * Fires at the end of every assistant turn. Two responsibilities:
 *
 *   1. Honesty ledger reconciliation: cross-reference the assistant's
 *      final message against the session's accumulated tool-call ledger.
 *      Any unfulfilled claim is recorded as a broken promise that the
 *      next turn's UserPromptSubmit hook surfaces back to the agent.
 *
 *   2. Auto-classify spawn: launch a DETACHED subprocess that runs the
 *      LLM utterance classifier on the user's most recent message.
 *      The subprocess writes candidates to a session file that
 *      UserPromptSubmit surfaces next turn. Detached so the agent's
 *      response latency is unaffected.
 *
 * Exit 0 always — Stop hook is observational, not blocking.
 *
 * Wired in ~/.claude/settings.json:
 *
 *   "Stop": [
 *     { "hooks": [{
 *       "type": "command",
 *       "command": "node /path/to/opensquid/dist/index.js hook stop"
 *     }] }
 *   ]
 */

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";
import {
  reconcile,
  readBrokenPromises,
  readTurnLedger,
  recordBrokenPromise,
  type BrokenPromise,
} from "./honesty-ledger.js";
import { readLastAssistantText } from "./transcript.js";

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
}

export async function runStopHook(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  if (!raw.trim()) {
    process.exit(0);
  }
  let payload: StopHookInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write("[opensquid hook stop] malformed input — proceeding\n");
    process.exit(0);
  }

  const sessionId = payload.session_id;
  if (!sessionId) process.exit(0);

  // -- (1) Honesty-ledger reconcile ----------------------------------
  const assistantText = payload.transcript_path
    ? await readLastAssistantText(payload.transcript_path)
    : "";

  const ledger = await readTurnLedger(sessionId);
  const broken = reconcile(assistantText, ledger);

  const existing = await readBrokenPromises(sessionId);
  const existingKeys = new Set(existing.map((p) => `${p.claim_id}|${p.matched_text}`));
  const fresh: BrokenPromise[] = [];
  for (const promise of broken) {
    const key = `${promise.claim_id}|${promise.matched_text}`;
    if (existingKeys.has(key)) continue;
    fresh.push(promise);
    try {
      await recordBrokenPromise(sessionId, promise);
    } catch (err) {
      process.stderr.write(
        `[opensquid hook stop] failed to record promise: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  if (fresh.length > 0) {
    for (const p of fresh) {
      process.stderr.write(`🦑 [opensquid honesty] ${p.claim_id}: ${p.reason}\n`);
    }
  }

  // -- (2) Auto-classify (detached) ----------------------------------
  if (payload.transcript_path) {
    spawnAutoClassify(sessionId, payload.transcript_path);
  }

  process.exit(0);
}

/**
 * Launch the auto-classifier as a fully detached child. We do not
 * await it, but we DO redirect stdout+stderr to a per-session log file
 * (#112-audit finding 5) so engine panics, Ollama errors, and Zod
 * failures are recoverable instead of silenced.
 *
 * Best-effort: if the log file can't be opened, fall back to `ignore`.
 */
function spawnAutoClassify(sessionId: string, transcriptPath: string): void {
  if (process.env.OPENSQUID_AUTO_CLASSIFY === "off") return;
  const cli = process.argv[1];
  if (!cli) return;

  try {
    const logFd = openSessionLog(sessionId);
    const stdio: ("ignore" | number)[] =
      logFd === null ? ["ignore", "ignore", "ignore"] : ["ignore", logFd, logFd];
    const child = spawn(
      process.execPath,
      [path.resolve(cli), "hook", "auto-classify", sessionId, transcriptPath],
      {
        detached: true,
        stdio,
        env: process.env,
      },
    );
    if (typeof logFd === "number") {
      // Parent doesn't need its handle once spawn inherits it.
      try {
        fs.closeSync(logFd);
      } catch {
        // ignore
      }
      // Surface the PID into the log so a stuck subprocess can be found.
      void appendLogLine(
        sessionId,
        `[opensquid stop] spawned auto-classify pid=${child.pid ?? "?"}`,
      );
    }
    child.unref();
  } catch {
    // Fail-open: the agent's response is more important than the
    // classifier running.
  }
}

function openSessionLog(sessionId: string): number | null {
  try {
    const dir = path.join(resolveDataRoot(), "sessions", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "auto-classify.log");
    return fs.openSync(logPath, "a");
  } catch {
    return null;
  }
}

async function appendLogLine(sessionId: string, line: string): Promise<void> {
  try {
    const p = path.join(resolveDataRoot(), "sessions", sessionId, "auto-classify.log");
    await fsp.appendFile(p, line + "\n", "utf8");
  } catch {
    // ignore
  }
}
