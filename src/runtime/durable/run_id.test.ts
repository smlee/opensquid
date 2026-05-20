/**
 * Tests for `runIdFor` + canonical JSON helpers (DURABLE.1).
 *
 * Coverage:
 *   1. Determinism — same input across calls yields same run_id.
 *   2. Stability across object-key permutation — `{a, b}` and `{b, a}` payloads
 *      hash to the same run_id (sorted-key canonical JSON).
 *   3. Sensitivity — changing pack / skill / ruleId / eventKind / eventPayload
 *      each produces a different run_id.
 *   4. Format — 64-char lowercase hex.
 *   5. Canonical JSON round-trip — Date → ISO string; Buffer → base64 envelope
 *      → Buffer.
 *   6. Cycle detection — cyclic objects throw at stringify time.
 */

import { describe, expect, it } from 'vitest';

import { canonicalJsonParse, canonicalJsonStringify } from './canonical_json.js';
import { runIdFor } from './run_id.js';

describe('runIdFor — determinism', () => {
  it('same (pack, skill, ruleId, eventKind, eventHash) → same run_id across calls', () => {
    const input = {
      pack: 'demo-pack',
      skill: 'destination-check',
      ruleId: 'rule-1',
      eventKind: 'stop',
      eventPayload: { assistantText: 'all phases run', cwd: '/work' },
    };

    const a = runIdFor(input);
    const b = runIdFor(input);
    const c = runIdFor({ ...input, eventPayload: { ...input.eventPayload } });

    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('object-key permutation in eventPayload produces the same run_id', () => {
    const a = runIdFor({
      pack: 'p',
      skill: 's',
      ruleId: 'r',
      eventKind: 'stop',
      eventPayload: { a: 1, b: 2, nested: { x: 10, y: 20 } },
    });
    const b = runIdFor({
      pack: 'p',
      skill: 's',
      ruleId: 'r',
      eventKind: 'stop',
      eventPayload: { b: 2, nested: { y: 20, x: 10 }, a: 1 },
    });
    expect(a).toBe(b);
  });

  it('returns 64-char lowercase hex', () => {
    const id = runIdFor({
      pack: 'p',
      skill: 's',
      ruleId: 'r',
      eventKind: 'stop',
      eventPayload: {},
    });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('runIdFor — sensitivity', () => {
  const base = {
    pack: 'pack-a',
    skill: 'skill-a',
    ruleId: 'rule-a',
    eventKind: 'stop',
    eventPayload: { x: 1 },
  } as const;

  it('changing pack changes run_id', () => {
    expect(runIdFor(base)).not.toBe(runIdFor({ ...base, pack: 'pack-b' }));
  });

  it('changing skill changes run_id', () => {
    expect(runIdFor(base)).not.toBe(runIdFor({ ...base, skill: 'skill-b' }));
  });

  it('changing ruleId changes run_id', () => {
    expect(runIdFor(base)).not.toBe(runIdFor({ ...base, ruleId: 'rule-b' }));
  });

  it('changing eventKind changes run_id', () => {
    expect(runIdFor(base)).not.toBe(runIdFor({ ...base, eventKind: 'user-prompt-submit' }));
  });

  it('changing eventPayload changes run_id', () => {
    expect(runIdFor(base)).not.toBe(runIdFor({ ...base, eventPayload: { x: 2 } }));
  });
});

describe('canonicalJsonStringify — Date / Buffer round-trip', () => {
  it('Date serializes to ISO string', () => {
    const d = new Date('2026-05-20T12:34:56.789Z');
    const s = canonicalJsonStringify({ when: d });
    expect(s).toBe('{"when":"2026-05-20T12:34:56.789Z"}');
    const parsed = canonicalJsonParse(s) as { when: string };
    expect(parsed.when).toBe('2026-05-20T12:34:56.789Z');
  });

  it('Buffer serializes to base64 envelope and revives to Buffer', () => {
    const buf = Buffer.from('hello world', 'utf8');
    const s = canonicalJsonStringify({ payload: buf });
    expect(s).toContain('"__type":"base64"');
    expect(s).toContain('"data":"' + buf.toString('base64') + '"');
    const parsed = canonicalJsonParse(s) as { payload: Buffer };
    expect(Buffer.isBuffer(parsed.payload)).toBe(true);
    expect(parsed.payload.toString('utf8')).toBe('hello world');
  });

  it('Uint8Array serializes to the same base64 envelope as Buffer', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const s = canonicalJsonStringify({ payload: bytes });
    const parsed = canonicalJsonParse(s) as { payload: Buffer };
    expect(Buffer.isBuffer(parsed.payload)).toBe(true);
    expect(Array.from(parsed.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sorts object keys recursively', () => {
    expect(canonicalJsonStringify({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it('drops undefined object properties (JSON.stringify parity)', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('throws TypeError on cyclic objects', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => canonicalJsonStringify(o)).toThrow(TypeError);
  });
});
