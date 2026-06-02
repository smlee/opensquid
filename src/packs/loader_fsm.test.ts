/**
 * T-PACK-FSM-STANDARDIZATION slice A2 — pack-declared `fsm.yaml` side-file.
 *
 * A pack may declare its lifecycle FSM in `fsm.yaml`; the loader validates it
 * (shape + TOTALITY) and folds it onto `Pack.fsm`. An invalid machine fails
 * LOUD at load — never a silently-ignored file.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from './loader.js';

const MANIFEST =
  ['name: fp', 'version: 0.1.0', 'scope: workflow', 'goal: fsm pack'].join('\n') + '\n';

async function packWith(fsmYaml: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fsm-pack-'));
  await writeFile(join(dir, 'manifest.yaml'), MANIFEST, 'utf8');
  if (fsmYaml !== null) await writeFile(join(dir, 'fsm.yaml'), fsmYaml, 'utf8');
  return dir;
}

describe('loadPack — fsm.yaml side-file', () => {
  it('folds a valid fsm.yaml onto Pack.fsm', async () => {
    const dir = await packWith(
      [
        'initial: idle',
        'states: [idle, working, done]',
        'transitions:',
        '  - { from: idle, on: start, to: working }',
        '  - { from: working, on: finish, to: done }',
        '  - { from: "*", on: abort, to: done }',
      ].join('\n') + '\n',
    );
    try {
      const pack = await loadPack(dir);
      expect(pack.fsm).toBeDefined();
      expect(pack.fsm!.initial).toBe('idle');
      expect(pack.fsm!.states).toEqual(['idle', 'working', 'done']);
      expect(pack.fsm!.transitions).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Pack.fsm is undefined when no fsm.yaml is present', async () => {
    const dir = await packWith(null);
    try {
      const pack = await loadPack(dir);
      expect(pack.fsm).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws LOUD when a transition targets an undeclared state (totality)', async () => {
    const dir = await packWith(
      [
        'initial: idle',
        'states: [idle, working]',
        'transitions:',
        '  - { from: idle, on: start, to: ghost }',
      ].join('\n') + '\n',
    );
    try {
      await expect(loadPack(dir)).rejects.toThrow(/invalid FSM.*ghost.*not a declared/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when initial is not a declared state', async () => {
    const dir = await packWith(
      ['initial: nowhere', 'states: [idle]', 'transitions: []'].join('\n') + '\n',
    );
    try {
      await expect(loadPack(dir)).rejects.toThrow(/invalid FSM.*initial state "nowhere"/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
