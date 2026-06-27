/**
 * T-project-context (write half) — detectPackageManager.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectPackageManager } from './package_manager_detect.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osq-pmdetect-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = (name: string, content = '') => writeFile(join(dir, name), content, 'utf8');

describe('detectPackageManager', () => {
  it('returns null when nothing is detectable', async () => {
    expect(await detectPackageManager(dir)).toBeNull();
  });

  it('package.json "packageManager" (corepack) is authoritative', async () => {
    await put('package.json', JSON.stringify({ packageManager: 'pnpm@9.1.0' }));
    await put('package-lock.json'); // even with an npm lockfile present
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });

  it('falls back to lockfile when no packageManager field', async () => {
    await put('package.json', JSON.stringify({ name: 'x' }));
    await put('yarn.lock');
    expect(await detectPackageManager(dir)).toBe('yarn');
  });

  it('detects each lockfile', async () => {
    await put('pnpm-lock.yaml');
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });

  it('bun.lock / bun.lockb → bun', async () => {
    await put('bun.lock');
    expect(await detectPackageManager(dir)).toBe('bun');
  });

  it('package-lock.json → npm', async () => {
    await put('package-lock.json');
    expect(await detectPackageManager(dir)).toBe('npm');
  });

  it('priority: pnpm-lock beats package-lock when both present', async () => {
    await put('pnpm-lock.yaml');
    await put('package-lock.json');
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });

  it('ignores an unparseable package.json (falls through)', async () => {
    await put('package.json', '{ not json');
    await put('pnpm-lock.yaml');
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });

  it('ignores an unknown packageManager value', async () => {
    await put('package.json', JSON.stringify({ packageManager: 'cargo@1' }));
    expect(await detectPackageManager(dir)).toBeNull();
  });
});
