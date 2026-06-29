/**
 * GR.2 — the typed-exit contract. parseLapOutcome is a TOTAL mapping (never throws, never a false
 * SHIPPED); extractTypedExit defensively scans the RALPH-EXIT tag.
 */
import { describe, expect, it } from 'vitest';

import { extractTypedExit, parseLapOutcome } from './lap_outcome.js';

const envelope = (result: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ result, is_error: false, subtype: 'success', total_cost_usd: 0.04, ...extra });

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

describe('parseLapOutcome', () => {
  it('a clean envelope with no tag → SHIPPED', () => {
    expect(parseLapOutcome(envelope('did the work, tests pass'))).toEqual({
      outcome: { kind: 'SHIPPED' },
      costUsd: 0.04,
    });
  });

  it('extracts a HUMAN_REQUIRED exit from the result', () => {
    const r = parseLapOutcome(envelope('RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"BUDGET"}'));
    expect(r.outcome).toEqual({ kind: 'HUMAN_REQUIRED', reason: 'BUDGET' });
    expect(r.costUsd).toBe(0.04);
  });

  it('an unparseable envelope → CRASH (never SHIPPED)', () => {
    expect(parseLapOutcome('not json at all')).toEqual({ outcome: { kind: 'CRASH' }, costUsd: 0 });
  });

  it('is_error:true → CRASH, still reporting cost', () => {
    expect(parseLapOutcome(envelope('boom', { is_error: true, total_cost_usd: 0.02 }))).toEqual({
      outcome: { kind: 'CRASH' },
      costUsd: 0.02,
    });
  });

  it('a non-object JSON envelope → CRASH', () => {
    expect(parseLapOutcome('42')).toEqual({ outcome: { kind: 'CRASH' }, costUsd: 0 });
  });

  it('missing total_cost_usd defaults cost to 0', () => {
    expect(parseLapOutcome(JSON.stringify({ result: 'ok', is_error: false })).costUsd).toBe(0);
  });
});
