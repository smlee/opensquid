/**
 * LSF.3 / LMP.5 — `opensquid loop-status`: the THIN renderer over the `collectLoopState` fold (LSF.1/LMP.5) +
 * the `loop_metrics` history (LSF.5). Renders whatever stage/phase STRINGS exist — NO built-in stage vocabulary
 * (pack-agnostic). It NEVER writes the loop stores (a read surface only).
 *
 * LMP.5/LMP.6 — the live view is a FOLD/TAIL over the push stream: the status line + default read the cheap
 * materialized latest-state (`collectLoopState` → `liveItems`), and `--watch` TAILS new events via
 * `subscribeMonitor` (one line per change) instead of a 2s poll+snapshot-diff. `renderItem` ALWAYS renders a
 * relative-age token (`formatRelativeAge`) + the running/done marker (⟳/✓) so a glance answers item · stage ·
 * phase (idx/total) · running-or-done · how-long-since-it-moved. The old pull surfaces (`filterLiveView` +
 * `loop_terminal_seen` linger, the poll loop) are GONE.
 *
 * Modes (subprocess-harness-push.md §2.3):
 *   --json         the raw LoopState contract (full truth; the exact shape the future UI reads).
 *   --status-line  exactly ONE line, --width-truncatable, NEVER throws, active few + "+N more", stable
 *                  non-empty idle line ("silence is a bug, not success").
 *   --watch        Monitor stream: one line per pushed event, a terminal line on drain.
 *   --metrics      SQL-filterable read over loop_metrics: --since <ISO|ms> [--task <id>] [--harness <name>].
 *
 * Imports from: commander, ../runtime/loop/loop_state.js, ../runtime/loop/loop_events.js,
 *   ../runtime/loop/loop_metrics.js.
 * Imported by: src/cli.ts (registerLoopStatus).
 */
import type { Command } from 'commander';

import {
  collectLoopState,
  liveItems,
  type LoopState,
  type LoopStateItem,
} from '../runtime/loop/loop_state.js';
import {
  subscribeMonitor,
  tailEventsSince,
  foldEvents,
  type MonitorEvent,
} from '../runtime/loop/loop_events.js';
import { readMetrics, aggregatePerLoop, type MetricsFilter } from '../runtime/loop/loop_metrics.js';

/** The stable, NON-EMPTY idle line — an empty board is a state, not silence. */
const IDLE_LINE = '🦑 loop idle — no items in flight';

/** The explicit drain announcement — silence is not success. */
const DRAIN_LINE = '■ loop drained — no items in flight';

/** A pure relative-age token from an elapsed-ms delta: `just now` / `Nm ago` / `Nh ago` (never throws on NaN). */
export function formatRelativeAge(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 60_000) return 'just now';
  const m = Math.floor(deltaMs / 60_000);
  return m < 60 ? `${String(m)}m ago` : `${String(Math.floor(m / 60))}h ago`;
}

/**
 * Render ONE item: `wgId · stage[ · phase (idx/total) ⟳|✓] · <age>`. `now` is injectable (default `Date.now()`)
 * so the renderer is deterministic in tests, and it is TOTAL (never throws — the never-throws status-line
 * contract): a missing `lastActivityMs` falls back to `updatedAt`, and `formatRelativeAge` tolerates NaN.
 */
export function renderItem(item: LoopStateItem, now: number = Date.now()): string {
  const parts = [item.wgId, item.stage];
  if (item.phase !== undefined) {
    const counter =
      item.phaseIndex !== undefined && item.phaseTotal !== undefined
        ? ` (${String(item.phaseIndex)}/${String(item.phaseTotal)})`
        : '';
    const mark = item.lifecycle === 'done' ? ' ✓' : item.lifecycle === 'running' ? ' ⟳' : '';
    parts.push(`${item.phase}${counter}${mark}`);
  }
  parts.push(formatRelativeAge(now - (item.lastActivityMs ?? item.updatedAt))); // ALWAYS rendered (decision 5)
  return parts.join(' · ');
}

/**
 * The status-line render: one line, width-bounded, `+N more` overflow. As many items as fit within `width`
 * (leaving room for the overflow suffix), oldest-stalest last. Falls back to the idle line for an empty board.
 * PURE — the caller wraps it so a render bug can never throw on the status line.
 */
