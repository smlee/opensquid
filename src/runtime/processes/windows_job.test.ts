import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { quoteWindowsArg } from './windows_job.js';

describe('Windows Job Object lifetime', () => {
  it('kills the exact job tree if the broker/supervisor exits', () => {
    const broker = readFileSync(
      fileURLToPath(new URL('./windows_job_broker.ps1', import.meta.url)),
      'utf8',
    );
    expect(broker).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(broker).toContain('SetInformationJobObject');
  });
});

describe('quoteWindowsArg', () => {
  it('preserves simple args and quotes spaces, quotes, and trailing slashes', () => {
    expect(quoteWindowsArg('plain')).toBe('plain');
    expect(quoteWindowsArg('two words')).toBe('"two words"');
    expect(quoteWindowsArg('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArg('C:\\Program Files\\')).toBe('"C:\\Program Files\\\\"');
    expect(quoteWindowsArg('')).toBe('""');
  });
});
