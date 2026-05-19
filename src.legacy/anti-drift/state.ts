/**
 * Anti-drift state primitives (0.8 unified-evaluator track).
 *
 * Per loop/docs/opensquid-anti-drift-unified-evaluator-design.md C-section
 * "state primitives": one filesystem-backed source of truth for the
 * active-task signal + violations log + drift catalog.
 *
 * This module is the foundation of the unified evaluator. Today it
 * lives alongside src/hooks/ (no cutover yet). Subsequent patches
 * port rules from src/hooks/* into src/anti-drift/rules.ts which
 * reads from this state module, replacing per-rule transcript
 * parsing.
 *
 * Three state primitives:
 *   1. active-task.json — current in_progress task id + subject + started_at
 *   2. violations.log   — append-only ring buffer (last N violations)
 *   3. drift-catalog.jsonl — append-only audit trail
 *
 * Layout (sessions are short-lived; project scope is durable):
 *   ~/.opensquid/sessions/<session-id>/active-task.json
 *   ~/.opensquid/sessions/<session-id>/violations.log
 *   ~/.opensquid/projects/<project-uuid>/drift-catalog.jsonl
 *
 * Design choice: writes are best-effort. State corruption is recoverable
 * (worst case: rule fails-open, which is what the existing hooks already
 * do). The new architecture's win is making "no active task" a positive
 * signal (file absent) rather than a parse failure (transcript
 * unreadable) — different shape, easier to reason about.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";

// =====================================================================
// active-task.json — single source of truth for the in_progress task
// =====================================================================

export interface ActiveTaskState {
  /** Numeric task id from Claude Code's TodoWrite / TaskCreate. */
  id: string;
  /** Human-readable subject (helps with grep + debugging). */
  subject?: string;
  /** ISO 8601 timestamp when this task was marked in_progress. */
  started_at: string;
}

function activeTaskPath(sessionId: string, dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "sessions", sessionId, "active-task.json");
}

/**
 * Write the active-task state. Idempotent — overwrites any existing
 * file. Caller is responsible for choosing the right semantic (e.g.
 * a fresh TaskCreate vs. a TaskUpdate(in_progress) on an existing
 * task id).
 *
 * Exported for direct testing + use by the PreToolUse sync helper.
 */
export async function writeActiveTask(
  sessionId: string,
  state: ActiveTaskState,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const p = activeTaskPath(sessionId, options.dataRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Read the active-task state. Returns null when the file is absent
 * (the canonical "no in_progress task" signal) OR when the file is
 * malformed (fail-safe: treat corruption as "no task" rather than
 * crashing the gate).
 */
export async function readActiveTask(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<ActiveTaskState | null> {
  const p = activeTaskPath(sessionId, options.dataRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ActiveTaskState;
    if (typeof parsed?.id !== "string" || typeof parsed?.started_at !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete the active-task state. Idempotent — silent no-op when the
 * file is already absent. Called on TaskUpdate(completed).
 */
export async function clearActiveTask(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const p = activeTaskPath(sessionId, options.dataRoot);
  try {
    await fs.rm(p);
  } catch {
    /* already gone — idempotent */
  }
}

// =====================================================================
// violations.log — per-session append-only ring of rule firings
// =====================================================================

export interface ViolationEntry {
  /** ISO 8601 timestamp the rule fired. */
  ts: string;
  /** Rule id from rules.ts. */
  rule_id: string;
  /** "block" | "warn" | "surface" | "auto". */
  verdict: string;
  /** Free-text reason (becomes the agent-facing surface text). */
  reason: string;
  /** Optional matched-text snippet (≤200 chars). */
  evidence?: string;
}

function violationsPath(sessionId: string, dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "sessions", sessionId, "violations.log");
}

/**
 * Append a violation entry. Each call writes exactly one JSON line.
 * Best-effort: silent on write failure (the rule has already fired
 * in-process — losing the log entry is non-load-bearing).
 */
export async function appendViolation(
  sessionId: string,
  entry: ViolationEntry,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const p = violationsPath(sessionId, options.dataRoot);
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* best-effort logging — swallow */
  }
}

/**
 * Atomically claim all pending violations for surfacing at next UPS.
 * Returns the parsed entries; the on-disk file is renamed-then-deleted
 * so concurrent writers land in a fresh file the next consumer picks up.
 */
export async function consumeViolations(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<ViolationEntry[]> {
  const p = violationsPath(sessionId, options.dataRoot);
  const claimed = `${p}.consuming.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.rename(p, claimed);
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
  const entries: ViolationEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t) as ViolationEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
}

// =====================================================================
// drift-catalog.jsonl — project-scoped audit trail
// =====================================================================

/**
 * Path helper for the per-project drift catalog. The catalog is
 * project-scoped (not session-scoped) so a project's drift history
 * accumulates across sessions.
 *
 * Falls back to a session-scoped path when projectUuid is null —
 * matches the existing drift-catalog.ts fallback shape.
 */
export function driftCatalogPath(
  projectUuid: string | null,
  sessionId: string,
  dataRoot?: string,
): string {
  const root = resolveDataRoot(dataRoot);
  if (projectUuid) {
    return path.join(root, "projects", projectUuid, "drift-catalog.jsonl");
  }
  return path.join(root, "sessions", sessionId, "drift-catalog.jsonl");
}

// =====================================================================
// SessionEnd cleanup — paths the cleanup phase removes
// =====================================================================

/**
 * Per-session file paths that SessionEnd should clean up. Project-scoped
 * files (drift-catalog.jsonl) are durable across sessions and excluded.
 */
export function sessionStateFiles(sessionId: string, dataRoot?: string): string[] {
  return [activeTaskPath(sessionId, dataRoot), violationsPath(sessionId, dataRoot)];
}
