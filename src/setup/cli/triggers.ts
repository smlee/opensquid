/**
 * CLI.1 — `opensquid triggers list|show|fire|enable|disable`.
 *
 * Commander wiring + table rendering. Pack enumeration + state-file IO
 * live in `triggers_state.ts`; synthetic-event construction lives in
 * `triggers_synth.ts` (both split for file-size budget). Trigger id
 * format (locked): `<pack>:<skill>:<kind>:<index>`. `fire` requires
 * `--yes` in non-TTY contexts; TTY shows an interactive `[y/N]` prompt.
 *
 * Imports from: commander, picocolors, node:readline/promises,
 *   ./triggers_state.js, ./triggers_synth.js.
 * Imported by: src/cli.ts.
 */

import pc from 'picocolors';

import {
  buildRows,
  defaultStatePath,
  readDisabledSet,
  resolveTrigger,
  writeDisabledSet,
  type TriggerRow,
} from './triggers_state.js';
import { synthFireEvent } from './triggers_synth.js';

import type { Command } from 'commander';
import type { Event } from '../../runtime/types.js';

export type { TriggerRow } from './triggers_state.js';
export type TriggerDispatch = (event: Event) => Promise<void> | void;

export interface TriggersCliDeps {
  packsDir?: string;
  statePath?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTty?: () => boolean;
  dispatch?: TriggerDispatch;
  now?: () => Date;
}

const defaultIsTty = (): boolean => process.stdout.isTTY === true;

// Kubectl-style left-aligned columns, padded to widest cell.
const COLS = ['ID', 'KIND', 'PACK', 'SKILL', 'FILTER', 'STATUS'] as const;

export function renderTable(rows: readonly TriggerRow[], opts: { color?: boolean } = {}): string {
  const c = pc.createColors(opts.color ?? defaultIsTty());
  const cells = rows.map((r) => [
    r.id,
    r.kind,
    r.pack,
    r.skill,
    r.filter,
    r.enabled ? 'enabled' : 'disabled',
  ]);
  const widths = COLS.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)),
  );
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));
  const lines = [COLS.map((h, i) => c.bold(pad(h, widths[i] ?? 0))).join('  ')];
  cells.forEach((row, rIdx) => {
    const enabled = rows[rIdx]?.enabled === true;
    lines.push(
      row
        .map((cell, i) => {
          const padded = pad(cell, widths[i] ?? 0);
          if (i === COLS.length - 1) return enabled ? c.green(padded) : c.dim(padded);
          return enabled ? padded : c.dim(padded);
        })
        .join('  '),
    );
  });
  return lines.join('\n');
}

export function registerTriggers(parent: Command, deps: TriggersCliDeps = {}): Command {
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const err = deps.stderr ?? ((s) => process.stderr.write(s));
  const isTty = deps.isTty ?? defaultIsTty;
  const stateOpts = {
    ...(deps.packsDir !== undefined && { packsDir: deps.packsDir }),
    ...(deps.statePath !== undefined && { statePath: deps.statePath }),
  };

  const t = parent.command('triggers').description('Unified view of all trigger sources');

  t.command('list')
    .description('List all configured triggers across packs')
    .option('--kind <kind>', 'filter by kind (schedule|webhook|file_changed|inbound_channel)')
    .option('--pack <pack>', 'filter by pack')
    .action(async (opts: { kind?: string; pack?: string }) => {
      const rows = (await buildRows(stateOpts)).filter(
        (r) =>
          (opts.kind === undefined || r.kind === opts.kind) &&
          (opts.pack === undefined || r.pack === opts.pack),
      );
      if (rows.length === 0) {
        out('(no triggers found)\n');
        return;
      }
      out(renderTable(rows, { color: isTty() }) + '\n');
    });

  t.command('show <triggerId>')
    .description('Show full detail for one trigger')
    .action(async (id: string) => {
      const resolved = await resolveTrigger(id, stateOpts);
      if (!resolved) {
        err(`opensquid triggers show: no trigger with id "${id}"\n`);
        process.exitCode = 1;
        return;
      }
      out(JSON.stringify({ ...resolved.row, raw: resolved.trigger }, null, 2) + '\n');
    });

  t.command('fire <triggerId>')
    .option('--yes', 'skip confirmation (required in non-TTY contexts)', false)
    .description('Manually fire a trigger for testing')
    .action(async (id: string, opts: { yes: boolean }) => {
      const resolved = await resolveTrigger(id, stateOpts);
      if (!resolved) {
        err(`opensquid triggers fire: no trigger with id "${id}"\n`);
        process.exitCode = 1;
        return;
      }
      if (!opts.yes && !isTty()) {
        err(
          `opensquid triggers fire: refusing to dispatch "${id}" without --yes in non-interactive context\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (!opts.yes && isTty()) {
        const rl = (await import('node:readline/promises')).createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const answer = (await rl.question(`Fire trigger "${id}"? [y/N] `)).trim().toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            out('aborted\n');
            return;
          }
        } finally {
          rl.close();
        }
      }
      const dispatch = deps.dispatch;
      if (!dispatch) {
        err(`opensquid triggers fire: no dispatcher wired (daemon not running)\n`);
        process.exitCode = 1;
        return;
      }
      await dispatch(
        synthFireEvent(resolved.row, resolved.trigger, (deps.now ?? (() => new Date()))()),
      );
      out(`fired ${id}\n`);
    });

  for (const verb of ['enable', 'disable'] as const) {
    t.command(`${verb} <triggerId>`)
      .description(
        `${verb === 'enable' ? 'Enable' : 'Disable'} a trigger (atomic write to trigger_state.yaml)`,
      )
      .action(async (id: string) => {
        const resolved = await resolveTrigger(id, stateOpts);
        if (!resolved) {
          err(`opensquid triggers ${verb}: no trigger with id "${id}"\n`);
          process.exitCode = 1;
          return;
        }
        const statePath = deps.statePath ?? defaultStatePath();
        const disabled = await readDisabledSet(statePath);
        if (verb === 'enable') disabled.delete(id);
        else disabled.add(id);
        await writeDisabledSet(statePath, disabled);
        out(`${verb}d ${id}\n`);
      });
  }

  return t;
}
