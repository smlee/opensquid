/**
 * Tests for the wedge per-file source layer — specifically `readWedgeRecords` causal-narrative key
 * normalization (T-fix-wedge-narrative-keys). The RES-3d-migrated Rust lessons carry snake_case
 * `evidence_refs`; the TS writer emits camelCase `evidenceRefs`. A blind cast left `evidenceRefs`
 * undefined and crashed the promotion gate on an `observed` lesson. readWedgeRecords must accept
 * both spellings and always yield a `string[]`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readWedgeRecords } from './source.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wedge-src-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(status: string, id: string, frontmatter: string[]): Promise<void> {
  await mkdir(join(dir, status), { recursive: true });
  await writeFile(
    join(dir, status, `${id}.md`),
    `---\n${frontmatter.join('\n')}\n---\nbody`,
    'utf8',
  );
}

const base = (id: string): string[] => [
  `id: ${id}`,
  `description: d-${id}`,
  'status: pending',
  'authored_by: agent',
  'created_at: 2026-06-09T00:00:00.000Z',
  'updated_at: 2026-06-09T00:00:00.000Z',
  'applied_count: 0',
  'thumbs_up_count: 0',
  'thumbs_down_count: 0',
  'external_signal_sources: []',
  'applied_session_ids: []',
];

describe('readWedgeRecords — causal-narrative key normalization', () => {
  it('normalizes snake_case evidence_refs → evidenceRefs (Rust-migrated form)', async () => {
    await seed('pending', 'les-snake', [
      ...base('les-snake'),
      'causal_narrative:',
      '  confidence: observed',
      '  evidence_refs:',
      '    - mem-1',
      '    - mem-2',
    ]);
    const [got] = await readWedgeRecords(dir);
    expect(got?.causalNarrative?.confidence).toBe('observed');
    expect(got?.causalNarrative?.evidenceRefs).toEqual(['mem-1', 'mem-2']);
  });

  it('preserves camelCase evidenceRefs (TS-written form)', async () => {
    await seed('pending', 'les-camel', [
      ...base('les-camel'),
      'causal_narrative:',
      '  confidence: observed',
      '  evidenceRefs:',
      '    - mem-9',
    ]);
    const [got] = await readWedgeRecords(dir);
    expect(got?.causalNarrative?.evidenceRefs).toEqual(['mem-9']);
  });

  it('defaults a missing/empty evidence list to []', async () => {
    await seed('pending', 'les-empty', [
      ...base('les-empty'),
      'causal_narrative:',
      '  confidence: observed',
    ]);
    const [got] = await readWedgeRecords(dir);
    expect(got?.causalNarrative?.evidenceRefs).toEqual([]);
  });

  it('preserves the richer Rust narrative fields (non-lossy) while fixing the key', async () => {
    // The on-disk migrated lessons carry trigger/failure_mode/correction beyond the typed 2 fields;
    // normalization must keep them so a read→write rebuild round-trip does not silently drop them.
    await seed('pending', 'les-rich', [
      ...base('les-rich'),
      'causal_narrative:',
      '  trigger: user-supplied',
      '  failure_mode: drift',
      '  correction: cite the source',
      '  confidence: inferred',
      '  evidence_refs:',
      '    - mem-7',
    ]);
    const [got] = await readWedgeRecords(dir);
    const cn = got?.causalNarrative as Record<string, unknown> | undefined;
    expect(cn?.evidenceRefs).toEqual(['mem-7']);
    expect(cn?.trigger).toBe('user-supplied');
    expect(cn?.failure_mode).toBe('drift');
    expect(cn?.correction).toBe('cite the source');
  });
});