export function renderStatusLine(items: LoopState, width = 120, now: number = Date.now()): string {
  if (items.length === 0) return IDLE_LINE;
  const rendered = items.map((i) => renderItem(i, now));
  const prefix = '🦑 ';
  const out: string[] = [];
  let used = prefix.length;
  for (let i = 0; i < rendered.length; i++) {
    const chunk = rendered[i] ?? '';
    const sep = out.length > 0 ? '  ' : '';
    const remaining = rendered.length - i;
    // reserve room for a `  +N more` suffix if anything after this would overflow
    const suffix = remaining > 1 ? `  +${String(remaining - 1)} more` : '';
    const cost = sep.length + chunk.length;
    if (used + cost + suffix.length > width && out.length > 0) {
      out.push(`+${String(remaining)} more`);
      return prefix + joinLine(out);
    }
    out.push(chunk);
    used += cost;
  }
  return prefix + joinLine(out);
}

/** Join rendered chunks; a trailing `+N more` token is glued without the `·`-style separator being ambiguous. */
function joinLine(chunks: string[]): string {
  return chunks.join('  ');
}

/** The current live board — the fold over the push stream, terminal items dropped. */
async function liveView(): Promise<LoopState> {
  return liveItems(await collectLoopState());
}

function parseSince(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const asNum = Number(since);
  if (Number.isFinite(asNum) && since.trim() !== '') return asNum; // ms epoch
  const asDate = Date.parse(since); // ISO
  return Number.isNaN(asDate) ? undefined : asDate;
}

interface LoopStatusOpts {
  json?: boolean;
  statusLine?: boolean;
  watch?: boolean;
  width?: string;
  metrics?: boolean;
  since?: string;
  task?: string;
  harness?: string;
  interval?: string;
}

export function registerLoopStatus(program: Command): void {
  program
    .command('loop-status')
    .description('Live loop-state feed (status line / Monitor) + the loop_metrics history.')
    .option('--json', 'emit the raw LoopState (or metrics) JSON — the shape the UI reads')
    .option('--status-line', 'ONE width-bounded line for the harness status line (never throws)')
    .option(
      '--watch',
      'stream one line per pushed change for the Monitor tool (terminal line on drain)',
    )
    .option('--width <n>', 'bound the --status-line render width (default 120)')
    .option('--metrics', 'read the loop_metrics history instead of the live state')
    .option('--since <iso|ms>', 'metrics: only rows at/after this time')
    .option('--task <id>', 'metrics: only this item id')
    .option('--harness <name>', 'metrics: only this harness')
    .option('--interval <ms>', '--watch tail interval (default 1000)')
    .action(async (opts: LoopStatusOpts) => {
      if (opts.metrics === true) {
        await runMetrics(opts);
        return;
      }
      if (opts.statusLine === true) {
        // NEVER throws — a render/read fault degrades to the stable idle line, never a broken status bar.
        try {
          const width = opts.width !== undefined ? Number(opts.width) : 120;
          process.stdout.write(
            renderStatusLine(await liveView(), Number.isFinite(width) ? width : 120) + '\n',
          );
        } catch {
          process.stdout.write(IDLE_LINE + '\n');
        }
        return;
      }
      if (opts.watch === true) {
        await runWatch(opts);
        return;
      }
      // default / --json — the raw contract
      const state = await collectLoopState();
      if (opts.json === true) {
        process.stdout.write(JSON.stringify(state, null, 2) + '\n');
      } else {
        const view = liveItems(state);
        process.stdout.write(
          view.length === 0 ? IDLE_LINE + '\n' : view.map((i) => renderItem(i)).join('\n') + '\n',
        );
      }
    });
}

