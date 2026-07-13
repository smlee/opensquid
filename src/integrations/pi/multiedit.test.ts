import { describe, expect, it } from 'vitest';

import { applyOriginalRelativeMultiEdit, PiMultiEditError } from './multiedit.js';

describe('applyOriginalRelativeMultiEdit', () => {
  it('preserves BOM and CRLF while applying original-relative edits', () => {
    const result = applyOriginalRelativeMultiEdit('\uFEFFalpha\r\nbeta\r\n', [
      { oldText: 'alpha', newText: 'ALPHA' },
      { oldText: 'beta', newText: 'BETA' },
    ]);
    expect(result.content).toBe('\uFEFFALPHA\r\nBETA\r\n');
  });

  it('rejects ambiguous matches', () => {
    expect(() =>
      applyOriginalRelativeMultiEdit('alpha\nalpha\n', [{ oldText: 'alpha', newText: 'beta' }]),
    ).toThrow(PiMultiEditError);
  });

  it('rejects overlapping edits against the original content', () => {
    expect(() =>
      applyOriginalRelativeMultiEdit('abcdef', [
        { oldText: 'abc', newText: 'ABC' },
        { oldText: 'bcd', newText: 'BCD' },
      ]),
    ).toThrow(/overlap/i);
  });

  it('rejects no-op edits', () => {
    expect(() =>
      applyOriginalRelativeMultiEdit('alpha\n', [{ oldText: 'alpha', newText: 'alpha' }]),
    ).toThrow(/no change/i);
  });

  it('rejects fuzzy-only matches retryably', () => {
    expect(() =>
      applyOriginalRelativeMultiEdit('alpha – beta\n', [
        { oldText: 'alpha - beta', newText: 'done' },
      ]),
    ).toThrow(/fuzzy-only/i);
  });
});
