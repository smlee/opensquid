/**
 * CAT.1b — unit tests for the ported chat-config loader.
 *
 * Mirrors the inbox.test.ts isolation style: each test gets a fresh
 * `mkdtemp` pointed at by `OPENSQUID_HOME`, so reads/writes of
 * `<home>/config.json` never touch the developer's real home.
 *
 * Coverage:
 *   - loadChatConfig: absent file → {}; reads chat_connections block
 *   - env-token overlay priority (env > .env > config.json) via
 *     loadChatConfigWithSources source attribution
 *   - saveChatConfig round-trips + preserves unknown top-level keys
 *   - setPlatformConfig / forgetPlatformConfig
 *   - validateChatConfig + configuredPlatforms (pure functions)
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configuredPlatforms,
  forgetPlatformConfig,
  loadChatConfig,
  loadChatConfigWithSources,
  overlayEnvTokens,
  saveChatConfig,
  setPlatformConfig,
  validateChatConfig,
  type ChatConnectionsConfig,
} from './config.js';
import { _clearEnvFileCache } from './env-token.js';

let tempHome: string;
let priorHome: string | undefined;
let priorEnvFile: string | undefined;
let priorTgToken: string | undefined;

const TG_TOKEN = '123456:ABCdef_ghi-jklmnopqrstuvwxyz0123456789';

async function writeHostConfig(obj: unknown): Promise<void> {
  await writeFile(join(tempHome, 'config.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorEnvFile = process.env.OPENSQUID_ENV_FILE;
  priorTgToken = process.env.OPENSQUID_TELEGRAM_BOT_TOKEN;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cat1b-config-'));
  process.env.OPENSQUID_HOME = tempHome;
  await mkdir(tempHome, { recursive: true });
  // Isolate token resolution from the developer's REAL env / .env files.
  // env-token's locateEnvFile probes OPENSQUID_ENV_FILE first, then falls
  // back to ~/.loop/.env, ~/.opensquid/.env, <cwd>/.env. Pointing the env
  // var at an EXISTING empty file in tempHome short-circuits the fallbacks
  // (first existing candidate wins) so a real ~/.loop/.env can't leak in.
  const emptyEnv = join(tempHome, 'empty.env');
  await writeFile(emptyEnv, '', 'utf8');
  process.env.OPENSQUID_ENV_FILE = emptyEnv;
  delete process.env.OPENSQUID_TELEGRAM_BOT_TOKEN;
  _clearEnvFileCache();
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorEnvFile === undefined) delete process.env.OPENSQUID_ENV_FILE;
  else process.env.OPENSQUID_ENV_FILE = priorEnvFile;
  if (priorTgToken === undefined) delete process.env.OPENSQUID_TELEGRAM_BOT_TOKEN;
  else process.env.OPENSQUID_TELEGRAM_BOT_TOKEN = priorTgToken;
  await rm(tempHome, { recursive: true, force: true });
  _clearEnvFileCache();
});

describe('loadChatConfig', () => {
  it('absent config.json → empty connections', async () => {
    const cfg = await loadChatConfig();
    expect(cfg).toEqual({});
  });

  it('reads the chat_connections block from config.json', async () => {
    await writeHostConfig({
      version: 1,
      chat_connections: { telegram: { bot_token: TG_TOKEN, allowlist_chat_ids: ['42'] } },
    });
    const cfg = await loadChatConfig();
    expect(cfg.telegram?.bot_token).toBe(TG_TOKEN);
    expect(cfg.telegram?.allowlist_chat_ids).toEqual(['42']);
  });

  it('malformed config.json → empty connections (resilient)', async () => {
    await writeFile(join(tempHome, 'config.json'), '{not json', 'utf8');
    expect(await loadChatConfig()).toEqual({});
  });
});

describe('env-token overlay priority', () => {
  it('process.env wins over config.json (source: env)', async () => {
    await writeHostConfig({
      version: 1,
      chat_connections: { telegram: { bot_token: 'from-config', allowlist_chat_ids: ['7'] } },
    });
    process.env.OPENSQUID_TELEGRAM_BOT_TOKEN = TG_TOKEN;
    const { config, sources } = await loadChatConfigWithSources();
    expect(config.telegram?.bot_token).toBe(TG_TOKEN);
    // allowlist from config.json is preserved through the overlay
    expect(config.telegram?.allowlist_chat_ids).toEqual(['7']);
    expect(sources.telegram).toBe('env');
  });

  it('.env file wins over config.json when env-var absent (source: env-file)', async () => {
    await writeHostConfig({
      version: 1,
      chat_connections: { telegram: { bot_token: 'from-config' } },
    });
    const envFile = join(tempHome, 'my.env');
    await writeFile(envFile, `OPENSQUID_TELEGRAM_BOT_TOKEN=${TG_TOKEN}\n`, 'utf8');
    process.env.OPENSQUID_ENV_FILE = envFile;
    _clearEnvFileCache();
    const { config, sources } = await loadChatConfigWithSources();
    expect(config.telegram?.bot_token).toBe(TG_TOKEN);
    expect(sources.telegram).toBe('env-file');
    expect(sources.env_file_path).toBe(envFile);
  });

  it('falls back to config.json token when nothing in env (source: config-json)', async () => {
    await writeHostConfig({
      version: 1,
      chat_connections: { telegram: { bot_token: TG_TOKEN } },
    });
    const { sources } = await loadChatConfigWithSources();
    expect(sources.telegram).toBe('config-json');
  });
});

describe('overlayEnvTokens (no disk read)', () => {
  it('returns base unchanged when no env tokens present', async () => {
    const base: ChatConnectionsConfig = { telegram: { bot_token: TG_TOKEN } };
    const out = await overlayEnvTokens(base);
    expect(out.telegram?.bot_token).toBe(TG_TOKEN);
  });

  it('synthesizes a slack block from env app+bot tokens', async () => {
    process.env.OPENSQUID_SLACK_BOT_TOKEN = 'xoxb-abc';
    process.env.OPENSQUID_SLACK_APP_TOKEN = 'xapp-def';
    try {
      const out = await overlayEnvTokens({});
      expect(out.slack?.bot_token).toBe('xoxb-abc');
      expect(out.slack?.app_token).toBe('xapp-def');
    } finally {
      delete process.env.OPENSQUID_SLACK_BOT_TOKEN;
      delete process.env.OPENSQUID_SLACK_APP_TOKEN;
    }
  });
});

describe('saveChatConfig round-trip + unknown-key preservation', () => {
  it('persists and re-reads connections', async () => {
    await saveChatConfig({ telegram: { bot_token: TG_TOKEN } });
    expect((await loadChatConfig()).telegram?.bot_token).toBe(TG_TOKEN);
  });

  it('preserves unrelated top-level keys (e.g. a foreign field)', async () => {
    await writeHostConfig({ version: 1, foreign_key: '/some/foreign/value' });
    await saveChatConfig({ telegram: { bot_token: TG_TOKEN } });
    const raw = JSON.parse(await readFile(join(tempHome, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw.foreign_key).toBe('/some/foreign/value');
    expect((raw.chat_connections as ChatConnectionsConfig).telegram?.bot_token).toBe(TG_TOKEN);
  });
});

describe('setPlatformConfig / forgetPlatformConfig', () => {
  it('sets then forgets a platform block', async () => {
    await setPlatformConfig('discord', { bot_token: 'dtoken' });
    expect((await loadChatConfig()).discord?.bot_token).toBe('dtoken');
    await forgetPlatformConfig('discord');
    expect((await loadChatConfig()).discord).toBeUndefined();
  });
});

describe('validateChatConfig', () => {
  it('flags malformed telegram token', () => {
    const issues = validateChatConfig({ telegram: { bot_token: 'not-a-token' } });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.platform).toBe('telegram');
    expect(issues[0]?.field).toBe('bot_token');
  });

  it('flags slack tokens with wrong prefixes', () => {
    const issues = validateChatConfig({ slack: { bot_token: 'nope', app_token: 'also-nope' } });
    expect(issues.map((i) => i.field).sort()).toEqual(['app_token', 'bot_token']);
  });

  it('valid config yields no issues', () => {
    const issues = validateChatConfig({
      telegram: { bot_token: TG_TOKEN },
      slack: { bot_token: 'xoxb-ok', app_token: 'xapp-ok' },
    });
    expect(issues).toEqual([]);
  });
});

describe('configuredPlatforms', () => {
  it('lists only present platform blocks', () => {
    expect(configuredPlatforms({})).toEqual([]);
    expect(
      configuredPlatforms({
        telegram: { bot_token: TG_TOKEN },
        slack: { bot_token: 'xoxb-ok', app_token: 'xapp-ok' },
      }),
    ).toEqual(['telegram', 'slack']);
  });
});
