/**
 * GR.2 — the typed-exit contract. outcomeFromEnvelope (MHL.3) is a TOTAL mapping of a neutral LapEnvelope
 * (never throws, never a false SHIPPED); extractTypedExit defensively scans the RALPH-EXIT tag. The Claude
 * envelope-reading half now lives in claude_lap_harness.ts (see claude_lap_harness.test.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  extractTypedExit,
  outcomeFromEnvelope,
  tagIsPresent,
  type LapOutcome,
} from './lap_outcome.js';
import type { LapEnvelope } from './lap_harness.js';

const env = (over: Partial<LapEnvelope> = {}): LapEnvelope => ({
  resultText: '',
  costUsd: 0.04,
  inputTokens: 0,
  outputTokens: 0,
  isError: false,
  ...over,
});

describe('extractTypedExit', () => {
  it('parses a HUMAN_REQUIRED tag with reason + payload', () => {
    const text =
      'work...\nRALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"SCOPE_FORK","payload":{"q":1}}';
    expect(extractTypedExit(text)).toEqual({
      kind: 'HUMAN_REQUIRED',
      reason: 'SCOPE_FORK',
      payload: { q: 1 },
    });
  });

  it('parses bare kinds (SHIPPED/WEDGE/TIMEOUT/CRASH)', () => {
    expect(extractTypedExit('RALPH-EXIT: {"kind":"WEDGE"}')).toEqual({ kind: 'WEDGE' });
    expect(extractTypedExit('RALPH-EXIT: {"kind":"SHIPPED"}')).toEqual({ kind: 'SHIPPED' });
  });

  it('PSL.3: a SHIPPED tag carries the optional resulting `stage` when a per-stage lap reports it', () => {
    expect(extractTypedExit('RALPH-EXIT: {"kind":"SHIPPED","stage":"plan"}')).toEqual({
      kind: 'SHIPPED',
      stage: 'plan',
    });
    // backward compat: a bare SHIPPED (per-item lap) has no stage key
    expect(extractTypedExit('RALPH-EXIT: {"kind":"SHIPPED"}')).toEqual({ kind: 'SHIPPED' });
    // a non-string stage is ignored (defensive) → bare SHIPPED
    expect(extractTypedExit('RALPH-EXIT: {"kind":"SHIPPED","stage":42}')).toEqual({
      kind: 'SHIPPED',
    });
  });

  it('returns null when there is no tag', () => {
    expect(extractTypedExit('just some normal output, all done')).toBeNull();
  });

  it('HUMAN_REQUIRED without a valid reason is malformed → null', () => {
    expect(
      extractTypedExit('RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"NONSENSE"}'),
    ).toBeNull();
    expect(extractTypedExit('RALPH-EXIT: {"kind":"HUMAN_REQUIRED"}')).toBeNull();
  });

  it('the LAST tag wins when several appear', () => {
    const text = 'RALPH-EXIT: {"kind":"WEDGE"}\n...changed mind...\nRALPH-EXIT: {"kind":"SHIPPED"}';
    expect(extractTypedExit(text)).toEqual({ kind: 'SHIPPED' });
  });

  it('a malformed JSON tag → null (treated as no tag)', () => {
    expect(extractTypedExit('RALPH-EXIT: {not json')).toBeNull();
  });

  it('an unknown kind → null', () => {
    expect(extractTypedExit('RALPH-EXIT: {"kind":"BANANA"}')).toBeNull();
  });
});

describe('outcomeFromEnvelope (MHL.3 — the neutral envelope→outcome fold)', () => {
  it('a clean envelope with NO tag → CRASH (fail-closed, never SHIPPED; cost/tokens pass through)', () => {
    expect(outcomeFromEnvelope(env({ resultText: 'did the work, tests pass' }))).toEqual({
      outcome: { kind: 'CRASH' },
      costUsd: 0.04,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it.each([
    'RALPH-EXIT: {oops', // no closing brace / no balanced object
    'RALPH-EXIT: not-json', // no leading {
    'RALPH-EXIT: {"kind":"BOGUS"}', // unknown kind → switch default
    'RALPH-EXIT: {"kind":"HUMAN_REQUIRED"}', // missing/invalid reason (:90 null)
    'RALPH-EXIT: {"kind":', // unparseable JSON
  ])('a clean envelope with a present-but-invalid tag → WEDGE (%s)', (text) => {
    expect(outcomeFromEnvelope(env({ resultText: `work\n${text}` })).outcome).toEqual({
      kind: 'WEDGE',
    });
  });

  it('a valid SHIPPED tag → SHIPPED (unchanged); other valid kinds unchanged (regression :79-96)', () => {
    const out = (text: string): LapOutcome =>
      outcomeFromEnvelope(env({ resultText: text })).outcome;
    expect(out('RALPH-EXIT: {"kind":"SHIPPED"}')).toEqual({ kind: 'SHIPPED' });
    expect(out('RALPH-EXIT: {"kind":"WEDGE"}')).toEqual({ kind: 'WEDGE' });
    expect(out('RALPH-EXIT: {"kind":"TIMEOUT"}')).toEqual({ kind: 'TIMEOUT' });
    expect(out('RALPH-EXIT: {"kind":"CRASH"}')).toEqual({ kind: 'CRASH' });
    expect(out('RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"SCOPE_FORK"}')).toEqual({
      kind: 'HUMAN_REQUIRED',
      reason: 'SCOPE_FORK',
    });
  });

  it('isError:true wins over a stray malformed tag → CRASH (isError checked FIRST)', () => {
    expect(
      outcomeFromEnvelope(env({ resultText: 'RALPH-EXIT: {bad', isError: true })).outcome,
    ).toEqual({ kind: 'CRASH' });
  });

  it('extracts a HUMAN_REQUIRED exit from the result text', () => {
    const r = outcomeFromEnvelope(
      env({ resultText: 'RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"BUDGET"}' }),
    );
    expect(r.outcome).toEqual({ kind: 'HUMAN_REQUIRED', reason: 'BUDGET' });
    expect(r.costUsd).toBe(0.04);
  });

  it('a SHIPPED tag carries the resulting stage through the fold', () => {
    expect(
      outcomeFromEnvelope(env({ resultText: 'RALPH-EXIT: {"kind":"SHIPPED","stage":"code"}' }))
        .outcome,
    ).toEqual({ kind: 'SHIPPED', stage: 'code' });
  });

  it('isError → CRASH (never SHIPPED), still reporting cost/tokens', () => {
    expect(outcomeFromEnvelope(env({ resultText: 'boom', isError: true, costUsd: 0.02 }))).toEqual({
      outcome: { kind: 'CRASH' },
      costUsd: 0.02,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('passes token usage through for the loop_metrics history (LSF.5)', () => {
    expect(
      outcomeFromEnvelope(
        env({ resultText: 'RALPH-EXIT: {"kind":"SHIPPED"}', inputTokens: 1200, outputTokens: 340 }),
      ),
    ).toEqual({
      outcome: { kind: 'SHIPPED' },
      costUsd: 0.04,
      inputTokens: 1200,
      outputTokens: 340,
    });
  });

  it('reports tokens even on a CRASH (isError) so the resource burn is captured', () => {
    expect(
      outcomeFromEnvelope(
        env({ resultText: 'boom', isError: true, inputTokens: 50, outputTokens: 10 }),
      ),
    ).toMatchObject({ outcome: { kind: 'CRASH' }, inputTokens: 50, outputTokens: 10 });
  });
});

describe('tagIsPresent (FCE.1 — the locked "present" signal; covers R-LAP-TAG-PRESENT)', () => {
  it('true iff the RALPH-EXIT tag occurs (mid-text / trailing garbage / no valid JSON), false otherwise', () => {
    expect(tagIsPresent('x RALPH-EXIT: {"kind":"SHIPPED"} y')).toBe(true);
    expect(tagIsPresent('RALPH-EXIT: {oops')).toBe(true); // present even with no valid JSON
    expect(tagIsPresent('no tag here at all')).toBe(false);
    expect(tagIsPresent('')).toBe(false);
  });
});
