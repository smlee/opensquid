/**
 * `opensquid yolo [on|off|status]` — toggle YOLO mode.
 *
 * YOLO moves the Safety floor's DANGEROUS tier from block → warn: dangerous-but-reversible actions (writing
 * substrate config like `active.json`, `chmod 777`, `curl | sh`) PROCEED with a surfaced warning + a recorded
 * drift, instead of being denied. The HARDLINE tier is untouched — `rm -rf /`, substrate DELETE, and `.env`
 * exfil stay blocked even with YOLO on.
 *
 * `on`/`off` write/remove the persistent marker (`<home>/.opensquid/yolo`); `status` (default) reports the
 * effective state (env `OPENSQUID_YOLO=1` also turns it on for a single session, and takes precedence).
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

export function registerYoloCli(program: Command, deps: YoloCliDeps = {}): Command {
  const print = emit(deps);
  return program
    .command('yolo [state]')
    .description(
      'Toggle YOLO mode: DANGEROUS tier block→warn (hardline stays enforced). state: on | off | status (default: status)',
    )
    .action(async (state?: string) => {
      const s = (state ?? 'status').toLowerCase();
      if (s === 'on') {
        await setYoloMarker(true);
        print(
          '🦑 YOLO mode ON — dangerous actions now WARN (proceed) instead of block. ' +
            'hardline still enforced (rm -rf, substrate delete, .env). Turn off: `opensquid yolo off`',
        );
        return;
      }
      if (s === 'off') {
        await setYoloMarker(false);
        print('🦑 YOLO mode OFF — full enforcement restored (dangerous tier blocks).');
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
