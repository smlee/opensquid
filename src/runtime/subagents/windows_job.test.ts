import { describe, expect, it } from 'vitest';

import { quoteWindowsArg } from './windows_job.js';

describe('quoteWindowsArg', () => {
  it('preserves simple args and quotes spaces, quotes, and trailing slashes', () => {
    expect(quoteWindowsArg('plain')).toBe('plain');
    expect(quoteWindowsArg('two words')).toBe('"two words"');
    expect(quoteWindowsArg('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArg('C:\\Program Files\\')).toBe('"C:\\Program Files\\\\"');
    expect(quoteWindowsArg('')).toBe('""');
  });
});
