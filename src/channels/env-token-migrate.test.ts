/**
 * PATH.2 (wg-61fe416b3006) — legacy env-file migration (~/.loop/.env → canonical).
 * The legacy path is parameterized so the test never touches the real ~/.loop.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateLegacyEnvFile } from './env-token.js';

let home: string;
let legacyDir: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-envhome-'));
  legacyDir = await mkdtemp(join(tmpdir(), 'opensquid-legacy-'));
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
  await rm(legacyDir, { recursive: true, force: true });
});

const canonical = (): string => join(home, '.env');

describe('migrateLegacyEnvFile (PATH.2)', () => {
  it('copies legacy → canonical (chmod 600) when canonical is absent', async () => {
    const legacy = join(legacyDir, '.env');
    await writeFile(legacy, 'OPENSQUID_TELEGRAM_BOT_TOKEN=abc123\n');
    await migrateLegacyEnvFile(legacy);
    expect(await readFile(canonical(), 'utf8')).toBe('OPENSQUID_TELEGRAM_BOT_TOKEN=abc123\n');
    expect((await stat(canonical())).mode & 0o777).toBe(0o600);
  });

  it('is a no-op when canonical already exists (never overwrites)', async () => {
    await writeFile(canonical(), 'OPENSQUID_TELEGRAM_BOT_TOKEN=current\n');
    const legacy = join(legacyDir, '.env');
    await writeFile(legacy, 'OPENSQUID_TELEGRAM_BOT_TOKEN=stale\n');
    await migrateLegacyEnvFile(legacy);
    expect(await readFile(canonical(), 'utf8')).toBe('OPENSQUID_TELEGRAM_BOT_TOKEN=current\n');
  });

  it('is a no-op (no canonical created) when there is no legacy file', async () => {
    await migrateLegacyEnvFile(join(legacyDir, '.env')); // legacy absent
    await expect(stat(canonical())).rejects.toThrow();
  });

  it('creates the canonical home dir if absent (and is fail-soft)', async () => {
    await rm(home, { recursive: true, force: true }); // home dir gone
    const legacy = join(legacyDir, '.env');
    await writeFile(legacy, 'tok\n');
    await migrateLegacyEnvFile(legacy); // must not throw
    expect(await readFile(canonical(), 'utf8')).toBe('tok\n');
  });
});
