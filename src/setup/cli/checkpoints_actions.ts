/**
 * Action handlers for `opensquid checkpoints` (CLI.6) — split out of
 * checkpoints.ts for the file-size budget.
 *
 * One handler per verb. Each owns:
 *   - libsql client lifecycle (open → store.init() → run → close)
 *   - confirmation (`--yes` + non-TTY refusal mirror schedule/webhooks)
 *   - exit-code semantics: 1 on missing run / missing manifest / bad
 *     duration / no Resumer wired; 0 otherwise.
 *
 * The `show` verb emits RAW JSONL (one JSON object per line, `_kind`
 * discriminator) — explicitly distinct from `opensquid trace` (OBSERVE.2)
 * which renders a styled timeline. Tee-able into `jq` without a
 * `--format json` flag.
 *
 * Imports from: ./checkpoints.js (pure handlers), ./checkpoints_render.js
 *   (table render + parseLimit), ./audit_state.js (parseDurationToMs).
 * Imported by: ./checkpoints.ts (commander wiring).
 */

import { CheckpointStore } from '../../runtime/durable/index.js';

import { parseDurationToMs } from './audit_state.js';
import { clean, list, resume, show } from './checkpoints_core.js';
import { parseLimit, renderListTable } from './checkpoints_render.js';

import type { Client } from '@libsql/client';
import type { Resumer } from '../../runtime/durable/index.js';

export interface ActionDeps {
  open: (dbPath: string) => Client;
  out: (s: string) => void;
  err: (s: string) => void;
  isTty: () => boolean;
  now: () => number;
  resumerFor?: (store: CheckpointStore) => Resumer | null;
}

const DEFAULT_LIMIT = 20;

async function confirmTty(question: string, isTty: () => boolean): Promise<boolean> {
  if (!isTty()) return false;
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function actList(
  deps: ActionDeps,
  opts: { db: string; limit?: string },
): Promise<void> {
  const client = deps.open(opts.db);
  try {
    const store = new CheckpointStore(client);
    await store.init();
    const rows = await list({ store, windowMs: null, nowMs: deps.now });
    const limit = parseLimit(opts.limit) ?? DEFAULT_LIMIT;
    const capped = rows.slice(0, limit);
    if (capped.length === 0) {
      deps.out('(no interrupted runs)\n');
      return;
    }
    deps.out(renderListTable(capped) + '\n');
  } finally {
    client.close();
  }
}

export async function actShow(
  deps: ActionDeps,
  runId: string,
  opts: { db: string },
): Promise<void> {
  const client = deps.open(opts.db);
  try {
    const store = new CheckpointStore(client);
    await store.init();
    const { manifest, checkpoints, hasTerminalMarker } = await show(store, runId);
    if (manifest === null && checkpoints.length === 0) {
      deps.err(`opensquid checkpoints show: no run found for id "${runId}"\n`);
      process.exitCode = 1;
      return;
    }
    if (manifest !== null) {
      deps.out(JSON.stringify({ _kind: 'manifest', ...manifest }) + '\n');
    }
    for (const row of checkpoints) {
      deps.out(JSON.stringify({ _kind: 'checkpoint', ...row }) + '\n');
    }
    if (hasTerminalMarker) {
      deps.out(JSON.stringify({ _kind: 'terminal', runId }) + '\n');
    }
  } finally {
    client.close();
  }
}

export async function actResume(
  deps: ActionDeps,
  runId: string,
  opts: { db: string; yes: boolean },
): Promise<void> {
  const client = deps.open(opts.db);
  try {
    const store = new CheckpointStore(client);
    await store.init();
    if (!opts.yes && !deps.isTty()) {
      deps.err(
        `opensquid checkpoints resume: refusing to resume "${runId}" without --yes in non-interactive context\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (!opts.yes && !(await confirmTty(`Resume run "${runId}"? [y/N] `, deps.isTty))) {
      deps.out('aborted\n');
      return;
    }
    if (deps.resumerFor === undefined) {
      deps.err(
        'opensquid checkpoints resume: manual resume requires a daemon-wired Resumer (deferred to the daemon track — see daemon start)\n',
      );
      process.exitCode = 1;
      return;
    }
    const resumer = deps.resumerFor(store);
    if (resumer === null) {
      deps.err('opensquid checkpoints resume: no Resumer available (pack registry not loaded)\n');
      process.exitCode = 1;
      return;
    }
    const result = await resume(resumer, store, runId);
    if (result.manifestMissing === true) {
      deps.err(`opensquid checkpoints resume: no manifest for runId "${runId}"\n`);
      process.exitCode = 1;
      return;
    }
    if (result.resumed) {
      deps.out(`resumed ${runId}\n`);
      return;
    }
    deps.out(`not resumed (${result.reason ?? 'unknown'})\n`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

export async function actClean(
  deps: ActionDeps,
  opts: { db: string; olderThan: string; yes: boolean },
): Promise<void> {
  const ms = parseDurationToMs(opts.olderThan);
  if (ms === null) {
    deps.err(
      `opensquid checkpoints clean: --older-than "${opts.olderThan}" must be like 30s|10m|2h|7d\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !deps.isTty()) {
    deps.err(
      `opensquid checkpoints clean: refusing to prune without --yes in non-interactive context\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (
    !opts.yes &&
    !(await confirmTty(`Prune checkpoints older than ${opts.olderThan}? [y/N] `, deps.isTty))
  ) {
    deps.out('aborted\n');
    return;
  }
  const client = deps.open(opts.db);
  try {
    const store = new CheckpointStore(client);
    await store.init();
    const { removed } = await clean({ store, olderThanMs: ms, nowMs: deps.now });
    deps.out(`removed ${String(removed)} checkpoint row${removed === 1 ? '' : 's'}\n`);
  } finally {
    client.close();
  }
}
