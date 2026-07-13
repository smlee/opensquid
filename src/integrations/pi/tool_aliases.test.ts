import { describe, expect, it } from 'vitest';

import {
  policyToolAliases,
  toPolicyToolValue,
  toolMatches,
  toolValueContains,
  toolValueEndsWith,
  toolValueEquals,
  toolValueMatchesPattern,
  toolValueStartsWith,
  toolValueString,
} from './tool_aliases.js';

describe('Pi tool aliases', () => {
  it('treats MultiEdit as Edit for legacy policy matches', () => {
    expect([...policyToolAliases('MultiEdit')]).toEqual(['MultiEdit', 'Edit']);
    expect(toolMatches('MultiEdit', 'Edit')).toBe(true);
    expect(toolMatches('Edit', 'MultiEdit')).toBe(false);
  });

  it('drives expression equality from the actual tool binding only', () => {
    const multi = toPolicyToolValue('MultiEdit');
    expect(toolValueString(multi)).toBe('MultiEdit');
    expect(toolValueEquals(multi, 'Edit')).toBe(true);
    expect(toolValueEquals('Edit', multi)).toBe(true);
    expect(toolValueEquals('Edit', 'MultiEdit')).toBeNull();
  });

  it('matches regex and string checks through aliases', () => {
    const multi = toPolicyToolValue('MultiEdit');
    expect(toolValueContains(multi, 'Edit')).toBe(true);
    expect(toolValueStartsWith(multi, 'Multi')).toBe(true);
    expect(toolValueEndsWith(multi, 'Edit')).toBe(true);
    expect(toolValueMatchesPattern(multi, /^(Write|Edit|NotebookEdit)$/)).toBe(true);
  });
});
