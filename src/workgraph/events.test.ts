/**
 * Tests for the op-log primitives (T-WORKGRAPH-EVENTSOURCED). `applyOp` is exercised end-to-end
 * by store.test.ts (createIssue/updateIssue/addEdge fold through it); here we cover the pure
 * id/key functions. WGD.1: `makeOpId` now content-addresses over `(type, lamport, actorId, payload)`
 * — `actorId` keeps merged replicas distinct; `ts` is never part of identity.
 */
import { describe, expect, it } from 'vitest';

import { canonicalJson, edgeKey, makeOpId } from './events.js';

const A = 'actor-a';

describe('workgraph events', () => {
  it('makeOpId is stable per (type,payload,lamport,actorId) and varies otherwise', () => {
    const a = makeOpId('issue_created', { title: 't' }, 1, A);
    expect(a).toBe(makeOpId('issue_created', { title: 't' }, 1, A));
    expect(a).not.toBe(makeOpId('issue_created', { title: 't' }, 2, A)); // lamport varies → unique
    expect(a).not.toBe(makeOpId('issue_set', { title: 't' }, 1, A)); // type varies
    expect(a).not.toBe(makeOpId('issue_created', { title: 't' }, 1, 'actor-b')); // actorId varies
    expect(a.startsWith('op-')).toBe(true);
  });

  it('makeOpId is canonical — independent of payload key order', () => {
    expect(makeOpId('issue_set', { a: 1, b: 2 }, 1, A)).toBe(
      makeOpId('issue_set', { b: 2, a: 1 }, 1, A),
    );
  });

  it('CROSS-ACTOR: same (type,payload,lamport) but different actorId → DISTINCT op ids (the tuple)', () => {
    const lamport = 5;
    const payload = { title: 'same' };
    expect(makeOpId('issue_created', payload, lamport, 'dev-1')).not.toBe(
      makeOpId('issue_created', payload, lamport, 'dev-2'),
    );
  });

  it('edgeKey is deterministic, directed, and separator-safe (no concat collision)', () => {
    expect(edgeKey('a', 'b')).toBe(edgeKey('a', 'b'));
    expect(edgeKey('a', 'b')).not.toBe(edgeKey('b', 'a')); // direction matters (from→to)
    expect(edgeKey('ab', 'c')).not.toBe(edgeKey('a', 'bc')); // unit separator prevents collision
  });

  it('canonicalJson is exported and key-order independent', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });
});
