/**
 * Per-session auto-start chain state machine (T-ASC, ASC.1).
 *
 * Tracks the user-locked pipeline scope-decomposer → task-spec-author →
 * workflow / 7-layer across a single Claude Code session. The state is the
 * substrate ASC.2's `Skill.requires: chain_stage` precondition reads, and the
 * data source ASC.5's reframed scope-decomposer handoff rules consume to
 * shape their structured `directive` verdicts (ASC.3).
 *
 * 7 stages (declaration order = pipeline order):
 *   idle              — no scope work in flight (initial)
 *   scoping           — scope-authoring intent detected on the most recent
 *                       prompt (the SCOPE_INTENT_REGEX matched while idle)
 *   researched        — a pre-research artifact landed on disk
 *                       (docs/research/*-pre-research-*.md)
 *   spec_authored     — a track spec landed on disk
 *                       (docs/tasks/T-*.md)
 *   tasks_loaded      — harness TaskCreate fired with metadata.taskId
 *                       provenance (the spec became loaded tasks)
 *   phases_in_flight  — at least one phase logged for the active task
 *   phases_complete   — all 7 REQUIRED phases logged for the active task
 *
 * Writers (5 distributed transition points across the runtime):
 *   UserPromptSubmit  → 'scoping'         (prompt matches SCOPE_INTENT_REGEX
 *                                          AND current stage is 'idle')
 *   PreToolUse        → 'researched'      (Write to docs/research/*-pre-research-*.md)
 *   PreToolUse        → 'spec_authored'   (Write to docs/tasks/T-*.md)
 *   PreToolUse        → 'tasks_loaded'    (TaskCreate/TaskUpdate with metadata.taskId)
 *   log_phase MCP     → 'phases_in_flight' / 'phases_complete'
 *
 * Lifecycle: session-scoped per T-ASC L3. SessionEnd hook calls
 * `clearChainState`. Cross-session resume is OUT OF SCOPE for this track
 * (separate product question).
 *
 * Invariants:
 *   - Same-stage write is idempotent (no double-history-entry, no file rewrite).
 *     The `history` is append-only and entries are NEVER removed mid-session
 *     (per L4); history captures stage ENTRIES, not write attempts.
 *   - No-throw read posture: absent / malformed → null; the caller defaults
 *     to 'idle' via `readChainStage`'s nullish coalesce. Same eventual-
 *     consistency model as session_state.ts:108-135 (recordSessionCwd).
 *   - Enrichment fields (pre_research_path, spec_path, task_ids) ACCUMULATE
 *     across transitions: a transition without enrich preserves prior values.
 *     A same-stage idempotent call does NOT update enrichment (L4 contract —
 *     same stage = no write at all). If a future need surfaces ("update
 *     enrichment on current stage"), add a sibling enrichChainState helper;
 *     do NOT loosen transitionChainStage's idempotency.
 *   - Write failures throw (caller-owned recovery). Call sites in hooks /
 *     log_phase wrap in try/catch with stderr-warn or silent (their existing
 *     best-effort discipline).
 *
 * Imports from: node:fs/promises, node:path, ./paths.js.
 * Imported by:
 *   - src/runtime/hooks/{pre-tool-use,user-prompt-submit,session-end}.ts (writers)
 *   - src/mcp/tools/log_phase.ts (writer)
 *   - src/runtime/skill_requires.ts (ASC.2 — `chain_stage` precondition reader)
 *   - src/functions/chain_state.ts (ASC.5 — `read_chain_state` primitive)
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sessionStateFile } from './paths.js';

/** The 7 stages, in pipeline order. `as const` so ChainStage narrows to the literal union. */
export const CHAIN_STAGES = [
  'idle',
  'scoping',
  'researched',
  'spec_authored',
  'tasks_loaded',
  'phases_in_flight',
  'phases_complete',
] as const;

export type ChainStage = (typeof CHAIN_STAGES)[number];

/** Well-known session-state key for the chain-state file. */
const CHAIN_STATE_KEY = 'chain-state';

export interface ChainHistoryEntry {
  stage: ChainStage;
  /** ISO-8601 timestamp the chain ENTERED this stage. */
  at: string;
}

