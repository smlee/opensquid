/**
 * `opensquid checkpoints` CLI verb scaffold (DURABLE.4, partial).
 *
 * Verbs (all backed by the same `CheckpointStore` + optional `Resumer`):
 *
 *   list    — print interrupted-run summaries within the resume window.
 *             `--all` disables the window for a full scan.
 *   show    — dump one run's manifest + checkpoint rows as JSON.
 *   resume  — explicit resume regardless of window. Used to recover
 *             stuck runs after the daemon's auto-resume gave up.
 *   clean   — prune checkpoints older than a duration.
 *
 * Scope of this scaffold: pure logic — text formatters + verb handlers
 * that take an injected store / resumer / clock. Full commander wiring
 * (`opensquid checkpoints list` etc. on the program tree) ships in CLI.6
 * once the CLI track lands its full-tree refactor; until then these
 * handlers are reachable via direct import in tests and downstream
 * tooling.
 *
 * Imports from: ../../runtime/durable/index.js.
 * Imported by: src/setup/cli/checkpoints.test.ts; future CLI.6 wiring.
 */

import type { CheckpointStore, Resumer } from '../../runtime/durable/index.js';

/** One row in the `list` verb's output. Minimal shape — just enough for
 *  the operator to decide whether to drill into `show` or `resume`. */
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
  /** Window in ms; `null` / `Infinity` disables. Default 60_000. */
  windowMs?: number | null;
  nowMs?: () => number;
}

/** Inspect interrupted runs (with manifest only; manifest-orphan
 *  checkpoints are dropped). */
export async function list(opts: ListOpts): Promise<ListEntry[]> {
  const now = (opts.nowMs ?? Date.now)();
  const windowMs = opts.windowMs ?? Number.POSITIVE_INFINITY;
  const summaries = await opts.store.scanInterrupted(windowMs, now);
  const out: ListEntry[] = [];
  for (const s of summaries) {
    const m = await opts.store.getRunManifest(s.runId);
    if (!m) continue; // orphan checkpoint, surfaced by Resumer audit not CLI
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
  /** True when the run had no manifest in the store. */
  manifestMissing?: true;
}

/** Explicit resume — bypasses the window (resumer's resume() doesn't
 *  consult the window itself; only resumeOnStartup() / scanInterrupted
 *  do). The caller passes a Resumer that already wraps the store + the
 *  caller's RuleResolver + RunEvaluator. */
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

/** Prune old checkpoint rows. Thin pass-through to `pruneOlderThan`. */
export async function clean(opts: CleanOpts): Promise<{ removed: number }> {
  const removed = await opts.store.pruneOlderThan(opts.olderThanMs, (opts.nowMs ?? Date.now)());
  return { removed };
}
