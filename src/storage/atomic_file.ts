/**
 * Shared atomic single-file write (T-WORKGRAPH-EVENTSOURCED slice 1d). Extracted so both the
 * per-file lessons source (src/rag/backends/perfile_source.ts) and the work-graph op-log
 * (src/workgraph) share ONE atomic-write primitive instead of duplicating temp+rename.
 *
 * `atomicWriteFile` writes a `.tmp` then `rename()`s it into place — atomic on POSIX, so a reader
 * never sees a partial/corrupt file and a crash mid-write leaves the previous file intact.
 * `safeRecordId` rejects ids that could escape the target dir (record ids are content hashes,
 * never paths).
 *
 * Imports from: node:fs/promises, node:path.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function safeRecordId(id: string): string {
  if (id.length === 0 || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`atomic_file: unsafe record id: ${JSON.stringify(id)}`);
  }
  return id;
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path); // atomic on POSIX → readers never see a partial file
}
