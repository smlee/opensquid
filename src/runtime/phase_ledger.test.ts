/**
 * Tests for the TS durable phase ledger (retire-Rust port of the engine's
 * `task.log_phase` YAML ledger). Covers write→read-back parity, the on-disk
 * format (field set + per-phase filename), and the no-throw edge cases.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';

import { phaseLedgerDir, readPhaseLedger, writePhaseLedger } from './phase_ledger.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-phase-ledger-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('phase_ledger', () => {
  it('writes <phase>.yaml and reads it back in the TaskGetLedgerResult shape', async () => {
    await writePhaseLedger('t1', 'code', 'did the thing', () => '2026-06-08T00:00:00.000Z');

    const ledger = await readPhaseLedger('t1');
    expect(ledger.task_id).toBe('t1');
    expect(ledger.phases_logged).toEqual(['code']);
    expect(ledger.entries).toEqual([
      { phase: 'code', logged_at: '2026-06-08T00:00:00.000Z', note: 'did the thing' },
    ]);
  });

  it('on-disk format parity: <task>/<phase>.yaml holds exactly phase/logged_at/note', async () => {
    await writePhaseLedger('t2', 'audit', 'note-x', () => '2026-06-08T01:00:00.000Z');

    const raw = await readFile(join(phaseLedgerDir('t2'), 'audit.yaml'), 'utf8');
    expect(yamlParse(raw)).toEqual({
      phase: 'audit',
      logged_at: '2026-06-08T01:00:00.000Z',
      note: 'note-x',
    });
  });

  it('omits note when none is given', async () => {
    await writePhaseLedger('t3', 'test', undefined, () => 'z');
    const ledger = await readPhaseLedger('t3');
    expect(ledger.entries[0]).toEqual({ phase: 'test', logged_at: 'z' });
    expect('note' in ledger.entries[0]!).toBe(false);
  });

  it('relogging a phase OVERWRITES (one entry, not two)', async () => {
    await writePhaseLedger('t4', 'fix', 'first', () => 'a');
    await writePhaseLedger('t4', 'fix', 'second', () => 'b');
    const ledger = await readPhaseLedger('t4');
    expect(ledger.phases_logged).toEqual(['fix']);
    expect(ledger.entries[0]).toMatchObject({ note: 'second', logged_at: 'b' });
  });

  it('absent task dir → empty ledger (no throw)', async () => {
    const ledger = await readPhaseLedger('never-written');
    expect(ledger).toEqual({ task_id: 'never-written', phases_logged: [], entries: [] });
  });

  it('skips a malformed <phase>.yaml instead of throwing', async () => {
    await writePhaseLedger('t5', 'code', 'ok', () => 'z');
    const dir = phaseLedgerDir('t5');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.yaml'), ': : not: valid: yaml: [', 'utf8');

    const ledger = await readPhaseLedger('t5');
    expect(ledger.phases_logged).toEqual(['code']); // the good one survives; broken skipped
  });
});
