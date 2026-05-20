/**
 * OBSERVE.2 — `opensquid trace` CLI verb.
 *
 * Three subcommands, all backed by `TraceReader` (OBSERVE.1):
 *
 *   opensquid trace <runId>                        — render a timeline
 *   opensquid trace tail [--follow]                — live event stream
 *   opensquid trace export <runId> --format <fmt>  — json | md | otel to stdout
 *
 * Duration bar is 20-char by default; widens to `min(60, stdout.columns - 40)`
 * when the terminal is wider than 80 cols. Color via picocolors'
 * `createColors(enabled)` — enabled iff `stdout.isTTY` and `NO_COLOR` is unset.
 * `--follow` uses an AbortController + SIGINT handler that detaches itself so
 * the process exits with no leaked timer. JSON + OTEL export delegate to
 * `TraceReader.export`; MD renders inline (no duplicate logic for json/otel).
 *
 * Imports from: commander, picocolors, ../../runtime/observability/index.js.
 * Imported by: src/cli.ts (register subcommand).
 */

import { createClient } from '@libsql/client';
import pc from 'picocolors';

import { TraceReader } from '../../runtime/observability/index.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';

import type { Client } from '@libsql/client';
import type { Command } from 'commander';
import type { TraceEvent, TraceStatus, TraceTimeline } from '../../runtime/observability/index.js';

const DEFAULT_BAR_WIDTH = 20;
const MAX_BAR_WIDTH = 60;
/** Columns reserved for marks + step idx + fn-name + durationMs label. */
const NON_BAR_RESERVED = 40;

export interface RenderOpts {
  /** Forced bar width — tests pass a fixed value for deterministic snapshots. */
  barWidth?: number;
  /** Force enable/disable color regardless of TTY. */
  color?: boolean;
}

type Pc = ReturnType<typeof pc.createColors>;

function autoBarWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols !== 'number' || cols <= 0) return DEFAULT_BAR_WIDTH;
  if (cols <= 80) return DEFAULT_BAR_WIDTH;
  return Math.min(MAX_BAR_WIDTH, Math.max(DEFAULT_BAR_WIDTH, cols - NON_BAR_RESERVED));
}

function colorSupported(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '') return true;
  return process.stdout.isTTY === true;
}

/**
 * Pure renderer. Returns a multi-line string. Exported for snapshot tests so
 * every styling decision flows through the injected `opts` deterministically.
 */
export function renderTimeline(t: TraceTimeline, opts: RenderOpts = {}): string {
  const c = pc.createColors(opts.color ?? colorSupported());
  const barWidth = opts.barWidth ?? autoBarWidth();
  const lines: string[] = [];
  lines.push(c.bold(`${t.packId}/${t.skill}/${t.ruleId}`) + c.dim(`  run ${t.runId.slice(0, 8)}`));
  lines.push(
    c.dim(
      `  ${new Date(t.startedAtMs).toISOString()}  ${String(t.totalDurationMs)}ms  ${statusLabel(t.status, c)}`,
    ),
  );
  lines.push('');
  for (const e of t.events) {
    const bar = renderDurationBar(e.durationMs, t.totalDurationMs, barWidth, c);
    const mark = e.status === 'completed' ? c.green('✓') : c.red('✗');
    lines.push(
      `  ${mark} ${c.cyan(String(e.stepIdx).padStart(2))} ${e.fn.padEnd(20)} ${bar}  ${String(e.durationMs)}ms`,
    );
    if (e.asBinding !== undefined) lines.push(c.dim(`        as: ${e.asBinding}`));
    if (e.outputsPreview !== undefined) lines.push(c.dim(`        out: ${e.outputsPreview}`));
    if (e.errorMessage !== undefined) lines.push(c.red(`        err: ${e.errorMessage}`));
  }
  return lines.join('\n');
}

function renderDurationBar(stepMs: number, totalMs: number, width: number, c: Pc): string {
  const denom = Math.max(totalMs, 1);
  const filled = Math.max(1, Math.min(width, Math.round((stepMs / denom) * width)));
  return c.dim('[') + '█'.repeat(filled) + ' '.repeat(width - filled) + c.dim(']');
}

function statusLabel(s: TraceStatus, c: Pc): string {
  switch (s) {
    case 'completed':
      return c.green(s);
    case 'errored':
      return c.red(s);
    case 'in_flight':
      return c.yellow(s);
    case 'interrupted':
      return c.magenta(s);
  }
}

/** GFM-safe markdown export. No ANSI, no `█` glyph. Pasteable into a PR. */
export function renderMarkdown(t: TraceTimeline): string {
  const head = [
    `# Trace \`${t.runId}\``,
    '',
    `- **Pack**: \`${t.packId}\``,
    `- **Skill**: \`${t.skill}\``,
    `- **Rule**: \`${t.ruleId}\``,
    `- **Event kind**: \`${t.eventKind}\``,
    `- **Started**: ${new Date(t.startedAtMs).toISOString()}`,
    `- **Duration**: ${String(t.totalDurationMs)}ms`,
    `- **Status**: \`${t.status}\``,
    '',
    '| # | Function | Duration | Status | as |',
    '|---|----------|----------|--------|----|',
  ];
  const rows = t.events.map(
    (e) =>
      `| ${String(e.stepIdx)} | \`${e.fn}\` | ${String(e.durationMs)}ms | ${e.status} | ${e.asBinding ?? ''} |`,
  );
  const details: string[] = [];
  for (const e of t.events) {
    if (e.outputsPreview === undefined && e.errorMessage === undefined) continue;
    if (details.length === 0) details.push('', '## Details');
    details.push('', `### Step ${String(e.stepIdx)} — \`${e.fn}\``);
    if (e.outputsPreview !== undefined) details.push('', '```', `out: ${e.outputsPreview}`, '```');
    if (e.errorMessage !== undefined) details.push('', '```', `err: ${e.errorMessage}`, '```');
  }
  return [...head, ...rows, ...details].join('\n') + '\n';
}

