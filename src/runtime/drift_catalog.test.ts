/**
 * Tests for `readAllDriftCatalogs` (Task 5.4).
 *
 * Acceptance per phase-5-layered-packs.md:
 *  - Returns merged + sorted events
 *  - Provenance preserved (`pack` field)
 *  - No mutation of source catalogs
 *  - ≥ 2 tests
 *
 * Strategy: per-test `OPENSQUID_HOME` temp dir, write fixture JSONL files
 * directly with `appendFile`, then aggregate + assert ordering + provenance.
 */

import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAllDriftCatalogs } from './drift_catalog.js';
import { packLogFile, sessionLogFile } from './paths.js';

let tempHome: string;
let priorHome: string | undefined;

// `beforeEach` is sync: it only sets env-vars + temp path. The afterEach is
// async because filesystem cleanup awaits `rm`.
beforeEach(() => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = join(tmpdir(), `opensquid-drift-${Math.random().toString(36).slice(2, 10)}`);
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

async function writeJsonlLine(path: string, obj: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(obj)}\n`, 'utf8');
}

describe('readAllDriftCatalogs', () => {
  it('aggregates events across packs + session and sorts chronologically with provenance', async () => {
    const sessionId = 'sess-1';
    const packA = 'pack-a';
    const packB = 'pack-b';

    // Interleaved timestamps so sort order != insertion order.
    await writeJsonlLine(packLogFile(packA, 'drift-catalog'), {
      timestamp: '2026-05-19T10:00:00Z',
      ruleId: 'r1',
      level: 'block',
      message: 'from a',
    });
    await writeJsonlLine(packLogFile(packB, 'drift-catalog'), {
      timestamp: '2026-05-19T09:00:00Z',
      ruleId: 'r2',
      level: 'warn',
      message: 'from b',
    });
    await writeJsonlLine(sessionLogFile(sessionId, 'drift-catalog'), {
      timestamp: '2026-05-19T11:00:00Z',
      ruleId: 'r3',
      level: 'surface',
      message: 'from session',
    });

    const events = await readAllDriftCatalogs([packA, packB], sessionId);

    expect(events).toHaveLength(3);
    // Chronological order: b@09 → a@10 → session@11.
    expect(events.map((e) => `${e.pack}|${e.timestamp}`)).toEqual([
      'pack-b|2026-05-19T09:00:00Z',
      'pack-a|2026-05-19T10:00:00Z',
      '<session>|2026-05-19T11:00:00Z',
    ]);
    // Each event carries the full shape.
    expect(events[0]).toEqual({
      timestamp: '2026-05-19T09:00:00Z',
      pack: 'pack-b',
      ruleId: 'r2',
      level: 'warn',
      message: 'from b',
    });
  });

  it('returns an empty list when every catalog file is missing (ENOENT silent)', async () => {
    const events = await readAllDriftCatalogs(['pack-x', 'pack-y'], 'sess-empty');
    expect(events).toEqual([]);
  });

  it('overwrites provenance from file location even if JSONL claims a different pack id', async () => {
    // The catalog at pack-a's path claims `pack: 'lying-pack'` but provenance
    // MUST reflect the file location, not the file content.
    await writeJsonlLine(packLogFile('pack-a', 'drift-catalog'), {
      timestamp: '2026-05-19T12:00:00Z',
      pack: 'lying-pack',
      ruleId: 'r1',
      level: 'block',
      message: 'spoof attempt',
    });

    const events = await readAllDriftCatalogs(['pack-a'], 'sess-1');

    expect(events).toHaveLength(1);
    expect(events[0]?.pack).toBe('pack-a');
  });

  it('does not mutate source catalog files on disk (no writes during read)', async () => {
    const packA = 'pack-a';
    const path = packLogFile(packA, 'drift-catalog');
    await writeJsonlLine(path, {
      timestamp: '2026-05-19T10:00:00Z',
      ruleId: 'r1',
      level: 'block',
      message: 'fixture',
    });
    const before = await stat(path);

    await readAllDriftCatalogs([packA], 'sess-1');

    const after = await stat(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('handles a mix of present + missing catalogs without throwing', async () => {
    const sessionId = 'sess-1';
    await writeJsonlLine(packLogFile('pack-present', 'drift-catalog'), {
      timestamp: '2026-05-19T08:00:00Z',
      ruleId: 'r-present',
      level: 'warn',
      message: 'present',
    });
    // No file for pack-missing — should be silently skipped.

    const events = await readAllDriftCatalogs(['pack-present', 'pack-missing'], sessionId);

    expect(events).toHaveLength(1);
    expect(events[0]?.pack).toBe('pack-present');
  });
});
