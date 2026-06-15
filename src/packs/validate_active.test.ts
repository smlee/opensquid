/**
 * Tests for `validateActivePacks` (T-wire-pack-validators PV.1).
 *
 * Packs are injected via the real `setActivePacks` seam (NOT a module mock — bootstrap participates
 * in an import cycle that defeats vi.mock of its exports). `buildValidationRegistry` runs for real, so
 * the validator checks against the authentic runtime name set. `validate_functions.js` is a leaf
 * module (types only), so its export IS mockable — used only for the fail-open test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setActivePacks } from '../runtime/bootstrap.js';

import { validatePackFunctions } from './validate_functions.js';
import { validateActivePacks } from './validate_active.js';

// Auto-spy: keep the REAL implementations, but make each export mockable (for the fail-open test).
vi.mock('./validate_functions.js', { spy: true });

import type { Pack } from '../runtime/types.js';

/** Minimal Pack fixture — only the fields the validators read. */
const pack = (name: string, skillName: string, calls: string[]): Pack =>
  ({
    name,
    skills: [
      {
        name: skillName,
        rules: [{ kind: 'track_check', id: 'r1', process: calls.map((c) => ({ call: c })) }],
      },
    ],
  }) as unknown as Pack;

afterEach(() => {
  setActivePacks([]);
  vi.mocked(validatePackFunctions).mockClear();
});

describe('validateActivePacks (PV.1)', () => {
  it('flags an unknown call: with a Levenshtein suggestion', async () => {
    setActivePacks([pack('p', 's', ['match_commnd'])]);
    const problems = await validateActivePacks('sid');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('match_commnd');
    expect(problems[0]).toContain('match_command'); // the suggestion
  });

  it('a clean pack (real primitive) yields no problems', async () => {
    setActivePacks([pack('p', 's', ['verdict'])]);
    expect(await validateActivePacks('sid')).toEqual([]);
  });

  it('a cross-pack skill-name collision surfaces a uniqueness problem', async () => {
    setActivePacks([pack('a', 'dup', ['verdict']), pack('b', 'dup', ['verdict'])]);
    const problems = await validateActivePacks('sid');
    expect(problems.some((p) => p.includes('"dup"') && p.includes('multiple packs'))).toBe(true);
  });

  it('FAIL-OPEN: an internal validator error → [] (never breaks the session)', async () => {
    setActivePacks([pack('p', 's', ['verdict'])]);
    vi.mocked(validatePackFunctions).mockImplementationOnce(() => {
      throw new Error('validator bug');
    });
    expect(await validateActivePacks('sid')).toEqual([]);
  });
});
