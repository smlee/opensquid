/**
 * LSF.1 / LMP.5 — `collectLoopState()`, the loop-state READ-MODEL, now a FOLD over the PUSH stream.
 *
 * ONE typed, JSON-serializable contract (`LoopState`) that BOTH live surfaces + the future loop-state UI consume
 * — the surfaces are THIN renderers over this, never re-implementations. It is a first-class read MODULE (NO CLI
 * imports) so the UI reuses it untouched.
 *
 * LMP.5/LMP.6 — the read is now a DERIVATION over the `loop_events` push stream (`foldLatestState`), NOT a
 * three-table `Promise.all` pull: `collectLoopState` maps the fold's per-item latest state onto the
 * `LoopStateItem` contract. Freshness is the push cadence (`lastActivityMs` = the last-event timestamp);
 * staleness is solved by the pushed close event (`terminal:true` from `item_shipped`/`item_closed`), so the
 * live-view drop is a simple `liveItems` filter — the old per-refresh cartridge terminal-resolution, the
 * `loop_terminal_seen` linger table, and `filterLiveView` are GONE (one model, no pull).
 *
 * `collectLoopState` is PURE (no writes) and returns EVERY item — including terminal ones (`terminal: true`) —
 * so `--json`/the UI see the full truth; the live surfaces apply {@link liveItems}.
 *
 * Imports from: ./loop_events.js (the fold consumer API).
 * Imported by: src/cli/loop_status.ts (the renderer), the future loop-state UI.
 */
import {
  foldLatestState,
  foldLatestStateIncremental,
  type LoopFoldState,
  type PhaseLifecycle,
} from './loop_events.js';

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
  phase?: string | undefined;
  phaseIndex?: number | undefined;
  phaseTotal?: number | undefined;
  /** Level 2 — `running` (⟳) on phase enter, `done` (✓) on phase leave (undefined when no phase shown). */
  lifecycle?: PhaseLifecycle | undefined;
  /** Level 3 — optional finer sub-step (reserved; no writer yet — extensibility, not dead capability). */
  substep?: string;
  substepIndex?: number;
  substepTotal?: number;
  /** ms epoch of the item's most-recent monitor event — the freshness signal (= the fold's `lastEventAtMs`). */
  lastActivityMs?: number | undefined;
  /** ms epoch of the item's most-recent stage advance (what the live view orders + lingers by). */
  updatedAt: number;
  /** True when the item's latest event was a close/ship — the live view drops it (staleness fix). */
  terminal: boolean;
}

/** The whole board — every item, one read (§2b). */
export type LoopState = LoopStateItem[];

/**
 * Read the whole board once as a FOLD over the push stream + map it onto the typed `LoopState`. PURE (no
 * writes). Every item is returned (terminal included) — the live-view membership filter ({@link liveItems}) is
 * separate, so `--json`/the UI keep the full truth.
 */
export async function collectLoopState(): Promise<LoopState> {
  return mapFold(await foldLatestState()); // ONE stream read — no three-table pull
}

/**
 * The SAME board as {@link collectLoopState}, folded INCREMENTALLY from a cursor (§C.12) — the read the SLC.2
 * snapshot writer rides on the emit path, so re-publishing the fragment on every state change is O(new events),
 * never a whole-log re-scan (which on the emit path is O(N²) over a project's life). On-demand callers (the CLI,
 * `--json`) keep {@link collectLoopState}; only the per-emit writer needs the materialized cursor.
 */
export async function collectLoopStateIncremental(): Promise<LoopState> {
  return mapFold(await foldLatestStateIncremental());
}

/** The shared fold→contract mapping (one rule for both the whole-log and incremental reads). */
function mapFold(fold: LoopFoldState[]): LoopState {
  return fold.map((f) => ({
    wgId: f.wgId,
    stage: f.stage ?? '',
    phase: f.phase,
    phaseIndex: f.index,
    phaseTotal: f.total,
    lifecycle: f.lifecycle,
    lastActivityMs: f.lastEventAtMs,
    updatedAt: f.lastEventAtMs,
    terminal: f.terminal,
  }));
}

/**
 * The live-view membership filter (§2a) — the pushed close event's `terminal` flag IS the drop. A shipped/closed
 * item is dropped instead of frozen at its last stage (the staleness fix); the close event is tailed once so a
 * watcher still SEES the finish, so no `loop_terminal_seen` linger table is needed (decision 2/3).
 */
export function liveItems(state: LoopState): LoopState {
  return state.filter((i) => !i.terminal);
}
