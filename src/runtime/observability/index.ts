/**
 * Observability module barrel (OBSERVE.1).
 *
 * Public surface:
 *
 *   TraceReader      — libsql-backed reader over `checkpoints` +
 *                      `run_manifests` + `terminal_markers`
 *   TailOpts         — args for `TraceReader.tail`
 *   ListRecentOpts   — args for `TraceReader.listRecent`
 *   TraceEvent       — one primitive-call boundary
 *   TraceTimeline    — one run's ordered timeline + manifest identity
 *   TraceListEntry   — `listRecent` row (no per-step events)
 *   TraceStatus      — completed | in_flight | errored | interrupted
 *
 * The reader does NOT introduce new tables. Every query hits DURABLE.1's
 * `checkpoints` + DURABLE.4's `run_manifests` and `terminal_markers`.
 * Single source of truth.
 */

export { TraceReader, type ListRecentOpts, type TailOpts } from './trace_reader.js';

export type { TraceEvent, TraceListEntry, TraceStatus, TraceTimeline } from './trace_types.js';
