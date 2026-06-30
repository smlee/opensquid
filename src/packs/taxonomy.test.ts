/** ORCH / pack-taxonomy — dictionary validation (isNode) + hierarchical containment (graceful depth). */
import { describe, expect, it } from 'vitest';

import { contains, isNode } from './taxonomy.js';

describe('taxonomy — isNode (dictionary membership)', () => {
  it('accepts a valid dotted node at any depth', () => {
    expect(isNode('domain', 'coding')).toBe(true);
    expect(isNode('domain', 'coding.frontend')).toBe(true);
    expect(isNode('domain', 'meta.task-authoring')).toBe(true);
    expect(isNode('framework', 'react')).toBe(true);
  });

  it('rejects an off-dictionary node (fail-loud is the caller’s job) + the empty path', () => {
    expect(isNode('domain', 'webdev')).toBe(false); // typo-drift guard
    expect(isNode('domain', 'coding.mobile')).toBe(false); // not in the tree
    expect(isNode('domain', '')).toBe(false);
    expect(isNode('nope', 'coding')).toBe(false); // unknown axis
  });
});

describe('taxonomy — contains (graceful-depth containment)', () => {
  it('a shallow node contains a deeper path (at-or-below)', () => {
    expect(contains('coding', 'coding.frontend')).toBe(true);
    expect(contains('coding', 'coding.frontend.react')).toBe(true);
    expect(contains('coding.frontend', 'coding.frontend.react')).toBe(true);
  });

  it('a deeper node does NOT contain a shallower path (no false activation)', () => {
    expect(contains('coding.frontend', 'coding')).toBe(false);
    expect(contains('coding.frontend.react', 'coding.frontend')).toBe(false);
  });

  it('equal paths contain each other; sibling/disjoint do not', () => {
    expect(contains('coding.frontend', 'coding.frontend')).toBe(true);
    expect(contains('coding.frontend', 'coding.backend')).toBe(false);
    expect(contains('coding', 'content.seo')).toBe(false);
  });

  it('is segment-wise, never substring (coding does not contain coding2)', () => {
    expect(contains('coding', 'coding2')).toBe(false);
    expect(contains('cod', 'coding')).toBe(false);
  });
});
