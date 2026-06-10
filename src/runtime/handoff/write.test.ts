/**
 * T-AUTO-HANDOFF — write.ts unit tests: the MEMORY.md marker contract (bytes
 * outside the managed region are NEVER touched) + path resolution pinning.
 */

import { describe, expect, it } from 'vitest';

import {
  HANDOFF_BEGIN,
  HANDOFF_END,
  encodeProjectPath,
  memoryMdPathFor,
  spliceResumeBlock,
} from './write.js';

describe('spliceResumeBlock', () => {
  it('replaces an existing managed region; outside bytes byte-identical', () => {
    const before = `# Title\n\nuser content A\n\n${HANDOFF_BEGIN}\nOLD\n${HANDOFF_END}\n\nuser content B\n`;
    const after = spliceResumeBlock(before, 'NEW');
    expect(after).toContain(`${HANDOFF_BEGIN}\nNEW\n${HANDOFF_END}`);
    expect(after).not.toContain('OLD');
    expect(after.startsWith('# Title\n\nuser content A\n\n')).toBe(true);
    expect(after.endsWith('\n\nuser content B\n')).toBe(true);
  });

  it('inserts after the first H1 when no markers exist', () => {
    const before = `# My Memory\n\n- existing pointer\n`;
    const after = spliceResumeBlock(before, 'BLOCK');
    expect(after.indexOf('# My Memory')).toBe(0);
    expect(after.indexOf(HANDOFF_BEGIN)).toBeGreaterThan(after.indexOf('# My Memory'));
    expect(after.indexOf(HANDOFF_BEGIN)).toBeLessThan(after.indexOf('- existing pointer'));
    expect(after).toContain('- existing pointer');
  });

  it('prepends when there is no H1', () => {
    const before = 'plain text only\n';
    const after = spliceResumeBlock(before, 'BLOCK');
    expect(after.startsWith(HANDOFF_BEGIN)).toBe(true);
    expect(after).toContain('plain text only');
  });

  it('is idempotent: splicing the same block twice is byte-identical', () => {
    const before = `# T\n\nbody\n`;
    const once = spliceResumeBlock(before, 'B');
    expect(spliceResumeBlock(once, 'B')).toBe(once);
  });
});

describe('memoryMdPathFor (path resolution pinned — the encodeProjectPath convention)', () => {
  it('sanitizes / to - exactly like the auto-memory dir naming', () => {
    expect(encodeProjectPath('/x/y')).toBe('-x-y');
    expect(memoryMdPathFor('/x/y')).toContain('/projects/-x-y/memory/MEMORY.md');
  });
});
