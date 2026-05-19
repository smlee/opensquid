/**
 * Vitest suite for src/secrets/resolver.ts + src/secrets/backends/dotenv.ts.
 *
 * Covers:
 *   1. env: URI resolves from process.env.
 *   2. env: URI resolves from a .env file when not in process.env.
 *   3. Missing key returns null.
 *   4. .env value `KEY="line with spaces"` strips the surrounding quotes.
 *   5. Cache: second resolve does not re-read the .env file (spy on readFile).
 *   6. Unknown scheme returns null.
 *   7. Comment and blank lines in .env are skipped.
 *   8. process.env wins over .env for the same key.
 *
 * Each .env file is written to a unique path under os.tmpdir so tests don't
 * collide. process.env mutations are saved + restored per test.
 */

import { randomUUID } from 'node:crypto';
import { writeFile, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createResolver, dotenvBackend } from './index.js';

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};

function stashEnv(key: string): void {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
}

async function writeDotenv(contents: string): Promise<string> {
  const path = join(tempDir, `${randomUUID()}.env`);
  await writeFile(path, contents, 'utf8');
  return path;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'opensquid-secrets-'));
});

afterEach(async () => {
  restoreEnv();
  await rm(tempDir, { recursive: true, force: true });
});

describe('createResolver + dotenvBackend', () => {
  it('resolves env:MY_VAR from process.env', async () => {
    stashEnv('OS_TEST_MY_VAR');
    process.env.OS_TEST_MY_VAR = 'hello';

    const resolver = createResolver([dotenvBackend()]);
    const value = await resolver.resolve('env:OS_TEST_MY_VAR');

    expect(value).toBe('hello');
  });

  it('resolves env:KEY from a .env file when not in process.env', async () => {
    stashEnv('OS_TEST_FROM_FILE');
    const path = await writeDotenv('OS_TEST_FROM_FILE=value\n');

    const resolver = createResolver([dotenvBackend({ path })]);
    const value = await resolver.resolve('env:OS_TEST_FROM_FILE');

    expect(value).toBe('value');
  });

  it('returns null for a missing key', async () => {
    stashEnv('OS_TEST_MISSING');
    const resolver = createResolver([dotenvBackend()]);

    const value = await resolver.resolve('env:OS_TEST_MISSING');

    expect(value).toBeNull();
  });

  it('strips surrounding double-quotes from .env values', async () => {
    stashEnv('OS_TEST_QUOTED');
    const path = await writeDotenv('OS_TEST_QUOTED="line with spaces"\n');

    const resolver = createResolver([dotenvBackend({ path })]);
    const value = await resolver.resolve('env:OS_TEST_QUOTED');

    expect(value).toBe('line with spaces');
  });

  it('caches resolved values — second resolve does not re-read the .env file', async () => {
    stashEnv('OS_TEST_CACHE');
    const path = await writeDotenv('OS_TEST_CACHE=cached\n');

    const resolver = createResolver([dotenvBackend({ path })]);
    const first = await resolver.resolve('env:OS_TEST_CACHE');

    // Delete the .env file — any further read would now fail. If the cache is
    // doing its job, neither the resolver cache layer nor the backend's lazy
    // load layer should attempt another disk read.
    await unlink(path);

    const second = await resolver.resolve('env:OS_TEST_CACHE');

    expect(first).toBe('cached');
    expect(second).toBe('cached');
  });

  it('returns null for an unknown URI scheme', async () => {
    const resolver = createResolver([dotenvBackend()]);

    const value = await resolver.resolve('unknown:foo');

    expect(value).toBeNull();
  });

  it('skips comments and blank lines in the .env file', async () => {
    stashEnv('OS_TEST_AFTER_COMMENT');
    const path = await writeDotenv(
      ['# this is a comment', '', 'OS_TEST_AFTER_COMMENT=ok', ''].join('\n'),
    );

    const resolver = createResolver([dotenvBackend({ path })]);
    const value = await resolver.resolve('env:OS_TEST_AFTER_COMMENT');

    expect(value).toBe('ok');
  });

  it('process.env wins over .env for the same key', async () => {
    stashEnv('OS_TEST_PRECEDENCE');
    process.env.OS_TEST_PRECEDENCE = 'from-process';
    const path = await writeDotenv('OS_TEST_PRECEDENCE=from-file\n');

    const resolver = createResolver([dotenvBackend({ path })]);
    const value = await resolver.resolve('env:OS_TEST_PRECEDENCE');

    expect(value).toBe('from-process');
  });

  it('returns null when URI has no colon', async () => {
    const resolver = createResolver([dotenvBackend()]);
    expect(await resolver.resolve('no-colon-here')).toBeNull();
  });

  it('handles env:// (slashes after colon) the same as env:', async () => {
    stashEnv('OS_TEST_SLASHES');
    process.env.OS_TEST_SLASHES = 'either-form';

    const resolver = createResolver([dotenvBackend()]);
    const a = await resolver.resolve('env:OS_TEST_SLASHES');
    const b = await resolver.resolve('env://OS_TEST_SLASHES');

    expect(a).toBe('either-form');
    expect(b).toBe('either-form');
  });

  it('silently tolerates a missing .env path (ENOENT)', async () => {
    stashEnv('OS_TEST_NO_FILE');
    process.env.OS_TEST_NO_FILE = 'from-process-only';
    const path = join(tempDir, 'does-not-exist.env');

    const resolver = createResolver([dotenvBackend({ path })]);
    const value = await resolver.resolve('env:OS_TEST_NO_FILE');

    expect(value).toBe('from-process-only');
  });
});