/** Render one pushed event as a single stream line (kind → the changed facet), age-stamped from its `atMs`. */
function renderEvent(e: MonitorEvent, now: number = Date.now()): string {
  const age = formatRelativeAge(now - e.atMs);
  switch (e.kind) {
    case 'stage_advance':
      return `${e.wgId} · ${e.stage ?? ''} · ${age}`;
    case 'phase_enter':
    case 'phase_leave': {
      const counter =
        e.index !== undefined && e.total !== undefined
          ? ` (${String(e.index)}/${String(e.total)})`
          : '';
      const mark = e.lifecycle === 'done' ? ' ✓' : ' ⟳';
      return `${e.wgId} · ${e.phase ?? ''}${counter}${mark} · ${age}`;
    }
    case 'item_shipped':
      return `${e.wgId} · ✓ shipped · ${age}`;
    case 'item_closed':
      return `${e.wgId} · ✓ closed · ${age}`;
    case 'item_wedged':
      return `${e.wgId} · ⚠ wedged · ${age}`;
  }
}

/**
 * --watch: TAIL the push stream (`subscribeMonitor`), emit one line per pushed event, and announce the drain
 * when every item has closed (silence is not success). A watcher joining mid-flight first sees the current live
 * board; the tail then streams each change. The live set is maintained from the events themselves (a close/ship
 * removes the item; a wedge keeps it shown) so the drain is exact — no pull.
 */
async function runWatch(opts: LoopStatusOpts): Promise<void> {
  const interval = opts.interval !== undefined ? Number(opts.interval) : 1000;
  const intervalMs = Number.isFinite(interval) ? interval : 1000;

  // Seed from the whole log: render the current live board once, track the live set, and start the tail cursor
  // past the last seen event (so the stream only shows NEW changes).
  const seed = await tailEventsSince(0);
  const live = new Set<string>();
  for (const f of foldEvents(seed)) if (!f.terminal) live.add(f.wgId);
  const state = liveItems(await collectLoopState());
  for (const item of state) process.stdout.write(renderItem(item) + '\n');
  if (live.size === 0) {
    process.stdout.write(DRAIN_LINE + '\n');
    return;
  }
  const cursor = seed.length > 0 ? Math.max(...seed.map((e) => e.seq)) : 0;

  let drained = false;
  await subscribeMonitor(
    cursor,
    (e) => {
      process.stdout.write(renderEvent(e) + '\n');
      if (e.kind === 'item_shipped' || e.kind === 'item_closed') live.delete(e.wgId);
      else live.add(e.wgId); // a stage/phase advance (or a re-open) makes the item live again
      if (live.size === 0 && !drained) {
        process.stdout.write(DRAIN_LINE + '\n');
        drained = true;
      }
    },
    { intervalMs, shouldStop: () => drained },
  );
}

/** --metrics: the SQL-filterable read (per-stage rows + a per-loop aggregate footer). */
async function runMetrics(opts: LoopStatusOpts): Promise<void> {
  const filter: MetricsFilter = {};
  const since = parseSince(opts.since);
  if (since !== undefined) filter.sinceMs = since;
  if (opts.task !== undefined) filter.itemId = opts.task;
  if (opts.harness !== undefined) filter.harness = opts.harness;
  const [stages, loops] = await Promise.all([readMetrics(filter), aggregatePerLoop(filter)]);
  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ stages, loops }, null, 2) + '\n');
    return;
  }
  if (stages.length === 0) {
    process.stdout.write('no loop_metrics rows match the filter\n');
    return;
  }
  process.stdout.write('per-stage:\n');
  for (const r of stages) {
    const iso = new Date(r.startedAtMs).toISOString();
    process.stdout.write(
      `  ${iso}  ${r.itemId} · ${r.stage}  ${r.harness}/${r.authMode}  ` +
        `${(r.durationMs / 1000).toFixed(1)}s  $${r.costUsd.toFixed(4)}  ` +
        `${String(r.inputTokens)}in/${String(r.outputTokens)}out\n`,
    );
  }
  process.stdout.write('per-loop:\n');
  for (const r of loops) {
    const iso = new Date(r.startedAtMs).toISOString();
    process.stdout.write(
      `  ${iso}  run ${r.runId}  ${r.harness}/${r.authMode}  ${String(r.stages)} stages  ` +
        `${(r.durationMs / 1000).toFixed(1)}s  $${r.costUsd.toFixed(4)}  ` +
        `${String(r.inputTokens)}in/${String(r.outputTokens)}out\n`,
    );
  }
}
