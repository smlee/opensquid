/**
 * OBSERVE.1 — trace timeline reader.
 *
 * Reads the existing DURABLE.1 + DURABLE.4 tables (`checkpoints` +
 * `run_manifests` + `terminal_markers`) and renders them as a typed
 * timeline. There is NO separate trace table — the checkpoint log IS
 * the trace data. Every query in this module hits those three tables
 * directly; nothing is duplicated, nothing is denormalized.
 *
 * Status inference (4 paths):
 *
 *   completed    — terminal_markers row exists AND no errored checkpoint
 *   errored      — terminal_markers row exists AND ≥1 errored checkpoint
 *   in_flight    — no terminal_markers row AND lastCompletedAtMs within
 *                  RESUME_WINDOW_MS (60s, same as Resumer)
 *   interrupted  — no terminal_markers row AND lastCompletedAtMs is older
 *                  than RESUME_WINDOW_MS (the Resumer would skip these)
 *
 * OpenTelemetry export uses derived IDs:
 *
 *   trace_id  =  sha256(runId).slice(0, 32)              // 16 bytes / 32 hex
 *   span_id   =  sha256(runId + ':' + stepIdx).slice(0, 16)  // 8 bytes / 16 hex
 *
 * Previews are truncated to 200 user-visible code points (UTF-8-safe via
 * `Array.from`) and then passed through `stripSecrets` from
 * `deliver_only.ts` — same regex pattern as the SCHED.2 deliver-only
 * webhook path. Inputs only carry a content-addressed hash in the
 * checkpoint, so `inputsPreview` is derived from the hash; outputs hold
 * the canonical-JSON-revived value so `outputsPreview` is a JSON snippet.
 *
 * Tail polling defaults to 1000ms with a 100ms floor — libsql is
 * resilient but hammering at 10ms doesn't reflect anything `tail`-shaped
 * a user actually needs.
 *
 * Imports from: @libsql/client, node:crypto, ../deliver_only.js,
 *               ../durable/canonical_json.js, ./trace_types.js.
 * Imported by: OBSERVE.2 CLI, downstream consumers via barrel.
 */

import type { Client } from '@libsql/client';

import { stripSecrets } from '../deliver_only.js';
import { canonicalJsonParse, canonicalJsonStringify } from '../durable/canonical_json.js';

import { toOtel } from './otel_export.js';

import type { TraceEvent, TraceListEntry, TraceStatus, TraceTimeline } from './trace_types.js';

/** Same window as `DEFAULT_RESUME_WINDOW_MS` in the Resumer. */
const RESUME_WINDOW_MS = 60_000;

/** Default polling interval for `tail`. */
const DEFAULT_TAIL_INTERVAL_MS = 1_000;

/** Floor for `tail` polling — don't let callers hammer libsql. */
const MIN_TAIL_INTERVAL_MS = 100;

const PREVIEW_CODEPOINT_CAP = 200;

export interface TailOpts {
  /** Earliest `completed_at_ms` to surface. Defaults to `Date.now()`. */
  sinceMs?: number;
  /** Optional pack filter. */
  packId?: string;
  /** Polling interval in ms; floored at 100ms; default 1000ms. */
  intervalMs?: number;
  /** AbortSignal to stop the polling loop cleanly. */
  signal?: AbortSignal;
}

export interface ListRecentOpts {
  limit?: number;
  sinceMs?: number;
  packId?: string;
  skill?: string;
  status?: TraceStatus;
}

