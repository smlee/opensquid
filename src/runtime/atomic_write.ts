/**
 * Atomic file publish (FC.1) — write a temp sibling, then `rename` it over the
 * target. `rename` is atomic on POSIX, so a concurrent reader always sees either
 * the old file or the fully-written new one, never a torn/partial write. Closes
 * the ACTRACE race for every session-/chain-state writer.
 *
 * The temp name is unique PER CALL (pid + a process-local counter), not just per
 * pid — two overlapping writes in the SAME process must not share a temp path
 * (they would clobber each other's temp and one `rename` would ENOENT).
 *
 * Imports from: node:fs/promises, node:path.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

let counter = 0;

/** Write `data` to `path` atomically (tmp + rename), creating parent dirs. */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${String(process.pid)}.${String(++counter)}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}
