/** T-session-end-indication (wg-a9af600828fe) — the pure session-end indication builder. */
import { describe, expect, it } from 'vitest';

import { buildSessionEndIndication } from './session-end.js';

describe('buildSessionEndIndication', () => {
  it('active task → names the 8-char id slug + the subject', () => {
    expect(buildSessionEndIndication('2de11a07-1de0-42f8', { subject: 'BW.1 — worksheet' })).toBe(
      '[opensquid] session 2de11a07 ended — task "BW.1 — worksheet"',
    );
  });

  it('no active task → names the id + "no active task"', () => {
    expect(buildSessionEndIndication('abcd1234-xyz', null)).toBe(
      '[opensquid] session abcd1234 ended — no active task',
    );
  });

  it('always includes the session id (the disambiguator the user asked for)', () => {
    expect(buildSessionEndIndication('feedbeef-0000', null)).toContain('feedbeef');
    expect(buildSessionEndIndication('feedbeef-0000', { subject: 'x' })).toContain('feedbeef');
  });
});