export class TraceReader {
  constructor(
    private readonly db: Client,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /**
   * Materialize a full timeline for `runId`. Joins one row from
   * `run_manifests` with its ordered checkpoint rows, then derives status
   * from the presence of a `terminal_markers` row + the age of the last
   * completed step.
   *
   * Returns `null` when the manifest is missing — even if checkpoint rows
   * exist, an orphan run can't be reconstructed without manifest identity
   * (matches the Resumer's `manifest_missing` audit reason).
   */
  async getTimeline(runId: string): Promise<TraceTimeline | null> {
    const manifestRow = await this.db.execute({
      sql: `SELECT run_id, pack_id, skill, rule_id, event_kind, started_at_ms
            FROM run_manifests WHERE run_id = ? LIMIT 1`,
      args: [runId],
    });
    const m = manifestRow.rows[0];
    if (!m) return null;

    const checkpointsRs = await this.db.execute({
      sql: `SELECT step_idx, fn, inputs_hash, outputs_json, as_binding,
                   started_at_ms, completed_at_ms, status, error_message
            FROM checkpoints WHERE run_id = ? ORDER BY step_idx ASC`,
      args: [runId],
    });
    const terminalRs = await this.db.execute({
      sql: `SELECT terminated_at_ms FROM terminal_markers WHERE run_id = ? LIMIT 1`,
      args: [runId],
    });

    const events: TraceEvent[] = checkpointsRs.rows.map((r) => rowToTraceEvent(asRec(r), runId));

    const terminalRec = terminalRs.rows[0] !== undefined ? asRec(terminalRs.rows[0]) : null;
    const terminalAtMs = terminalRec !== null ? Number(terminalRec.terminated_at_ms) : null;
    const hasErrored = events.some((e) => e.status === 'errored');
    const lastCompletedAtMs =
      events.length > 0 ? Math.max(...events.map((e) => e.completedAtMs)) : 0;
    const status = inferStatus({
      hasTerminal: terminalRec !== null,
      hasErrored,
      lastCompletedAtMs,
      nowMs: this.nowMs(),
    });

    const manifest = asRec(m);
    const startedAtMs = Number(manifest.started_at_ms);
    const completedAtMs = terminalAtMs;
    const totalDurationMs =
      completedAtMs !== null
        ? Math.max(0, completedAtMs - startedAtMs)
        : Math.max(0, this.nowMs() - startedAtMs);

    return {
      runId,
      packId: asStr(manifest.pack_id),
      skill: asStr(manifest.skill),
      ruleId: asStr(manifest.rule_id),
      eventKind: asStr(manifest.event_kind),
      startedAtMs,
      completedAtMs,
      totalDurationMs,
      status,
      events,
    };
  }

  /**
   * Recent runs, filterable by pack/skill/status/window. Uses
   * `idx_run_manifests_started_at` for the time-range scan, which keeps
   * the query sub-100ms at 1M-row scale (validated via EXPLAIN — the
   * index is hit before the LEFT JOIN against terminal_markers).
   *
   * Status filter is applied AFTER the SQL pass since `interrupted` vs
   * `in_flight` is a time-based heuristic, not a column.
   */
  async listRecent(opts: ListRecentOpts = {}): Promise<TraceListEntry[]> {
    const limit = Math.max(1, opts.limit ?? 50);
    const sinceMs = opts.sinceMs ?? 0;
    const filters: string[] = ['m.started_at_ms >= ?'];
    const args: (string | number)[] = [sinceMs];
    if (opts.packId !== undefined) {
      filters.push('m.pack_id = ?');
      args.push(opts.packId);
    }
    if (opts.skill !== undefined) {
      filters.push('m.skill = ?');
      args.push(opts.skill);
    }
    const sql = `
      SELECT m.run_id AS run_id,
             m.pack_id AS pack_id,
             m.skill AS skill,
             m.event_kind AS event_kind,
             m.started_at_ms AS started_at_ms,
             t.terminated_at_ms AS terminated_at_ms,
             (SELECT COUNT(*) FROM checkpoints c WHERE c.run_id = m.run_id) AS step_count,
             (SELECT MAX(c.completed_at_ms) FROM checkpoints c WHERE c.run_id = m.run_id) AS last_at_ms,
             (SELECT COUNT(*) FROM checkpoints c
                WHERE c.run_id = m.run_id AND c.status = 'errored') AS errored_count
      FROM run_manifests m
      LEFT JOIN terminal_markers t ON t.run_id = m.run_id
      WHERE ${filters.join(' AND ')}
      ORDER BY m.started_at_ms DESC
      LIMIT ?
    `;
    args.push(limit);
    const rs = await this.db.execute({ sql, args });
    const now = this.nowMs();
    const entries: TraceListEntry[] = [];
    for (const rowRaw of rs.rows) {
      const row = asRec(rowRaw);
      const lastAt =
        row.last_at_ms === null || row.last_at_ms === undefined ? 0 : Number(row.last_at_ms);
      const status = inferStatus({
        hasTerminal: row.terminated_at_ms !== null && row.terminated_at_ms !== undefined,
        hasErrored: Number(row.errored_count) > 0,
        lastCompletedAtMs: lastAt,
        nowMs: now,
      });
      if (opts.status !== undefined && opts.status !== status) continue;
      entries.push({
        runId: asStr(row.run_id),
        packId: asStr(row.pack_id),
        skill: asStr(row.skill),
        eventKind: asStr(row.event_kind),
        startedAtMs: Number(row.started_at_ms),
        status,
        stepCount: Number(row.step_count),
      });
    }
    return entries;
  }

  /**
   * Polling tail. Returns an `AsyncIterable<TraceEvent>` that yields every
   * checkpoint row whose `completed_at_ms` is `> cursor`, where `cursor`
   * starts at `opts.sinceMs` and advances after every batch.
   *
   * Termination: caller passes an `AbortSignal`. When aborted, the
   * generator returns cleanly (no thrown error, no leaked timer).
   *
   * libsql has no CDC; polling at 1s is fine for human-facing tail use
   * cases. Higher-frequency consumers (CI dashboards) can drop to the
   * 100ms floor.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async tail(opts: TailOpts = {}): Promise<AsyncIterable<TraceEvent>> {
    const interval = Math.max(MIN_TAIL_INTERVAL_MS, opts.intervalMs ?? DEFAULT_TAIL_INTERVAL_MS);
    let cursor = opts.sinceMs ?? this.nowMs();
    const packId = opts.packId;
    const signal = opts.signal;
    const db = this.db;

    async function* gen(): AsyncIterable<TraceEvent> {
      while (!signal?.aborted) {
        const filters: string[] = ['c.completed_at_ms > ?'];
        const args: (string | number)[] = [cursor];
        if (packId !== undefined) {
          filters.push('m.pack_id = ?');
          args.push(packId);
        }
        const sql = `
          SELECT c.run_id AS run_id, c.step_idx AS step_idx, c.fn AS fn,
                 c.inputs_hash AS inputs_hash, c.outputs_json AS outputs_json,
                 c.as_binding AS as_binding, c.started_at_ms AS started_at_ms,
                 c.completed_at_ms AS completed_at_ms, c.status AS status,
                 c.error_message AS error_message
          FROM checkpoints c
          ${packId !== undefined ? 'INNER JOIN run_manifests m ON m.run_id = c.run_id' : ''}
          WHERE ${filters.join(' AND ')}
          ORDER BY c.completed_at_ms ASC, c.step_idx ASC
        `;
        const rs = await db.execute({ sql, args });
        for (const r of rs.rows) {
          const rec = asRec(r);
          const ev = rowToTraceEvent(rec, asStr(rec.run_id));
          if (ev.completedAtMs > cursor) cursor = ev.completedAtMs;
          yield ev;
        }
        if (signal?.aborted) return;
        await sleep(interval, signal);
      }
    }

    return gen();
  }

  /**
   * Serialize a timeline as JSON (pretty) or OTEL (subset of the OTLP
   * trace JSON format — vendor-importable into AgentOps / LangSmith /
   * Jaeger). Returns `''` for a nonexistent runId so callers don't have
   * to disambiguate `null` vs serialization failure.
   */
  async export(runId: string, format: 'json' | 'otel'): Promise<string> {
    const t = await this.getTimeline(runId);
    if (t === null) return '';
    if (format === 'json') return JSON.stringify(t, null, 2);
    return JSON.stringify(toOtel(t), null, 2);
  }
}

/**
 * Re-typing helper. libsql's `Row` types cells as `Value`
 * (`null | string | number | bigint | ArrayBuffer`); narrowing through
 * `Record<string, unknown>` lets ESLint's no-base-to-string accept
 * `String(...)` / `Number(...)` casts on unknown cells (we know which
 * column is which type from the SQL schema).
 */
function asRec(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  return '';
}

/**
 * Map one canonicalized checkpoint row to a TraceEvent. Centralizing this
 * keeps the two read paths (`getTimeline` + `tail`) consistent — both
 * emit the same TraceEvent shape with the same preview / status logic.
 */
function rowToTraceEvent(rec: Record<string, unknown>, runId: string): TraceEvent {
  const outputsJsonRaw = rec.outputs_json;
  const outputs = typeof outputsJsonRaw === 'string' ? canonicalJsonParse(outputsJsonRaw) : null;
  const inputsHash = asStr(rec.inputs_hash);
  const completedAtMs = Number(rec.completed_at_ms);
  const startedAtMs = Number(rec.started_at_ms);
  const asBindingRaw = rec.as_binding;
  const errorRaw = rec.error_message;
  const status: 'completed' | 'errored' = rec.status === 'errored' ? 'errored' : 'completed';
  const ev: TraceEvent = {
    runId,
    stepIdx: Number(rec.step_idx),
    fn: asStr(rec.fn),
    inputsHash,
    outputs,
    startedAtMs,
    completedAtMs,
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    status,
  };
  const inputsPreview = previewForInputsHash(inputsHash);
  if (inputsPreview !== undefined) ev.inputsPreview = inputsPreview;
  const outputsPreview = previewForOutputs(outputs);
  if (outputsPreview !== undefined) ev.outputsPreview = outputsPreview;
  if (typeof asBindingRaw === 'string') ev.asBinding = asBindingRaw;
  if (typeof errorRaw === 'string') ev.errorMessage = errorRaw;
  return ev;
}

interface StatusInferInput {
  hasTerminal: boolean;
  hasErrored: boolean;
  lastCompletedAtMs: number;
  nowMs: number;
}

function inferStatus(input: StatusInferInput): TraceStatus {
  if (input.hasTerminal) return input.hasErrored ? 'errored' : 'completed';
  const age = input.nowMs - input.lastCompletedAtMs;
  if (input.lastCompletedAtMs === 0) return 'in_flight';
  return age <= RESUME_WINDOW_MS ? 'in_flight' : 'interrupted';
}

/**
 * UTF-8-safe truncate. `Array.from` yields one element per Unicode code
 * point (correctly handling surrogate pairs), so `slice` then `join`
 * never splits mid-codepoint. Then redact secret-bearing key/value
 * patterns via the same regex used by SCHED.2 deliver-only.
 */
function truncatePreview(text: string): string {
  const cps = Array.from(text);
  const clipped =
    cps.length > PREVIEW_CODEPOINT_CAP ? cps.slice(0, PREVIEW_CODEPOINT_CAP).join('') : text;
  return stripSecrets(clipped).text;
}

function previewForOutputs(outputs: unknown): string | undefined {
  if (outputs === null || outputs === undefined) return undefined;
  try {
    const json = canonicalJsonStringify(outputs);
    return truncatePreview(json);
  } catch {
    return undefined;
  }
}

function previewForInputsHash(hash: string): string | undefined {
  if (hash === '') return undefined;
  // Inputs themselves are not stored — only the content-addressed hash.
  // Surface the hash prefix so a user can correlate replay attempts.
  return `inputs_hash:${hash.slice(0, 16)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
