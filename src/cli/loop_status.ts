/**
 * LSF.3 — `opensquid loop-status`: the THIN renderer over the `collectLoopState` read-model (LSF.1) + the
 * `loop_metrics` history (LSF.5). Renders whatever stage/phase STRINGS exist — NO built-in stage vocabulary
 * (pack-agnostic). It NEVER writes the loop stores (a read surface only); the sole write it performs is the
 * live-view linger marker (`filterLiveView`), which is state OF the view, not of the loop.
 *
 * Modes (subprocess-harness-push.md §2.3):
 *   --json         the raw LoopState contract (full truth; the exact shape the future UI reads).
 *   --status-line  exactly ONE line, --width-truncatable, NEVER throws, active few + "+N more", stable
 *                  non-empty idle line ("silence is a bug, not success").
 *   --watch        Monitor stream: one line per change, a terminal line on drain.
 *   --metrics      SQL-filterable read over loop_metrics: --since <ISO|ms> [--task <id>] [--harness <name>].
 *
 * Imports from: commander, ../runtime/loop/loop_state.js, ../runtime/loop/loop_metrics.js.
 * Imported by: src/cli.ts (registerLoopStatus).
 */
import type { Command } from 'commander';

import {
  collectLoopState,
  filterLiveView,
  DEFAULT_SURFACE,
  type LoopState,
  type LoopStateItem,
} from '../runtime/loop/loop_state.js';
import { readMetrics, aggregatePerLoop, type MetricsFilter } from '../runtime/loop/loop_metrics.js';

/** The stable, NON-EMPTY idle line — an empty board is a state, not silence. */
const IDLE_LINE = '🦑 loop idle — no items in flight';

/** Render ONE item: `wgId · stage[ · phase (idx/total)]`. */
export function renderItem(item: LoopStateItem): string {
  const parts = [item.wgId, item.stage];
  if (item.phase !== undefined) {
    const counter =
      item.phaseIndex !== undefined && item.phaseTotal !== undefined
        ? ` (${String(item.phaseIndex)}/${String(item.phaseTotal)})`
        : '';
    parts.push(`${item.phase}${counter}`);
  }
  return parts.join(' · ');
}

/**
 * The status-line render: one line, width-bounded, `+N more` overflow. As many items as fit within `width`
 * (leaving room for the overflow suffix), oldest-stalest last. Falls back to the idle line for an empty board.
 * PURE — the caller wraps it so a render bug can never throw on the status line.
 */
export function renderStatusLine(items: LoopState, width = 120): string {
  if (items.length === 0) return IDLE_LINE;
  const rendered = items.map(renderItem);
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

// Each live surface names itself so its linger marker is independent — the always-on status line and the
// Monitor --watch stream run concurrently (§3.1) and must NOT consume each other's one-shot terminal finish.
async function liveView(surface: string): Promise<LoopState> {
  return filterLiveView(await collectLoopState(), undefined, true, surface);
}

function parseSince(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const asNum = Number(since);
  if (Number.isFinite(asNum) && since.trim() !== '') return asNum; // ms epoch
  const asDate = Date.parse(since); // ISO
  return Number.isNaN(asDate) ? undefined : asDate;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    .option('--watch', 'stream one line per change for the Monitor tool (terminal line on drain)')
    .option('--width <n>', 'bound the --status-line render width (default 120)')
    .option('--metrics', 'read the loop_metrics history instead of the live state')
    .option('--since <iso|ms>', 'metrics: only rows at/after this time')
    .option('--task <id>', 'metrics: only this item id')
    .option('--harness <name>', 'metrics: only this harness')
    .option('--interval <ms>', '--watch poll interval (default 2000)')
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
            renderStatusLine(await liveView('status-line'), Number.isFinite(width) ? width : 120) +
              '\n',
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
        const view = await liveView(DEFAULT_SURFACE);
        process.stdout.write(
          view.length === 0 ? IDLE_LINE + '\n' : view.map(renderItem).join('\n') + '\n',
        );
      }
    });
}

/** --watch: poll, emit one line per CHANGE, emit a terminal drain line when the board empties, then return. */
async function runWatch(opts: LoopStatusOpts): Promise<void> {
  const interval = opts.interval !== undefined ? Number(opts.interval) : 2000;
  let last = '';
  for (;;) {
    let view: LoopState;
    try {
      view = await liveView('watch');
    } catch (e) {
      process.stdout.write(
        `⚠️ loop-status watch read error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      await sleep(Number.isFinite(interval) ? interval : 2000);
      continue;
    }
    const snapshot = view.map(renderItem).join('\n');
    if (snapshot !== last) {
      for (const item of view) process.stdout.write(renderItem(item) + '\n');
      last = snapshot;
    }
    if (view.length === 0) {
      // Silence is not success — announce the drain explicitly, then stop the stream.
      process.stdout.write('■ loop drained — no items in flight\n');
      return;
    }
    await sleep(Number.isFinite(interval) ? interval : 2000);
  }
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
