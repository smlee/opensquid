/**
 * SLC.2 — the additive status-line SNAPSHOT writer. On each loop state change opensquid re-renders SLC.1's
 * fragment from the current live board and PUBLISHES it (atomically) to the project-local
 * `<root>/.opensquid/loop-statusline` file, so the user's `statusline-command.sh` reads a fresh, pre-rendered
 * string with a bare `cat` — no `node` spawn, no DB read in the hot path (~300ms render cadence, decision 1).
 *
 * SSOT: the `loop_events` DB is the sole authority; THIS file is a DERIVED PROJECTION — re-rendered on every
 * state change, atomically re-published, and NEVER read back by opensquid as truth (only the user's bash `cat`s
 * it). The file's mtime IS the freshness signal (filesystem-native); the reader's staleness guard (SLC.3) keys on
 * it, so no embedded timestamp is needed.
 *
 * §C.12 SCALABILITY: the board read is `collectLoopStateIncremental` (NOT the whole-log `collectLoopState`) — this
 * runs on the emit path, and re-folding the ever-growing append-only log per emit would be O(N²) over a project's
 * life. The incremental cursor bounds each refresh to the NEW events (design §6.3), so publishing stays O(1)
 * amortized on the mutation path.
 *
 * Imports from: ../../cli/loop_status.js (the PURE renderer — reuse, not re-impl), ./loop_state.js,
 *   ../paths.js, ../atomic_write.js, node:path.
 * Imported by: ./monitor_emit.ts (the ONE state-change choke-point, fail-open).
 */
import { renderStatuslineFragment } from '../../cli/loop_status.js';
import { collectLoopStateIncremental, liveItems, type LoopState } from './loop_state.js';
import { resolveLocalStoreDir } from '../paths.js';
import { atomicWriteFile } from '../atomic_write.js';
import { join } from 'node:path';

/** The snapshot file name under `<root>/.opensquid/`. */
export const STATUSLINE_SNAPSHOT_FILE = 'loop-statusline';

/** The additive-pill fragment width cap (decision 2 — one segment among the user's many, not the full line). */
const FRAGMENT_WIDTH = 40;

/**
 * Injected seams (defaulted to the real readers, mirroring `checkpoint_key.ts`'s `CheckpointKeyDeps`) so the
 * writer is unit-testable with a pure in-memory board + a temp dir — no `.opensquid` home I/O, no live DB.
 */
export interface StatuslineSnapshotDeps {
  collect: () => Promise<LoopState>;
  resolveDir: (cwd: string) => Promise<string>;
  write: (path: string, data: string) => Promise<void>;
}

const defaultDeps: StatuslineSnapshotDeps = {
  collect: collectLoopStateIncremental, // §C.12 — incremental fold on the emit path (never a whole-log re-scan)
  resolveDir: resolveLocalStoreDir,
  write: atomicWriteFile,
};

/**
 * Re-render the additive fragment from the live board and atomically publish it to the project-local file. A
 * terminal/empty board renders `''` (the pill blanks — the graceful-drain half of the staleness fix, decision 4).
 */
export async function writeStatuslineSnapshot(
  cwd: string = process.cwd(),
  now: number = Date.now(),
  deps: StatuslineSnapshotDeps = defaultDeps,
): Promise<void> {
  const items = liveItems(await deps.collect()); // terminal items dropped → an empty board publishes ''
  const fragment = renderStatuslineFragment(items, FRAGMENT_WIDTH, now);
  await deps.write(join(await deps.resolveDir(cwd), STATUSLINE_SNAPSHOT_FILE), fragment);
}

/**
 * The fail-open wrapper the emit choke-point calls — a render/write fault (incl. `resolveLocalStoreDir`'s
 * no-store throw outside a project) is swallowed to stderr and NEVER breaks the mutation (mirrors the emit's own
 * fail-open posture and `loop_stage.ts:132-140`).
 */
export async function refreshStatuslineSnapshot(): Promise<void> {
  try {
    await writeStatuslineSnapshot();
  } catch (err) {
    process.stderr.write(`[statusline] snapshot refresh failed (ignored): ${String(err)}\n`);
  }
}
