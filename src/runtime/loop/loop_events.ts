/**
 * LMP.1 + LMP.4 — the PUSH / LIVE-STREAM monitor feed's single source of truth.
 *
 * The loop monitor is a PUSH stream, not a pull: every state change appends ONE {@link MonitorEvent} to a
 * durable append-only `loop_events` log, and consumers TAIL / FOLD the log (they never re-derive from three
 * tables). This module owns that log (LMP.1 — the store + the raw cursor read) AND the consumer-side derivation
 * (LMP.4 — the pure fold into per-item latest state + the live subscribe primitive). Staleness is solved by the
 * pushed close event: `item_shipped`/`item_closed` fold to `terminal:true`, and the live view drops it — no
 * wg-status pull-join, no `loop_terminal_seen` linger table. Freshness is the push cadence itself: each item's
 * `lastEventAtMs` IS the "how long since it moved" signal (no separate heartbeat store/timer).
 *
 * Design of record: docs/design/opensquid-loop-monitoring-fix.md §6 (the eight CLOSED push/stream decisions).
 * The log's home is a NEW `loop_events` table in the project-local `opensquid.db` (via `withLoopDb`) — co-located
 * with `loop_phases`/`loop_metrics`/`task_checkpoints`; NOT `loop_metrics` (wrong per-stage-metrics grain,
 * loop_metrics.ts:13-14), NOT a flat file (SSOT §6.1), NOT `transitions.jsonl` (a separate subsystem).
 *
 * CORE carries NO stage vocabulary: `stage`/`phase` are OPAQUE strings stamped verbatim; only `kind`/`lifecycle`
 * are closed enums. Encoding a pack's phase names in core is the exact boundary leak loop_phase_store.ts:9-20
 * warns against.
 *
 * Imports from: @libsql/client, ./loop_db.js.
 * Imported by: ./monitor_emit.ts (the fail-open emit at the mutation), ./loop_state.ts (the fold consumer),
 *   src/cli/loop_status.ts (the --watch tail).
 */
import type { Client } from '@libsql/client';

import { withLoopDb } from './loop_db.js';

/** The closed set of state-change kinds the feed pushes (core; a pack never adds one). */
export type MonitorEventKind =
  | 'stage_advance'
  | 'phase_enter'
  | 'phase_leave'
  | 'item_closed'
  | 'item_shipped'
  | 'item_wedged';

/** The phase lifecycle marker — `running` on enter (⟳), `done` on leave (✓). Level-2; NO stage vocabulary. */
export type PhaseLifecycle = 'running' | 'done';

/** ONE pushed monitor event — the whole feed is a fold over these. `seq` is store-assigned (monotonic cursor). */
export interface MonitorEvent {
  seq: number;
  wgId: string;
  kind: MonitorEventKind;
  /** Set on `stage_advance` (opaque pack string; core assigns it no meaning). */
  stage?: string | undefined;
  /** Set on `phase_enter`/`phase_leave` (opaque pack string). */
  phase?: string | undefined;
  index?: number | undefined;
  total?: number | undefined;
  /** `running` on `phase_enter`, `done` on `phase_leave`. */
  lifecycle?: PhaseLifecycle | undefined;
  atMs: number;
}

/** The append input — the store assigns `seq` (a caller never supplies it). */
export type NewMonitorEvent = Omit<MonitorEvent, 'seq'>;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS loop_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- strictly increasing, gap-safe cursor (exactly-once tail)
    wg_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    stage TEXT,
    phase TEXT,
    phase_index INTEGER,
    phase_total INTEGER,
    lifecycle TEXT,
    at_ms INTEGER NOT NULL
  );
`;
const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_loop_events_wg ON loop_events(wg_id);`;

async function ensureTable(db: Client): Promise<void> {
  await db.execute(CREATE_TABLE_SQL);
  await db.execute(CREATE_INDEX_SQL);
}

/** Coerce a stored `lifecycle` cell to the closed enum (unknown/absent → `running`). */
function coerceLifecycle(cell: unknown): PhaseLifecycle | undefined {
  if (cell === null || cell === undefined) return undefined;
  return cell === 'done' ? 'done' : 'running';
}

/** Read a nullable TEXT cell as a string (a non-string/NULL cell → `undefined`) — avoids `String()` on `unknown`. */
function asOptStr(cell: unknown): string | undefined {
  return typeof cell === 'string' ? cell : undefined;
}

/**
 * Append one event (fail-CLOSED at this layer — it may throw). The FAIL-OPEN wrapping at the mutation is LMP.2's
 * `emitMonitorEvent`; keeping the store fail-closed and the mutation wrapper fail-open keeps the store testable
 * and the mutation safe. The store assigns `seq` (the input omits it), mirroring `AuditLog.append`.
 */
