/**
 * Pure handlers for `opensquid checkpoints` (CLI.6 + DURABLE.4 scaffold) —
 * split out of checkpoints.ts for the file-size budget.
 *
 * Commander-agnostic. Direct-import callers (tests, future programmatic
 * tooling) use these. The commander wiring in `./checkpoints.ts` calls
 * these through `./checkpoints_actions.ts`.
 *
 * Imports from: ../../runtime/durable/index.js.
 * Imported by: ./checkpoints.ts (re-exports public surface),
 *   ./checkpoints_actions.ts (verb handlers).
 */

import type { CheckpointStore, Resumer } from '../../runtime/durable/index.js';

/** One row in the `list` verb's output. */
export interface ListEntry {
  runId: string;
  packId: string;
  skill: string;
  ruleId: string;
  lastCompletedStep: number;
  lastCompletedAtMs: number;
  ageMs: number;
}

export interface ListOpts {
  store: CheckpointStore;
  /** Window in ms; `null` / `Infinity` disables. */
  windowMs?: number | null;
  nowMs?: () => number;
}

/** Inspect interrupted runs (manifest-orphan checkpoints are dropped). */
export async function list(opts: ListOpts): Promise<ListEntry[]> {
  const now = (opts.nowMs ?? Date.now)();
  const windowMs = opts.windowMs ?? Number.POSITIVE_INFINITY;
  const summaries = await opts.store.scanInterrupted(windowMs, now);
  const out: ListEntry[] = [];
  for (const s of summaries) {
    const m = await opts.store.getRunManifest(s.runId);
    if (!m) continue;
    out.push({
      runId: s.runId,
      packId: m.packId,
      skill: m.skill,
      ruleId: m.ruleId,
      lastCompletedStep: s.lastCompletedStep,
      lastCompletedAtMs: s.lastCompletedAtMs,
      ageMs: now - s.lastCompletedAtMs,
    });
  }
  return out;
}

export interface ShowResult {
  manifest: Awaited<ReturnType<CheckpointStore['getRunManifest']>>;
  checkpoints: Awaited<ReturnType<CheckpointStore['fetchRun']>>;
  hasTerminalMarker: boolean;
}

/** Inspect one run: manifest + every checkpoint row + terminal state. */
export async function show(store: CheckpointStore, runId: string): Promise<ShowResult> {
  const [manifest, checkpoints, hasTerminalMarker] = await Promise.all([
    store.getRunManifest(runId),
    store.fetchRun(runId),
    store.hasTerminalMarker(runId),
  ]);
  return { manifest, checkpoints, hasTerminalMarker };
}

export interface ResumeCliResult {
  resumed: boolean;
  reason?: string;
  manifestMissing?: true;
}

/** Explicit resume — bypasses DURABLE.4's resume window
 *  (`Resumer.resume` itself never consults the window; only
 *  `scanInterrupted` / `resumeOnStartup` do). */
export async function resume(
  resumer: Resumer,
  store: CheckpointStore,
  runId: string,
): Promise<ResumeCliResult> {
  const manifest = await store.getRunManifest(runId);
  if (!manifest) {
    return { resumed: false, manifestMissing: true };
  }
  const lastCompleted = await store.lastCompletedStep(runId);
  const result = await resumer.resume({
    runId: manifest.runId,
    packId: manifest.packId,
    packVersion: manifest.packVersion,
    skill: manifest.skill,
    ruleId: manifest.ruleId,
    eventKind: manifest.eventKind,
    eventPayload: manifest.eventPayload,
    lastCompletedStep: lastCompleted?.stepIdx ?? -1,
    lastCompletedAtMs: lastCompleted?.completedAtMs ?? manifest.startedAtMs,
  });
  return result.reason
    ? { resumed: result.resumed, reason: result.reason }
    : { resumed: result.resumed };
}

export interface CleanOpts {
  store: CheckpointStore;
  olderThanMs: number;
  nowMs?: () => number;
}

/** Prune old checkpoint rows. Pass-through to `pruneOlderThan`. */
export async function clean(opts: CleanOpts): Promise<{ removed: number }> {
  const removed = await opts.store.pruneOlderThan(opts.olderThanMs, (opts.nowMs ?? Date.now)());
  return { removed };
}
