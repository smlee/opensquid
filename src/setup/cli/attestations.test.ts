import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendAttestation, readAttestedShas, type Attestation } from './attestations.js';

let scopeRoot: string;
beforeEach(async () => {
  scopeRoot = await mkdtemp(join(tmpdir(), 'opensquid-attest-'));
});
afterEach(async () => {
  await rm(scopeRoot, { recursive: true, force: true });
});

const att = (sha: string, allowed = true): Attestation => ({
  sha,
  allowed,
  reason: 'flow_complete',
  session: 's1',
  at: '2026-06-10T00:00:00.000Z',
});

describe('PGB.2 — attestations.jsonl', () => {
  it('round-trips: appended allowed shas are readable', async () => {
    await appendAttestation(scopeRoot, att('aaa'));
    await appendAttestation(scopeRoot, att('bbb'));
    const shas = await readAttestedShas(scopeRoot);
    expect(shas.has('aaa')).toBe(true);
    expect(shas.has('bbb')).toBe(true);
    expect(shas.size).toBe(2);
  });

  it('no file → empty set (pre-attestation clones unchanged)', async () => {
    expect((await readAttestedShas(scopeRoot)).size).toBe(0);
  });

  it('a torn/foreign line is skipped — that sha stays unattested (fail-closed)', async () => {
    await appendAttestation(scopeRoot, att('good'));
    const path = join(scopeRoot, 'attestations.jsonl');
    const raw = await readFile(path, 'utf8');
    await writeFile(path, `${raw}{"sha":"torn","allow`, 'utf8'); // torn mid-write
    const shas = await readAttestedShas(scopeRoot);
    expect(shas.has('good')).toBe(true);
    expect(shas.has('torn')).toBe(false);
  });

  it('allowed:false rows are never returned', async () => {
    await appendAttestation(scopeRoot, att('nope', false));
    expect((await readAttestedShas(scopeRoot)).has('nope')).toBe(false);
  });

  it('is append-only: a second append never rewrites prior rows', async () => {
    await appendAttestation(scopeRoot, att('aaa'));
    const before = await readFile(join(scopeRoot, 'attestations.jsonl'), 'utf8');
    await appendAttestation(scopeRoot, att('bbb'));
    const after = await readFile(join(scopeRoot, 'attestations.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
  });
});
