/**
 * G.7 incremental auto-memory snapshot — periodic catch-up importer.
 *
 * Re-runs G.6's `importAutoMemoryDir` on auto-memory files modified since the
 * last snapshot timestamp recorded at `<opensquidHome>/.last-auto-memory-snapshot`
 * (an ASCII Number.toString() of `Date.now()` ms-precision).
 *
 * First-run semantics: snapshot file absent / unreadable / non-numeric → treat
 * `lastSnapshot = 0` so every `.md` file (minus `MEMORY.md`) is considered
 * "new" and gets the full G.6 import path. Per-file dedup via G.6's
 * `existingNames` set still prevents re-importing names already in the engine.
 *
 * Atomicity note: the snapshot timestamp is written AFTER `importAutoMemoryDir`
 * returns, even when `result.errors.length > 0`. Rationale: per-file errors are
 * usually parse failures on malformed files (the same files would fail on the
 * next run too). Loop-avoidance > replay-on-transient-fail for this verb. If
 * the importer THROWS (engine-down, fs error mid-readdir), we never reach the
 * write — so the next run still picks up the same window.
 *
 * Strict-greater comparison (`mtimeMs > lastSnapshot`) avoids re-importing a
 * file modified at exactly the snapshot timestamp. The ms resolution of
 * `Date.now()` makes simultaneous-modification edge cases statistically rare,
 * but the strict inequality is the principled choice.
 *
 * Imports from: node:fs, node:path, ../../engine/client.js,
 *   ./auto_memory_importer.js.
 * Imported by: src/setup/cli/memory.ts, auto_memory_snapshot.test.ts.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { EngineClient } from '../../engine/client.js';

import {
  fetchExistingImportIndex,
  importAutoMemoryDir,
  type ImportResult,
} from './auto_memory_importer.js';

export const SNAPSHOT_FILE = '.last-auto-memory-snapshot';

async function readSnapshotTimestamp(snapshotPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(snapshotPath, 'utf-8');
    const n = Number(raw.trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function snapshotAuto(
  autoMemoryDir: string,
  opensquidHome: string,
  engine: EngineClient,
): Promise<ImportResult> {
  const snapshotPath = join(opensquidHome, SNAPSHOT_FILE);
  const lastSnapshot = await readSnapshotTimestamp(snapshotPath);
  const allFiles = (await fs.readdir(autoMemoryDir)).filter(
    (f) => f.endsWith('.md') && f !== 'MEMORY.md',
  );
  const recent: string[] = [];
  for (const f of allFiles) {
    const stat = await fs.stat(join(autoMemoryDir, f));
    if (stat.mtimeMs > lastSnapshot) recent.push(f);
  }
  const existingIndex = await fetchExistingImportIndex(engine);
  const result = await importAutoMemoryDir(autoMemoryDir, engine, {
    dryRun: false,
    existingIndex,
    fileWhitelist: recent,
  });
  // Ensure opensquidHome exists before writing the timestamp file.
  await fs.mkdir(opensquidHome, { recursive: true });
  await fs.writeFile(snapshotPath, Date.now().toString(), 'utf-8');
  return result;
}
