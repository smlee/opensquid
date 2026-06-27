/**
 * YOLO mode CLI — two surfaces, both following established CLI conventions:
 *   - `--yolo` / `--no-yolo` — a global, CHAINABLE boolean flag (the GNU/commander `--no-` negation pair, as
 *     in `git --no-pager`, `npm --no-save`). `--yolo` defaults to ON. Chainable: `opensquid --yolo <command>`
 *     applies the toggle before the command runs. (A space-separated `--yolo off` is deliberately NOT used —
 *     it can't be chained, since the parser can't tell the value from the next token.)
 *   - `opensquid yolo [on|off|status]` — the verb form (status is the default), the explicit on/off surface.
 *
 * YOLO moves the Safety floor's DANGEROUS tier from block → warn: dangerous-but-reversible actions (writing
 * substrate config like `active.json`, `chmod 777`, `curl | sh`) PROCEED with a surfaced warning + a recorded
 * drift, instead of being denied. The HARDLINE tier is untouched — `rm -rf /`, substrate DELETE, and `.env`
 * exfil stay blocked even with YOLO on.
 *
 * Both surfaces write/remove the persistent marker (`<home>/.opensquid/yolo`); env `OPENSQUID_YOLO=1` also
 * turns it on for a single session and takes precedence.
 */
import type { Command } from 'commander';

import { isYoloMode, setYoloMarker, yoloMarkerPath } from '../runtime/guard/yolo.js';

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
const ON_MSG = YOLO_ON_MSG;
const OFF_MSG = YOLO_OFF_MSG;

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
      'YOLO mode: DANGEROUS tier block→warn (hardline stays enforced). state: on | off | status (default: on, matching `--yolo`)',
    )
    .action(async (state?: string) => {
      // bare `opensquid yolo` turns it ON — consistent with the bare `--yolo` flag (was: status).
      const s = (state ?? 'on').toLowerCase();
      if (s === 'on') {
        await setYoloMarker(true);
        print(ON_MSG);
        return;
      }
      if (s === 'off') {
        await setYoloMarker(false);
        print(OFF_MSG);
        return;
      }
      if (s === 'status') {
        const on = await isYoloMode();
        print(
          `🦑 YOLO mode: ${on ? 'ON' : 'OFF'}` +
            (on ? ` (marker ${yoloMarkerPath()} or OPENSQUID_YOLO env)` : ''),
        );
        return;
      }
      throw new Error(`opensquid yolo: state must be on|off|status, got "${state ?? ''}"`);
    });
}
