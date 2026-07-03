/**
 * T-WORKGRAPH-PROJECT-SCOPE (lap/loop agreement) — the shared coalesce that makes a ralph lap and the
 * loop that spawned it resolve the SAME workgraph project. cwd-marker wins; OPENSQUID_PROJECT_UUID env
 * is the fallback; null-through degrades to 'legacy-global'.
 */
import { describe, expect, it } from 'vitest';

import { resolveWgNamespace } from './project_scope.js';

describe('resolveWgNamespace', () => {
  it('the cwd-derived marker wins over the env', () => {
    expect(resolveWgNamespace('marker-uuid', 'env-uuid')).toBe('marker-uuid');
  });

  it('falls back to OPENSQUID_PROJECT_UUID when the marker is null (the lap fix)', () => {
    // A lap whose own session→cwd marker cannot resolve (markerUuid null) but that inherited the
    // loop-published env resolves the LOOP's project — not the empty board.
    expect(resolveWgNamespace(null, 'loop-project-uuid')).toBe('loop-project-uuid');
  });

  it('degrades to legacy-global only when BOTH marker and env are null (reproduces the bug)', () => {
    // The proven pre-fix path: lap marker unresolvable + no env published → empty legacy-global board.
    expect(resolveWgNamespace(null, null)).toBe('legacy-global');
  });
});
