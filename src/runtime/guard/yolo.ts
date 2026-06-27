/**
 * YOLO mode — the explicit, user-set toggle that moves the Safety floor's `dangerous` tier from block → warn
 * (the call PROCEEDS but is surfaced + recorded as a drift). It NEVER affects the `hardline` tier: `rm -rf`,
 * substrate DELETE, and `.env` exfil always `halt`, regardless of this toggle (enforced in `checkSafety`,
 * not here).
 *
 * Two carriers, ENV WINS:
 *   - env `OPENSQUID_YOLO` truthy (`1`/`true`/`on`/`yes`) — session-scoped, auto-expires with the shell.
 *   - marker file `<home>/.opensquid/yolo` — persistent; written by `opensquid yolo on`, removed by `off`.
 *
 * Why both: the pre-tool-use hook runs as a SEPARATE subprocess that only inherits ENV, so a transient flag
 * on the agent's own CLI invocation can't reach it. The env var covers one-shot/session use; the marker
 * covers a deliberate persistent opt-in via the `opensquid yolo` verb.
 *
 * FAIL-SAFE: any read error ⇒ OFF (full enforcement). Yolo is never silently assumed on.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/** The persistent marker path (`<home>/.opensquid/yolo`). */
export function yoloMarkerPath(): string {
  return join(OPENSQUID_HOME(), 'yolo');
}

function envYoloOn(): boolean {
  const v = process.env.OPENSQUID_YOLO;
  return typeof v === 'string' && TRUTHY.has(v.trim().toLowerCase());
}

/**
 * Is YOLO mode ON? `OPENSQUID_YOLO` env wins; otherwise the marker file (presence = on, unless its content is
 * an explicit falsy token). Absent/unreadable ⇒ OFF (fail-safe to full enforcement).
 */
export async function isYoloMode(): Promise<boolean> {
  if (envYoloOn()) return true;
  try {
    const raw = (await readFile(yoloMarkerPath(), 'utf8')).trim().toLowerCase();
    return raw === '' || TRUTHY.has(raw); // an empty marker still means ON (its presence is the signal)
  } catch {
    return false; // absent / unreadable ⇒ OFF
  }
}

/** Persist (on) or remove (off) the YOLO marker. Run by the USER's CLI — not an agent tool call. */
export async function setYoloMarker(on: boolean): Promise<void> {
  const path = yoloMarkerPath();
  if (on) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'on\n', 'utf8');
  } else {
    await rm(path, { force: true });
  }
}