export async function appendMonitorEvent(ev: NewMonitorEvent): Promise<void> {
  await withLoopDb(async (db) => {
    await ensureTable(db);
    await db.execute({
      sql: `INSERT INTO loop_events (wg_id, kind, stage, phase, phase_index, phase_total, lifecycle, at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ev.wgId,
        ev.kind,
        ev.stage ?? null,
        ev.phase ?? null,
        ev.index ?? null,
        ev.total ?? null,
        ev.lifecycle ?? null,
        ev.atMs,
      ],
    });
  });
}

/**
 * The raw cursor read — every event with `seq > sinceSeq`, in ascending `seq` order (`seq` included), so a
 * consumer resuming from a cursor sees every event exactly once, in order (exactly-once resume, gap-safe).
 */
export async function tailEventsSince(sinceSeq: number): Promise<MonitorEvent[]> {
  return withLoopDb(async (db) => {
    await ensureTable(db);
    const rs = await db.execute({
      sql: `SELECT seq, wg_id, kind, stage, phase, phase_index, phase_total, lifecycle, at_ms
            FROM loop_events WHERE seq > ? ORDER BY seq ASC`,
      args: [sinceSeq],
    });
    return rs.rows.map((r) => ({
      seq: Number(r.seq),
      wgId: typeof r.wg_id === 'string' ? r.wg_id : '',
      kind: (asOptStr(r.kind) ?? '') as MonitorEventKind,
      stage: asOptStr(r.stage),
      phase: asOptStr(r.phase),
      index: r.phase_index === null ? undefined : Number(r.phase_index),
      total: r.phase_total === null ? undefined : Number(r.phase_total),
      lifecycle: coerceLifecycle(r.lifecycle),
      atMs: Number(r.at_ms),
    }));
  });
}

// ---------------------------------------------------------------------------
// LMP.4 — the consumer API: the pure fold (materialized latest-state) + the live subscribe primitive.
// ---------------------------------------------------------------------------

/** ONE item's current state, folded from the ordered event log. `terminal` carries the staleness drop. */
export interface LoopFoldState {
  wgId: string;
  stage?: string | undefined;
  phase?: string | undefined;
  index?: number | undefined;
  total?: number | undefined;
  lifecycle?: PhaseLifecycle | undefined;
  /** The push-cadence freshness signal (decision 5 — NO separate heartbeat store/timer). */
  lastEventAtMs: number;
  /** Latest event was `item_closed`/`item_shipped` → the live view drops it (the staleness fix, decision 2). */
  terminal: boolean;
}

/**
 * PURE, deterministic reducer — fold an ORDERED (seq-ascending) event slice into per-item latest state. Folding
 * the SAME events in `seq` order is chunk-invariant (a consumer resuming mid-stream and one folding the whole
 * log reach the same state — pre-research risk §7). `stage_advance` CLEARS the phase (a new stage has no phase
 * yet); `phase_enter`/`phase_leave` set the phase + lifecycle; `item_shipped`/`item_closed` mark terminal;
 * `item_wedged` leaves the item visible (parked awaiting the human — the feed does not re-derive the reason).
 */
export function foldEvents(events: MonitorEvent[]): LoopFoldState[] {
  const byWg = new Map<string, LoopFoldState>();
  for (const e of events) {
    const s = byWg.get(e.wgId) ?? { wgId: e.wgId, lastEventAtMs: e.atMs, terminal: false };
    s.lastEventAtMs = e.atMs;
    switch (e.kind) {
      case 'stage_advance':
        s.stage = e.stage;
        s.phase = undefined;
        s.index = undefined;
        s.total = undefined;
        s.lifecycle = undefined;
        s.terminal = false; // a re-opened/advancing item is live again
        break;
      case 'phase_enter':
        s.phase = e.phase;
        s.index = e.index;
        s.total = e.total;
        s.lifecycle = 'running';
        break;
      case 'phase_leave':
        s.phase = e.phase;
        s.index = e.index;
        s.total = e.total;
        s.lifecycle = 'done';
        break;
      case 'item_shipped':
      case 'item_closed':
        s.terminal = true;
        break;
      case 'item_wedged':
        break; // parked, still shown (the feed does not re-derive the reason — §5 OUT)
    }
    byWg.set(e.wgId, s);
  }
  return [...byWg.values()];
}

/**
 * The FULL-truth materialization (terminal items INCLUDED, marked `terminal:true`) — the old `collectLoopState`
 * all-items contract, so `--json`/the UI still see everything. The live-view DROP of terminal items is a
 * consumer filter (LMP.5's `liveItems`), never a fold omission (or `--json` loses truth).
 */
export async function foldLatestState(): Promise<LoopFoldState[]> {
  return foldEvents(await tailEventsSince(0));
}

/**
 * The live cursor loop — tail past `sinceSeq`, invoke `onEvent` for each NEW event as it lands (in `seq` order),
 * advance the cursor past the max `seq`, repeat. The primitive `--watch`/Monitor tail (LMP.5 wires it): a new
 * consumer subscribes with ZERO write-path change (scalability §6.3). The poll interval is a fallback cadence,
 * not the freshness mechanism; the cursor advance is exactly-once (never re-emits an event).
 */
export async function subscribeMonitor(
  sinceSeq: number,
  onEvent: (e: MonitorEvent) => void,
  opts: { intervalMs?: number; shouldStop?: () => boolean } = {},
): Promise<void> {
  let cursor = sinceSeq;
  const interval = opts.intervalMs ?? 1000;
  while (!(opts.shouldStop?.() ?? false)) {
    const batch = await tailEventsSince(cursor);
    for (const e of batch) {
      onEvent(e);
      cursor = e.seq;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
