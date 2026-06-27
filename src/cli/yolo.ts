/**
 * YOLO mode CLI — surfaces over the two-level `yolo` config field (global default + per-project override):
 *   - `opensquid yolo [on|off|status] [--project]` — the verb. Writes GLOBAL config by default; `--project`
 *     targets this repo's `.opensquid/config.json` (a project override). Bare `yolo` = ON. `status` shows the
 *     resolved value + per-source breakdown.
 *   - `--yolo` / `--no-yolo` — a CHAINABLE flag (any position) that writes the GLOBAL setting; `--yolo on|off`
 *     and `--yolo=on|off` also accepted. Parsed pre-commander (consumeYoloFlags) so it never swallows a
 *     subcommand.
 *
 * YOLO moves the Safety floor's DANGEROUS tier from block → warn: dangerous-but-reversible actions (writing
 * substrate config like `active.json`, `chmod 777`, `curl | sh`) PROCEED with a surfaced warning + a recorded
 * drift, instead of being denied. The HARDLINE tier is untouched — `rm -rf /`, substrate DELETE, and `.env`
 * exfil stay blocked even with YOLO on.
 *
 * Resolution per project: env `OPENSQUID_YOLO` → project config → global config → OFF. A new project inherits
 * the global default; setting it `--project` lets that repo opt in/out independently.
 */
import type { Command } from 'commander';

import { setYolo, yoloStatus, type YoloScope } from '../runtime/guard/yolo.js';

export interface YoloCliDeps {
  /** Test seam — override stdout for assertion. */
  out?: (line: string) => void;
}

function emit(deps: YoloCliDeps): (line: string) => void {
  return deps.out ?? ((line) => process.stdout.write(line + '\n'));
}

export const YOLO_ON_MSG =
  '🦑 YOLO mode ON — dangerous actions now WARN (proceed) instead of block. ' +
  'hardline still enforced (rm -rf, substrate delete, .env). Turn off: `opensquid --no-yolo` (or `opensquid yolo off`)';
export const YOLO_OFF_MSG = '🦑 YOLO mode OFF — full enforcement restored (dangerous tier blocks).';

/** Format the ON/OFF confirmation, naming the scope + file written. */
function setMsg(on: boolean, scope: YoloScope, path: string): string {
  const base = on ? YOLO_ON_MSG : YOLO_OFF_MSG;
  return `${base}\n   scope: ${scope} (${path})`;
}

export interface YoloFlagScan {
  /** argv with all YOLO tokens removed — parses normally regardless of where the flag appeared. */
  rest: string[];
  /** ON (true) / OFF (false) requested by the flag, or null when no YOLO flag was present. */
  decision: boolean | null;
}

/**
 * PURE — scan argv for the chainable YOLO flag and strip its tokens, returning the remaining argv + the
 * requested state. Recognizes `--no-yolo` (off), `--yolo` (ON — the default), `--yolo on` / `--yolo off`
 * (explicit, like `--port 3000`), and `--yolo=on|off`. The space-separated value is consumed ONLY when it's
 * literally `on`/`off`, so a bare `--yolo` never swallows a following subcommand — this is what lets
 * default-ON, explicit on/off, AND position-independent chaining all coexist (`opensquid --yolo pack set …`,
 * `opensquid pack set … --yolo`, `opensquid --yolo on pack set …`). Last flag wins if repeated.
 */
export function consumeYoloFlags(argv: readonly string[]): YoloFlagScan {
  const rest: string[] = [];
  let decision: boolean | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--no-yolo') {
      decision = false;
      continue;
    }
    if (a === '--yolo') {
      const next = (argv[i + 1] ?? '').toLowerCase();
      if (next === 'on' || next === 'off') {
        decision = next === 'on';
        i++; // consume the explicit value token
      } else {
        decision = true; // bare --yolo defaults ON
      }
      continue;
    }
    if (a.startsWith('--yolo=')) {
      decision = a.slice('--yolo='.length).toLowerCase() !== 'off'; // --yolo= / --yolo=on → ON; =off → OFF
      continue;
    }
    rest.push(a);
  }
  return { rest, decision };
}

/**
 * Register the YOLO `yolo [on|off|status]` verb (status is the default). The chainable `--yolo`/`--no-yolo`
 * flag is handled by `consumeYoloFlags` in the CLI entry (pre-parse) so it works in any position; here we
 * only declare it for `--help` discoverability.
 */
export function registerYoloCli(program: Command, deps: YoloCliDeps = {}): Command {
  const print = emit(deps);

  // Help-only declaration (actual parsing is done pre-commander by consumeYoloFlags so it stays chainable).
  program.option(
    '--yolo [on|off]',
    'YOLO mode (chainable, any position): --yolo / --yolo on = ON, --yolo off / --no-yolo = OFF',
  );

  return program
    .command('yolo [state]')
    .description(
      'YOLO mode: DANGEROUS tier block→warn (hardline stays enforced). state: on | off | status (default: on). --project targets this repo',
    )
    .option(
      '--project',
      "write the PROJECT override (this repo's .opensquid/config.json) instead of global",
    )
    .action(async (state: string | undefined, opts: { project?: boolean }) => {
      const scope: YoloScope = opts.project === true ? 'project' : 'global';
      const s = (state ?? 'on').toLowerCase(); // bare `opensquid yolo` = ON (matches bare `--yolo`)
      if (s === 'on' || s === 'off') {
        const res = await setYolo(s === 'on', scope, process.cwd());
        print(setMsg(res.on, res.scope, res.path));
        return;
      }
      if (s === 'status') {
        const st = await yoloStatus(process.cwd());
        const fmt = (v: boolean | undefined): string =>
          v === undefined ? 'unset' : v ? 'ON' : 'OFF';
        print(
          `🦑 YOLO mode: ${st.on ? 'ON' : 'OFF'} (resolved)\n` +
            `   env: ${fmt(st.env)} · project: ${fmt(st.project)} · global: ${fmt(st.global)}\n` +
            `   precedence: env → project → global`,
        );
        return;
      }
      throw new Error(`opensquid yolo: state must be on|off|status, got "${state ?? ''}"`);
    });
}

/** Apply a chainable-flag decision (global scope) + return the confirmation line. Used by the CLI entry. */
export async function applyYoloFlagDecision(on: boolean): Promise<string> {
  const res = await setYolo(on, 'global');
  return setMsg(res.on, res.scope, res.path);
}
