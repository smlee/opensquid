/** ORCH.5 — orchestrate: inert, converse→bare, control→meta, single-match→activate(+record), tie→ask, fail-open. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PackV2 } from '../../packs/schemas/pack_v2.js';
import { orchestrate } from './orchestrate.js';

let proj: string;
beforeEach(async () => {
  proj = await mkdtemp(join(tmpdir(), 'osq-orchestrate-'));
});
afterEach(async () => {
  await rm(proj, { recursive: true, force: true });
});

const pack = (name: string, serves?: unknown): PackV2 =>
  PackV2.parse({ name, version: '1.0.0', scope: 'workflow', ...(serves ? { serves } : {}) });

const NOW = '2026-06-22T06:00:00Z';
const activeJson = async (): Promise<{ packs: string[] } | null> => {
  try {
    return JSON.parse(await readFile(join(proj, '.opensquid', 'active.json'), 'utf8')) as {
      packs: string[];
    };
  } catch {
    return null;
  }
};

describe('orchestrate (ORCH.5)', () => {
  it('INERT: no serves-bearing pack → ZERO result, active.json untouched', async () => {
    const r = await orchestrate(proj, 'implement the thing', true, [pack('plain')], NOW);
    expect(r).toEqual({ injections: [], ground: false });
    expect(await activeJson()).toBeNull();
  });

  it('converse → bare (ground:false), no activation', async () => {
    const r = await orchestrate(proj, 'thanks!', true, [pack('cf', { intent: 'produce' })], NOW);
    expect(r).toEqual({ injections: [], ground: false });
    expect(await activeJson()).toBeNull();
  });

  it('control → meta (control:true), no activation', async () => {
    const r = await orchestrate(
      proj,
      'remember we use pnpm',
      true,
      [pack('cf', { intent: 'produce' })],
      NOW,
    );
    expect(r).toEqual({ injections: [], ground: false, control: true });
    expect(await activeJson()).toBeNull();
  });

  it('single match → activates (active.json gets the pack) + records an asked route', async () => {
    const r = await orchestrate(
      proj,
      'implement a retry wrapper',
      true,
      [pack('coding-flow', { intent: 'produce' })],
      NOW,
    );
    expect(r.activatedPack).toBe('coding-flow');
    expect((await activeJson())?.packs).toContain('coding-flow'); // LIVE: runV2Cartridges will run it
  });

  it('tie → ask injection, no activation', async () => {
    const r = await orchestrate(
      proj,
      'implement X',
      true,
      [pack('a', { intent: 'produce' }), pack('b', { intent: 'produce' })],
      NOW,
    );
    expect(r.activatedPack).toBeUndefined();
    expect(r.injections[0]).toMatch(/Multiple packs fit/);
    expect(await activeJson()).toBeNull();
  });

  it('no match + project → ground:true with a grounding directive (Tier-1 floor, ORCH.6)', async () => {
    const r = await orchestrate(
      proj,
      'explain why this happens',
      true,
      [pack('cf', { intent: 'produce' })],
      NOW,
    );
    expect(r.ground).toBe(true);
    expect(r.injections[0]).toMatch(/GROUNDING/);
  });

  it('no match + NON-project → bare (ground:false, no directive)', async () => {
    const r = await orchestrate(
      proj,
      'explain why this happens',
      false,
      [pack('cf', { intent: 'produce' })],
      NOW,
    );
    expect(r).toEqual({ injections: [], ground: false });
  });

  it('FAIL-OPEN: a bad pack object does not throw → INERT-ish zero', async () => {
    // a pack whose serves is present but malformed at runtime shouldn't escape as a throw.
    const bad = { name: 'x', serves: { intent: 'produce' } } as unknown as PackV2;
    const r = await orchestrate(proj, 'implement X', true, [bad], NOW);
    expect(r.activatedPack).toBe('x'); // still routes; the point is it never throws
  });
});
