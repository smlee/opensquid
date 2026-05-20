/**
 * Tests for `decideEviction` (Task 7.5).
 *
 * Acceptance per phase-7-wedge-gate.md §"Task 7.5":
 *  - user-authored → refuse + reason.
 *  - agent-authored → evict.
 *  - missing author → refuse (default safe).
 *  - ≥ 3 tests.
 */

import { describe, expect, it } from 'vitest';

import { decideEviction } from './eviction.js';
import type { Lesson } from '../../rag/types.js';

function userLesson(): Lesson {
  return {
    id: 'l-user',
    content: 'user wisdom',
    tags: [],
    source: 'manual',
    author: 'user',
    createdAt: '2026-05-19T10:00:00.000Z',
  };
}

function agentLesson(): Lesson {
  return {
    id: 'l-agent',
    content: 'agent guess',
    tags: [],
    source: 'wedge-gate',
    author: 'agent',
    createdAt: '2026-05-19T10:00:00.000Z',
  };
}

describe('decideEviction', () => {
  it('refuses user-authored lessons (eviction-immune)', () => {
    const d = decideEviction(userLesson());
    expect(d.decision).toBe('refuse');
    expect(d.reason).toMatch(/user-authored/);
    expect(d.reason).toMatch(/eviction-immune/);
  });

  it('evicts agent-authored lessons', () => {
    const d = decideEviction(agentLesson());
    expect(d.decision).toBe('evict');
    expect(d.reason).toMatch(/agent-authored/);
  });

  it('refuses on missing author (default-safe)', () => {
    const d = decideEviction({});
    expect(d.decision).toBe('refuse');
    expect(d.reason).toMatch(/missing or unknown author/);
  });

  it('refuses on unknown author value (defensive)', () => {
    const d = decideEviction({ author: 'system' });
    expect(d.decision).toBe('refuse');
    expect(d.reason).toMatch(/missing or unknown author/);
  });

  it('refuses on null/undefined author shape', () => {
    // Explicit `undefined` is rejected at compile time under
    // `exactOptionalPropertyTypes`; treat it as an empty object (the
    // runtime guard is identical for both shapes).
    expect(decideEviction({}).decision).toBe('refuse');
    // null is not a valid Lesson author per the type, but the runtime guards.
    expect(decideEviction({ author: null as unknown as string }).decision).toBe('refuse');
  });
});
