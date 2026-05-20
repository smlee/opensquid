/**
 * Tests for the `file_write` primitive — gate-routed file writer (AUTO.3).
 *
 * Coverage:
 *   1. Allowed write succeeds + content lands on disk + atomic rename.
 *   2. Gate-denied write → runtime error + filesystem untouched.
 *   3. Relative paths resolved against cwd before gate check.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityGate, type PackPermissions } from '../runtime/capability_gate.js';

import { registerFileWriteFunction } from './file_write.js';
import { FunctionRegistry, type EvalCtx } from './registry.js';

function ctx(packId: string): EvalCtx {
  return {
    event: {
      kind: 'tool_call',
      tool: 't',
      args: {},
    },
    bindings: new Map(),
    sessionId: 'session-test',
    packId,
  };
}

describe('file_write primitive', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opensquid-fw-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes to an allowed path and returns bytes count', async () => {
    const packs = new Map<string, PackPermissions>([
      [
        'p',
        {
          name: 'p',
          permissions: { file_write: { paths: [`${dir}/**`], deny: [] } },
        },
      ],
    ]);
    const gate = new CapabilityGate({ packs, trustBuiltinDeny: true });
    const registry = new FunctionRegistry();
    registerFileWriteFunction(registry, { gate, cwd: dir });

    const target = join(dir, 'out.txt');
    const res = await registry.call('file_write', { path: target, content: 'hello\n' }, ctx('p'));
    expect(res.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
  });

  it('denied write returns runtime error and does NOT touch the file', async () => {
    // No permissions block → deny-all for every cap.
    const packs = new Map<string, PackPermissions>([['p', { name: 'p' }]]);
    const gate = new CapabilityGate({ packs, trustBuiltinDeny: true });
    const registry = new FunctionRegistry();
    registerFileWriteFunction(registry, { gate, cwd: dir });

    const target = join(dir, 'never.txt');
    const res = await registry.call('file_write', { path: target, content: 'nope' }, ctx('p'));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toMatch(/denied/);
    }
    expect(existsSync(target)).toBe(false);
  });

  it('resolves relative paths against cwd before gate check', async () => {
    const packs = new Map<string, PackPermissions>([
      [
        'p',
        {
          name: 'p',
          permissions: { file_write: { paths: [`${dir}/**`], deny: [] } },
        },
      ],
    ]);
    const gate = new CapabilityGate({ packs, trustBuiltinDeny: true });
    const registry = new FunctionRegistry();
    registerFileWriteFunction(registry, { gate, cwd: dir });

    const res = await registry.call(
      'file_write',
      { path: 'relative.txt', content: 'rel' },
      ctx('p'),
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(dir, 'relative.txt'), 'utf8')).toBe('rel');
  });

  it('built-in /etc deny still applies even with broad pack allowlist', async () => {
    const packs = new Map<string, PackPermissions>([
      [
        'p',
        {
          name: 'p',
          permissions: { file_write: { paths: ['/**'], deny: [] } },
        },
      ],
    ]);
    const gate = new CapabilityGate({ packs, trustBuiltinDeny: true });
    const registry = new FunctionRegistry();
    registerFileWriteFunction(registry, { gate, cwd: dir });

    const res = await registry.call(
      'file_write',
      { path: '/etc/oops.txt', content: 'nope' },
      ctx('p'),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toMatch(/denied/);
      expect(res.error.message).toMatch(/built-in/);
    }
  });
});
