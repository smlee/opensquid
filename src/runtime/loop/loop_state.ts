/**
 * LSF.1 — `collectLoopState()`, the core loop-state READ-MODEL (subprocess-harness-push.md §2b).
 *
 * ONE typed, JSON-serializable contract (`LoopState`) that BOTH surfaces + the future loop-state UI consume —
 * the surfaces are THIN renderers over this, never re-implementations. It is a first-class read MODULE (NO CLI
 * imports) so the UI reuses it untouched. One board read per refresh (indexed by `updated_at`), no per-item
 * fan-out — scales to N parallel items.
 *
 * The read merges three pack-neutral sources:
 *   - the whole-board STAGE (level 1) from `CheckpointStore.listTaskCheckpoints()` (LSF.1),
 *   - the item's CURRENT-stage PHASE (level 2) from the wg-keyed `loop_phases` store (LSF.2) — a phase is shown
 *     ONLY while the item is still at the stage it was emitted under (a stale phase from a since-advanced stage
 *     is dropped: the phase row's `updated_at` predates the checkpoint's), and
 *   - the pack-DECLARED terminal stage(s) — read from the active v2 pack's compiled FSM (`kind: 'terminal'`),
 *     with a `done` fallback when no pack declares one (§2a).
 *
 * `collectLoopState` is PURE (no writes) and returns EVERY item — including terminal ones (`terminal: true`) —
 * so `--json`/the UI see the full truth. The live-view "scope shown / done lingers one iteration then drops"
 * membership rule (§2a) is a SEPARATE policy applied by the LIVE renderers via {@link filterLiveView}, which
 * owns the one-iteration linger marker. Keeping the read-model pure is what makes it UI-reusable.
 *
 * Imports from: ../durable/checkpoint_store.js, ../ralph/loop_stage.js, ./loop_phase_store.js, ./loop_db.js,
 *   ../bootstrap.js (terminal-stage resolution only, fail-open).
 * Imported by: src/cli/loop_status.ts (the renderer), the future loop-state UI.
 */
import type { Client } from '@libsql/client';

import { withTaskCheckpointStore } from '../ralph/loop_stage.js';
import { listLoopPhases } from './loop_phase_store.js';
import { withLoopDb } from './loop_db.js';

/**
 * ONE item's position on the board — the shared contract (§2b). Level 1 = stage (pack vocabulary, OPAQUE to
 * core); level 2 = phase within the stage (every stage); level 3 = optional finer sub-step (extensible WITHOUT
 * a schema change — additive fields only; `LoopState` is the API version boundary).
 */
export interface LoopStateItem {
  wgId: string;
  title?: string;
  /** Level 1 — the pack's stage string, read verbatim (core assigns it no meaning). */
  stage: string;
  /** Level 2 — the current phase WITHIN the stage, when the pack has emitted one for THIS stage. */
  phase?: string;
  phaseIndex?: number;
  phaseTotal?: number;
  /** Level 3 — optional finer sub-step (reserved; no writer yet — extensibility, not dead capability). */
  substep?: string;
  substepIndex?: number;
  substepTotal?: number;
  /** ms epoch of the item's most-recent stage advance (what the live view orders + lingers by). */
  updatedAt: number;
  /** True when `stage` is a pack-declared terminal stage — the linger-then-drop stage (§2a). */
  terminal: boolean;
}

/** The whole board — every item, one read (§2b). */
export type LoopState = LoopStateItem[];

/** The `done` fallback when no active pack declares a terminal stage (§2a). */
const DEFAULT_TERMINAL_STAGES = ['done'];

/**
 * Resolve the pack-DECLARED terminal stage(s): the active v2 pack's compiled FSM states whose `kind` is
 * `terminal`. FAIL-OPEN to the `done` fallback on ANY error (no active pack, load failure) — the read-model must
 * never throw because a pack failed to resolve. Pack-agnostic: core reads whatever the pack declares terminal;
 * it hardcodes only the fallback string.
 */
async function resolveTerminalStages(): Promise<Set<string>> {
  try {
    const { loadActiveV2Cartridges } = await import('../bootstrap.js');
    const cartridges = await loadActiveV2Cartridges('');
    const terminals = new Set<string>();
    for (const c of cartridges) {
      for (const [name, meta] of Object.entries(c.compiled.meta)) {
        if (meta.kind === 'terminal') terminals.add(name);
      }
    }
    return terminals.size > 0 ? terminals : new Set(DEFAULT_TERMINAL_STAGES);
  } catch {
    return new Set(DEFAULT_TERMINAL_STAGES);
  }
}

/**
 * Read the whole board once + merge stage + current-stage phase + terminal flag into the typed `LoopState`.
 * PURE (no writes). Every item is returned (terminal included) — the live-view membership filter is separate.
 */