export interface ChainState {
  stage: ChainStage;
  /** ISO timestamp the chain entered the CURRENT stage. */
  started_at: string;
  /** ISO timestamp of the most-recent transition write (same as started_at after a fresh transition). */
  last_transition_at: string;
  /** Absolute path to the pre-research artifact; set when transitioning to 'researched'. */
  pre_research_path?: string;
  /** Absolute path to the track spec; set when transitioning to 'spec_authored'. */
  spec_path?: string;
  /** Harness task ids that loaded from the spec; set when transitioning to 'tasks_loaded'. */
  task_ids?: string[];
  /** Append-only audit trail of every stage entered. */
  history: ChainHistoryEntry[];
}

/** Optional enrichment supplied on transition; merges into ChainState (only when the stage actually transitions). */
export interface ChainEnrich {
  pre_research_path?: string;
  spec_path?: string;
  task_ids?: string[];
}

/**
 * Runtime type guard for the persisted shape. Validates every required field
 * + stage-membership; the unknown-shape branches return false so the read
 * helpers default to null (no-throw posture).
 */
function isChainState(o: unknown): o is ChainState {
  if (o === null || typeof o !== 'object') return false;
  const obj = o as Record<string, unknown>;
  if (typeof obj.stage !== 'string') return false;
  if (!(CHAIN_STAGES as readonly string[]).includes(obj.stage)) return false;
  if (typeof obj.started_at !== 'string') return false;
  if (typeof obj.last_transition_at !== 'string') return false;
  if (!Array.isArray(obj.history)) return false;
  return true;
}

/**
 * Write a stage transition. Idempotent on same-stage re-write: when the
 * persisted stage already equals `next`, this is a no-op (history unchanged,
 * enrichment NOT applied — L4 contract: same stage = no write).
 *
 * Enrichment fields ACCUMULATE on actual transitions: a transition without
 * an explicit enrich value preserves whatever was in the prior state for that
 * field. Supplying enrich for a stage we're already in is silently dropped
 * (the function returns early). If a caller needs to update enrichment on
 * the current stage, that's a separate concern (out of scope for ASC.1).
 *
 * Fail-open is caller-side: write failures throw, hook bins wrap with
 * try/catch + stderr-warn, the log_phase MCP tool wraps silently (the tool's
 * return shape is the gate's contract and a chain-state-write failure must
 * NOT propagate into the tool response).
 */
export async function transitionChainStage(
  sessionId: string,
  next: ChainStage,
  enrich?: ChainEnrich,
): Promise<void> {
  const path = sessionStateFile(sessionId, CHAIN_STATE_KEY);
  const now = new Date().toISOString();
  const current = await readChainState(sessionId);
  if (current?.stage === next) return; // L4 idempotency: same stage = no-op
  const merged: ChainState = {
    stage: next,
    started_at: now,
    last_transition_at: now,
    ...(current?.pre_research_path !== undefined
      ? { pre_research_path: current.pre_research_path }
      : {}),
    ...(current?.spec_path !== undefined ? { spec_path: current.spec_path } : {}),
    ...(current?.task_ids !== undefined ? { task_ids: current.task_ids } : {}),
    ...(enrich?.pre_research_path !== undefined
      ? { pre_research_path: enrich.pre_research_path }
      : {}),
    ...(enrich?.spec_path !== undefined ? { spec_path: enrich.spec_path } : {}),
    ...(enrich?.task_ids !== undefined ? { task_ids: enrich.task_ids } : {}),
    history: [...(current?.history ?? []), { stage: next, at: now }],
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(merged, null, 2), 'utf8');
}

/**
 * Read the persisted ChainState, or `null` if absent/unreadable/malformed.
 * Same no-throw posture as readSessionCwd / readActiveTask: a missing or
 * shape-invalid file reads as null inside a hook bin, never an exception.
 */
export async function readChainState(sessionId: string): Promise<ChainState | null> {
  try {
    const raw = await readFile(sessionStateFile(sessionId, CHAIN_STATE_KEY), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isChainState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read just the current stage; defaults to 'idle' when the chain has not yet
 * been initialized (absent file) or when the persisted state is malformed.
 * The convenience reader for callers that only care about the stage gate
 * (ASC.2's `Skill.requires: chain_stage` precondition, ASC.5's rule guards).
 */
export async function readChainStage(sessionId: string): Promise<ChainStage> {
  return (await readChainState(sessionId))?.stage ?? 'idle';
}

/**
 * Remove the chain-state file (SessionEnd cleanup). ENOENT is swallowed —
 * a session that never advanced past 'idle' has no file to clear. Any other
 * error throws (caller wraps with best-effort discipline).
 */
export async function clearChainState(sessionId: string): Promise<void> {
  try {
    await unlink(sessionStateFile(sessionId, CHAIN_STATE_KEY));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
