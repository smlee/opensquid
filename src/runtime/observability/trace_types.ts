/**
 * OBSERVE.1 — trace timeline TS types.
 *
 * Shapes returned by `TraceReader`. The reader derives these from the
 * existing DURABLE.1 + DURABLE.4 tables (`checkpoints` + `run_manifests`
 * + `terminal_markers`) — no separate trace storage. Single source of
 * truth: every field in `TraceEvent` maps 1:1 to a checkpoints column,
 * and `TraceTimeline` joins one manifest with its ordered checkpoint
 * rows.
 *
 * Imports from: nothing (pure types).
 * Imported by: ./trace_reader.ts, ./index.ts, downstream CLI (OBSERVE.2).
 */

/** Status derived from terminal_markers + checkpoint state + age window. */
export type TraceStatus = 'completed' | 'in_flight' | 'errored' | 'interrupted';

/** One primitive call boundary — read from a single `checkpoints` row. */
export interface TraceEvent {
  runId: string;
  stepIdx: number;
  fn: string;
  inputsHash: string;
  /** First 200 chars (UTF-8-safe). Secret-redacted. Omitted when checkpoint has no input preview source. */
  inputsPreview?: string;
  outputs: unknown;
  /** First 200 chars of canonical-JSON outputs (UTF-8-safe). Secret-redacted. */
  outputsPreview?: string;
  asBinding?: string;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number;
  status: 'completed' | 'errored';
  errorMessage?: string;
}

/** A full run's timeline. Joins the manifest with its ordered events. */
export interface TraceTimeline {
  runId: string;
  packId: string;
  skill: string;
  ruleId: string;
  eventKind: string;
  startedAtMs: number;
  /** Null while the run is still in-flight (no terminal marker yet). */
  completedAtMs: number | null;
  totalDurationMs: number;
  status: TraceStatus;
  /** Sorted ascending by stepIdx. */
  events: TraceEvent[];
  /** Populated when the memo cache + cost router are wired (future). */
  llmCost?: { tokens: number; usd?: number };
}

/** Summary row for `listRecent` — does NOT carry per-step events. */
export interface TraceListEntry {
  runId: string;
  packId: string;
  skill: string;
  startedAtMs: number;
  status: TraceStatus;
  eventKind: string;
  stepCount: number;
}