/** Compact one-line representation for `tail --follow`. */
export function renderTailEvent(e: TraceEvent, opts: RenderOpts = {}): string {
  const c = pc.createColors(opts.color ?? colorSupported());
  const mark = e.status === 'completed' ? c.green('✓') : c.red('✗');
  return `${mark} ${c.dim(e.runId.slice(0, 8))} ${c.cyan(String(e.stepIdx).padStart(2))} ${e.fn.padEnd(20)} ${String(e.durationMs)}ms`;
}

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

export interface TraceCliDeps {
  /** Factory so tests can inject an in-memory client. */
  openClient?: (dbPath: string) => Client;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Override the abort controller (tests force-abort `--follow` deterministically). */
  abort?: AbortController;
}

function defaultDbPath(): string {
  return `file:${OPENSQUID_HOME()}/opensquid.db`;
}

function defaultOpen(dbPath: string): Client {
  const url = dbPath.startsWith('file:') || dbPath === ':memory:' ? dbPath : `file:${dbPath}`;
  return createClient({ url });
}

/**
 * Register `opensquid trace` on the parent program. Every IO boundary
 * (db open, stdout, stderr, abort signal) is overridable via `deps` so the
 * commander tree is the same code path in tests as in production.
 */
export function registerTraceCommand(program: Command, deps: TraceCliDeps = {}): Command {
  const open = deps.openClient ?? defaultOpen;
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const err = deps.stderr ?? ((s) => process.stderr.write(s));

  const trace = program.command('trace').description('Render durable-execution checkpoint traces.');

  trace
    .command('show', { isDefault: true })
    .description('Render a primitive-call timeline for one run.')
    .argument('<runId>', 'Run id (as recorded in the checkpoints table)')
    .option('--db <path>', 'Path to the libsql DB', defaultDbPath())
    .option('--no-color', 'Disable ANSI color output')
    .action(async (runId: string, opts: { db: string; color: boolean }) => {
      const client = open(opts.db);
      try {
        const reader = new TraceReader(client);
        const timeline = await reader.getTimeline(runId);
        if (timeline === null) {
          err(`opensquid trace: no run found for id "${runId}"\n`);
          process.exitCode = 1;
          return;
        }
        out(renderTimeline(timeline, opts.color ? {} : { color: false }) + '\n');
      } finally {
        client.close();
      }
    });

  trace
    .command('tail')
    .description('Stream new primitive-call events as they complete.')
    .option('--db <path>', 'Path to the libsql DB', defaultDbPath())
    .option('--follow', 'Keep tailing until SIGINT', false)
    .option('--pack <packId>', 'Filter to one pack')
    .option('--interval <ms>', 'Polling interval (default 1000ms, floor 100ms)', '1000')
    .option('--no-color', 'Disable ANSI color output')
    .action(
      async (opts: {
        db: string;
        follow: boolean;
        pack?: string;
        interval: string;
        color: boolean;
      }) => {
        const client = open(opts.db);
        const controller = deps.abort ?? new AbortController();
        const onSigint = (): void => {
          controller.abort();
        };
        process.on('SIGINT', onSigint);
        try {
          const reader = new TraceReader(client);
          const tailOpts: {
            sinceMs: number;
            intervalMs: number;
            signal: AbortSignal;
            packId?: string;
          } = {
            sinceMs: Date.now(),
            intervalMs: Number(opts.interval),
            signal: controller.signal,
          };
          if (opts.pack !== undefined) tailOpts.packId = opts.pack;
          const stream = await reader.tail(tailOpts);
          const renderOpts: RenderOpts = opts.color ? {} : { color: false };
          for await (const ev of stream) {
            out(renderTailEvent(ev, renderOpts) + '\n');
            if (!opts.follow) {
              controller.abort();
              break;
            }
          }
        } finally {
          process.off('SIGINT', onSigint);
          client.close();
        }
      },
    );

  trace
    .command('export')
    .description('Export a run as json | md | otel to stdout.')
    .argument('<runId>', 'Run id (as recorded in the checkpoints table)')
    .requiredOption('--format <fmt>', 'Output format: json | md | otel')
    .option('--db <path>', 'Path to the libsql DB', defaultDbPath())
    .action(async (runId: string, opts: { format: string; db: string }) => {
      const fmt = opts.format;
      if (fmt !== 'json' && fmt !== 'md' && fmt !== 'otel') {
        err(`opensquid trace export: unknown --format "${fmt}" (expected json|md|otel)\n`);
        process.exitCode = 1;
        return;
      }
      const client = open(opts.db);
      try {
        const reader = new TraceReader(client);
        if (fmt === 'md') {
          const timeline = await reader.getTimeline(runId);
          if (timeline === null) {
            err(`opensquid trace export: no run found for id "${runId}"\n`);
            process.exitCode = 1;
            return;
          }
          out(renderMarkdown(timeline));
          return;
        }
        const exported = await reader.export(runId, fmt);
        if (exported === '') {
          err(`opensquid trace export: no run found for id "${runId}"\n`);
          process.exitCode = 1;
          return;
        }
        out(exported + '\n');
      } finally {
        client.close();
      }
    });

  return trace;
}
