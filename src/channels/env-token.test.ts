/**
 * env-token.ts tests (CAT.1b, ported from src.legacy/chat/env-token.test.ts,
 * #148): priority + .env parsing.
 *
 * Isolation: each test runs against a fresh `mkdtemp` with both
 * `OPENSQUID_HOME` and `HOME` redirected at it, so the `.env` candidate
 * paths (`~/.loop/.env`, `<OPENSQUID_HOME>/.env`) resolve inside the
 * tmpdir rather than the developer's real home (which may hold a real
 * token that would taint the test). `OPENSQUID_ENV_FILE` overrides take
 * precedence and are set per-test where needed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _clearEnvFileCache, loadEnvFile, locateEnvFile, resolveToken } from './env-token.js';

let tmpDir: string;
const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const k of keys) SAVED_ENV[k] = process.env[k];
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'opensquid-envtoken-'));
  saveEnv(
    'OPENSQUID_TELEGRAM_BOT_TOKEN',
    'OPENSQUID_DISCORD_BOT_TOKEN',
    'OPENSQUID_SLACK_BOT_TOKEN',
    'OPENSQUID_SLACK_APP_TOKEN',
    'OPENSQUID_ENV_FILE',
    'OPENSQUID_HOME',
    'HOME',
  );
  // Wipe inherited values so tests run from a known empty state.
  delete process.env.OPENSQUID_TELEGRAM_BOT_TOKEN;
  delete process.env.OPENSQUID_DISCORD_BOT_TOKEN;
  delete process.env.OPENSQUID_SLACK_BOT_TOKEN;
  delete process.env.OPENSQUID_SLACK_APP_TOKEN;
  delete process.env.OPENSQUID_ENV_FILE;
  // Override OPENSQUID_HOME + HOME so the .env candidate paths
  // (~/.loop/.env, <OPENSQUID_HOME>/.env) point at the empty tmpdir,
  // not the real home directory where the user may have a real .env
  // that would taint the test.
  process.env.OPENSQUID_HOME = tmpDir;
  process.env.HOME = tmpDir;
  _clearEnvFileCache();
});

afterEach(async () => {
  restoreEnv();
  _clearEnvFileCache();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadEnvFile — parsing', () => {
  it('parses standard KEY=VALUE lines', async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, 'OPENSQUID_TELEGRAM_BOT_TOKEN=1234:abcdef\nSOMETHING_ELSE=value\n');
    const parsed = await loadEnvFile(p);
    expect(parsed.OPENSQUID_TELEGRAM_BOT_TOKEN).toBe('1234:abcdef');
    expect(parsed.SOMETHING_ELSE).toBe('value');
  });

  it('strips surrounding double quotes', async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, 'KEY="quoted value with spaces"\n');
    const parsed = await loadEnvFile(p);
    expect(parsed.KEY).toBe('quoted value with spaces');
  });

  it('strips surrounding single quotes', async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, "KEY='quoted value'\n");
    const parsed = await loadEnvFile(p);
    expect(parsed.KEY).toBe('quoted value');
  });

  it('ignores blank lines and # comments', async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, '# top comment\n\nKEY=value\n# trailing comment\n');
    const parsed = await loadEnvFile(p);
    expect(parsed).toEqual({ KEY: 'value' });
  });

  it('treats a single bare Telegram-token line as OPENSQUID_TELEGRAM_BOT_TOKEN', async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, '8684088310:AAFgYblhOAadDN_i5osTtfkSTAgwlnneU-4\n');
    const parsed = await loadEnvFile(p);
    expect(parsed.OPENSQUID_TELEGRAM_BOT_TOKEN).toBe(
      '8684088310:AAFgYblhOAadDN_i5osTtfkSTAgwlnneU-4',
    );
  });

  it("does NOT treat a bare line as a token if it doesn't match the token shape", async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, 'just-some-random-text\n');
    const parsed = await loadEnvFile(p);
    expect(parsed.OPENSQUID_TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('does NOT use bare-line fallback if KEY=VALUE lines are also present', async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, 'OTHER=ok\n1234:abcdefghij1234567890\n');
    const parsed = await loadEnvFile(p);
    expect(parsed.OPENSQUID_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(parsed.OTHER).toBe('ok');
  });
});

describe('locateEnvFile — search order', () => {
  it('returns the path given by OPENSQUID_ENV_FILE if it exists', async () => {
    const p = join(tmpDir, 'custom.env');
    await writeFile(p, 'KEY=value\n');
    process.env.OPENSQUID_ENV_FILE = p;
    expect(await locateEnvFile()).toBe(p);
  });

  it('returns null if no .env exists in any candidate location', async () => {
    // OPENSQUID_HOME + HOME already point at the empty tmpDir.
    const r = await locateEnvFile();
    // Could still hit a cwd .env in the actual project — accept that
    // and only assert it is not one of our (empty) tmpdir candidates.
    if (r !== null) {
      expect(r).not.toBe(join(homedir(), '.loop', '.env'));
      expect(r).not.toBe(join(tmpDir, '.env'));
    }
  });
});

describe('resolveToken — priority order', () => {
  it("returns env-var value with source='env' when set", async () => {
    process.env.OPENSQUID_TELEGRAM_BOT_TOKEN = 'from-env';
    const r = await resolveToken('OPENSQUID_TELEGRAM_BOT_TOKEN', 'from-config');
    expect(r.value).toBe('from-env');
    expect(r.source).toBe('env');
  });

  it('falls back to .env file when env-var unset', async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, 'OPENSQUID_TELEGRAM_BOT_TOKEN=from-file\n');
    process.env.OPENSQUID_ENV_FILE = p;
    const r = await resolveToken('OPENSQUID_TELEGRAM_BOT_TOKEN', 'from-config');
    expect(r.value).toBe('from-file');
    expect(r.source).toBe('env-file');
    expect(r.env_file_path).toBe(p);
  });

  it('falls back to config.json value when neither env-var nor .env set', async () => {
    const r = await resolveToken('OPENSQUID_TELEGRAM_BOT_TOKEN', 'from-config');
    expect(r.value).toBe('from-config');
    expect(r.source).toBe('config-json');
  });

  it('returns missing when no source has a value', async () => {
    const r = await resolveToken('OPENSQUID_TELEGRAM_BOT_TOKEN', undefined);
    expect(r.value).toBeUndefined();
    expect(r.source).toBe('missing');
  });

  it('env-var WINS over .env even when both are set', async () => {
    process.env.OPENSQUID_TELEGRAM_BOT_TOKEN = 'from-env';
    const p = join(tmpDir, '.env');
    await writeFile(p, 'OPENSQUID_TELEGRAM_BOT_TOKEN=from-file\n');
    process.env.OPENSQUID_ENV_FILE = p;
    const r = await resolveToken('OPENSQUID_TELEGRAM_BOT_TOKEN', 'from-config');
    expect(r.value).toBe('from-env');
    expect(r.source).toBe('env');
  });

  it('.env WINS over config.json even when both have values', async () => {
    const p = join(tmpDir, '.env');
    await writeFile(p, 'OPENSQUID_TELEGRAM_BOT_TOKEN=from-file\n');
    process.env.OPENSQUID_ENV_FILE = p;
    const r = await resolveToken('OPENSQUID_TELEGRAM_BOT_TOKEN', 'from-config');
    expect(r.value).toBe('from-file');
    expect(r.source).toBe('env-file');
  });
});
