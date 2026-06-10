/**
 * AHO.2 — narrateHandoff: success / failure / empty all bounded (never
 * throws, never load-bearing). Strategy injected — no real spawns.
 */

import { describe, expect, it } from 'vitest';

import { narrateHandoff } from './narrate.js';

describe('narrateHandoff', () => {
  it('returns the trimmed text on success', async () => {
    expect(await narrateHandoff('dump', { strategyCall: () => Promise.resolve(' story ') })).toBe(
      'story',
    );
  });
  it('returns null on a throwing strategy (never propagates)', async () => {
    expect(
      await narrateHandoff('dump', { strategyCall: () => Promise.reject(new Error('boom')) }),
    ).toBeNull();
  });
  it('returns null on empty output', async () => {
    expect(await narrateHandoff('dump', { strategyCall: () => Promise.resolve('  ') })).toBeNull();
  });
  it('feeds the dump below the prompt header', async () => {
    let seen = '';
    await narrateHandoff('THE-DUMP', {
      strategyCall: (p) => {
        seen = p;
        return Promise.resolve('ok');
      },
    });
    expect(seen).toContain('NARRATIVE layer');
    expect(seen.endsWith('THE-DUMP')).toBe(true);
  });
});
