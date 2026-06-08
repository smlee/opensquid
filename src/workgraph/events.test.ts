/**
 * Tests for the op-log primitives (T-WORKGRAPH-EVENTSOURCED). `applyOp` is exercised end-to-end
 * by store.test.ts (createIssue/updateIssue/addEdge fold through it); here we cover the pure
 * id/key functions.
 */
import { describe, expect, it } from 'vitest';

import { edgeKey, makeOpId } from './events.js';

describe('workgraph events', () => {
  it('makeOpId is stable per (type,payload,lamport) and varies otherwise', () => {
    const a = makeOpId('issue_created', { title: 't' }, 1);
    expect(a).toBe(makeOpId('issue_created', { title: 't' }, 1));
    expect(a).not.toBe(makeOpId('issue_created', { title: 't' }, 2)); // lamport varies → unique
    expect(a).not.toBe(makeOpId('issue_set', { title: 't' }, 1)); // type varies
    expect(a.startsWith('op-')).toBe(true);
  });

  it('makeOpId is canonical — independent of payload key order', () => {
    expect(makeOpId('issue_set', { a: 1, b: 2 }, 1)).toBe(makeOpId('issue_set', { b: 2, a: 1 }, 1));
  });

  it('edgeKey is deterministic, directed, and separator-safe (no concat collision)', () => {
    expect(edgeKey('a', 'b')).toBe(edgeKey('a', 'b'));
    expect(edgeKey('a', 'b')).not.toBe(edgeKey('b', 'a')); // direction matters (from→to)
    expect(edgeKey('ab', 'c')).not.toBe(edgeKey('a', 'bc')); // unit separator prevents collision
  });
});
