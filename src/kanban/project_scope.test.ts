/** KANBAN.4 — the project-namespace resolver's load-bearing throw invariant (audit-required coverage). */
import { describe, expect, it } from 'vitest';

import { resolveProjectNamespace } from './project_scope.js';

describe('resolveProjectNamespace (KANBAN.4 isolation invariant)', () => {
  it('marker uuid wins (== the recall namespace)', () => {
    expect(resolveProjectNamespace('proj-uuid-123', null)).toBe('proj-uuid-123');
    expect(resolveProjectNamespace('proj-uuid-123', 'env-uuid')).toBe('proj-uuid-123'); // marker precedence
  });

  it('falls back to the env uuid when no marker', () => {
    expect(resolveProjectNamespace(null, 'env-uuid')).toBe('env-uuid');
  });

  it('THROWS on a null namespace (no marker AND no env) — never a silent shared bucket', () => {
    // The divergence from set_goal.ts:35 (which degrades to a global bucket): a board write needs a concrete
    // key, so an unresolved namespace must fail loud rather than collide across unscoped contexts.
    expect(() => resolveProjectNamespace(null, null)).toThrow(/cannot resolve project namespace/);
  });
});