export async function collectLoopState(): Promise<LoopState> {
  const [rows, phases, terminals] = await Promise.all([
    withTaskCheckpointStore((store) => store.listTaskCheckpoints()),
    listLoopPhases(),
    resolveTerminalStages(),
  ]);
  const phaseByWg = new Map(phases.map((p) => [p.wgId, p]));
  return rows.map((row) => {
    const item: LoopStateItem = {
      wgId: row.taskId,
      stage: row.stage,
      updatedAt: row.updatedAtMs,
      terminal: terminals.has(row.stage),
    };
    // Level 2 — attach the phase ONLY when it belongs to the item's CURRENT stage. A phase emitted under a stage
    // the item has since LEFT is stale: the checkpoint's `updated_at` (the stage advance) is NEWER than the
    // phase row's. Dropping on `phase.updatedAt < checkpoint.updatedAt` keeps the sub-step scoped to the live
    // stage without core knowing which phases belong to which stage (§2a — no stage vocabulary in core).
    const ph = phaseByWg.get(row.taskId);
    if (ph !== undefined && ph.updatedAtMs >= row.updatedAtMs) {
      item.phase = ph.phase;
      if (ph.phaseIndex !== null) item.phaseIndex = ph.phaseIndex;
      if (ph.phaseTotal !== null) item.phaseTotal = ph.phaseTotal;
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// Live-view membership (§2a) — the LINGER-THEN-DROP policy for the live renderers.
// ---------------------------------------------------------------------------

// The linger marker is SURFACE-SCOPED (composite PK surface+wg_id). §3.1 mandates BOTH live surfaces run
// concurrently (always-on status line + Monitor --watch); a single global marker would let whichever surface
// renders first consume the linger, so the finish would silently vanish on the other surface. Per-surface
// rows let each surface show a just-finished item exactly once on its OWN cadence.
const CREATE_SEEN_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS loop_terminal_seen (
    surface TEXT NOT NULL,
    wg_id TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (surface, wg_id)
  );
`;

/** The default surface label for a one-shot render / a caller that does not name its surface. */
export const DEFAULT_SURFACE = 'default';

/**
 * The one-iteration linger marker: records that a terminal item at a given `updated_at` has ALREADY been shown
 * once in the live view OF A GIVEN SURFACE. Injectable so {@link filterLiveView} is unit-testable without a
 * real db. Each surface (status-line / watch / default) keeps its own linger so the two design-mandated
 * concurrent surfaces don't consume each other's one-shot finish.
 */
export interface TerminalSeenStore {
  /** ms epoch this wg id's terminal state was last SHOWN on `surface`, or null if never. */
  get(wgId: string, surface: string): Promise<number | null>;
  /** Record that this wg id's terminal state at `updatedAtMs` has now been shown on `surface`. */
  mark(wgId: string, updatedAtMs: number, surface: string): Promise<void>;
}

/** The libsql-backed {@link TerminalSeenStore} (same store as the checkpoints — LSF co-location). */
export const libsqlTerminalSeenStore: TerminalSeenStore = {
  async get(wgId, surface) {
    return withLoopDb(async (db: Client) => {
      await db.execute(CREATE_SEEN_TABLE_SQL);
      const rs = await db.execute({
        sql: `SELECT updated_at_ms FROM loop_terminal_seen WHERE surface = ? AND wg_id = ?`,
        args: [surface, wgId],
      });
      const row = rs.rows[0];
      return row ? Number(row.updated_at_ms) : null;
    });
  },
  async mark(wgId, updatedAtMs, surface) {
    await withLoopDb(async (db: Client) => {
      await db.execute(CREATE_SEEN_TABLE_SQL);
      await db.execute({
        sql: `INSERT INTO loop_terminal_seen (surface, wg_id, updated_at_ms) VALUES (?, ?, ?)
              ON CONFLICT(surface, wg_id) DO UPDATE SET updated_at_ms = excluded.updated_at_ms`,
        args: [surface, wgId, updatedAtMs],
      });
    });
  },
};

/**
 * Apply the live-view membership rule (§2a) to a `LoopState`:
 *   - NON-terminal items (scope included — scoping IS active work) are ALWAYS shown.
 *   - a TERMINAL item lingers for exactly ONE iteration: it is shown the first time the live view observes it
 *     finished (and that observation is recorded), then DROPS on the next iteration. A re-finished item (its
 *     `updatedAt` changed) is a fresh terminal → shown once again.
 * The renderer passes `mark: true` (this render IS the iteration); a peek (no side effect) passes `mark: false`.
 * `surface` scopes the linger so each live surface (status-line / watch / default) shows a finish once on its
 * own cadence — the two design-mandated concurrent surfaces never consume each other's one-shot finish (§3.1).
 */
export async function filterLiveView(
  items: LoopState,
  seen: TerminalSeenStore = libsqlTerminalSeenStore,
  mark = true,
  surface: string = DEFAULT_SURFACE,
): Promise<LoopState> {
  const out: LoopState = [];
  for (const item of items) {
    if (!item.terminal) {
      out.push(item);
      continue;
    }
    const shownAt = await seen.get(item.wgId, surface);
    if (shownAt === item.updatedAt) continue; // already lingered one iteration at this state on this surface → drop
    out.push(item); // first observation of this terminal state → show it once
    if (mark) await seen.mark(item.wgId, item.updatedAt, surface);
  }
  return out;
}
