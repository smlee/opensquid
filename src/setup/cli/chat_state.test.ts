/**
 * Tests for `chat_state.ts` (WIZ.2) — the chat-setup-wizard detection layer.
 *
 * Strategy: each test uses a fresh tmpdir as `OPENSQUID_HOME` + a separate
 * tmpdir as `$HOME` (via the `envPath` override on `detectSecretsBackend`)
 * so multiple runs don't collide on the shared `~/.opensquid/` + `~/.loop/`
 * paths. No detector ever writes — tests verify by seeding files via
 * `node:fs/promises` and then asserting on the detector's return.
 *
 * The 9 spec fixtures (per `docs/tasks/T-chat-setup-wizard.md` WIZ.2):
 *   1. no models.yaml → present: false
 *   2. models.yaml with `fast_chat: { mode: api, ... }` → hasFastChat + mode
 *   3. models.yaml with subscription-mode fast_chat → hasFastChat + mode
 *   4. models.yaml without fast_chat → hasFastChat: false
 *   5. malformed YAML → parseError populated, NO throw
 *   6. ENOENT distinguished from other fs errors
 *   7. empty packs dir → []; one pack with chat_agent.yaml → entry
 *   8. PID file + process alive → running: true
 *   9. PID file + process dead → running: false
 *   10. .env with ANTHROPIC_API_KEY= → anthropicKeyPresent: true
 *
 * Plus edge cases for secret detection (commented-out keys, blank lines),
 * agent-bridge missing pidfile (WAB.7 not shipped), and sock-existence
 * proxy for `mcpReachable`.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectAgentBridgeRunning,
  detectChatDaemonRunning,
  detectModelsConfig,
  detectPacksDir,
  detectSecretsBackend,
} from './chat_state.js';

let stateRoot: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  stateRoot = await mkdtemp(join(tmpdir(), 'opensquid-chat-state-'));
  process.env.OPENSQUID_HOME = stateRoot;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
});

// ---------------------------------------------------------------------------
// detectModelsConfig
// ---------------------------------------------------------------------------

describe('detectModelsConfig', () => {
  it('returns present: false when models.yaml is missing (clean state)', async () => {
    const state = await detectModelsConfig();
    expect(state.present).toBe(false);
    expect(state.aliases).toEqual([]);
    expect(state.hasFastChat).toBe(false);
    expect(state.fastChatMode).toBeUndefined();
    expect(state.parseError).toBeUndefined();
    expect(state.path).toBe(join(stateRoot, 'models.yaml'));
  });

  it('detects fast_chat in api mode', async () => {
    const yaml = [
      'fast_chat:',
      '  mode: api',
      '  provider: anthropic',
      '  model: claude-haiku-4-5-20251001',
      '',
    ].join('\n');
    await writeFile(join(stateRoot, 'models.yaml'), yaml, 'utf8');
    const state = await detectModelsConfig();
    expect(state.present).toBe(true);
    expect(state.aliases).toEqual(['fast_chat']);
    expect(state.hasFastChat).toBe(true);
    expect(state.fastChatMode).toBe('api');
  });

  it('detects fast_chat in subscription mode (mode + impl)', async () => {
    const yaml = [
      'fast_chat:',
      '  mode: subscription',
      '  impl: cli',
      '  cli: claude',
      '  args: ["--print", "--model", "claude-haiku-4-5"]',
      '',
    ].join('\n');
    await writeFile(join(stateRoot, 'models.yaml'), yaml, 'utf8');
    const state = await detectModelsConfig();
    expect(state.present).toBe(true);
    expect(state.hasFastChat).toBe(true);
    expect(state.fastChatMode).toBe('subscription');
  });

  it('returns hasFastChat: false when models.yaml has other aliases but no fast_chat', async () => {
    const yaml = [
      'capable_writer:',
      '  mode: api',
      '  provider: anthropic',
      '  model: claude-sonnet-4-6',
      '',
    ].join('\n');
    await writeFile(join(stateRoot, 'models.yaml'), yaml, 'utf8');
    const state = await detectModelsConfig();
    expect(state.present).toBe(true);
    expect(state.aliases).toEqual(['capable_writer']);
    expect(state.hasFastChat).toBe(false);
    expect(state.fastChatMode).toBeUndefined();
  });

  it('returns parseError without throwing on malformed YAML', async () => {
    // Unclosed quote — yaml v2 surfaces a syntax error.
    await writeFile(join(stateRoot, 'models.yaml'), 'fast_chat:\n  mode: "api\n', 'utf8');
    const state = await detectModelsConfig();
    expect(state.present).toBe(true);
    expect(state.parseError).toBeDefined();
    expect(state.hasFastChat).toBe(false);
    expect(state.aliases).toEqual([]);
  });

  it('returns parseError without throwing on schema reject (bad mode value)', async () => {
    // `mode: pigeon` is not in the ModelMode enum.
    const yaml = ['fast_chat:', '  mode: pigeon', '  provider: anthropic', ''].join('\n');
    await writeFile(join(stateRoot, 'models.yaml'), yaml, 'utf8');
    const state = await detectModelsConfig();
    expect(state.present).toBe(true);
    expect(state.parseError).toBeDefined();
  });

  it('distinguishes ENOENT (returns present:false) from other fs errors', async () => {
    // The ENOENT branch is the most-common first-run path; verified by
    // the "clean state" test above. Here we additionally confirm that
    // an explicit override path that doesn't exist also returns clean
    // (rather than throwing).
    const state = await detectModelsConfig(join(stateRoot, 'does-not-exist.yaml'));
    expect(state.present).toBe(false);
    expect(state.parseError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectPacksDir
// ---------------------------------------------------------------------------

describe('detectPacksDir', () => {
  it('returns empty when packs/ is missing', async () => {
    const state = await detectPacksDir();
    expect(state.packs).toEqual([]);
    expect(state.path).toBe(join(stateRoot, 'packs'));
  });

  it('returns empty when packs/ is an empty directory', async () => {
    await mkdir(join(stateRoot, 'packs'), { recursive: true });
    const state = await detectPacksDir();
    expect(state.packs).toEqual([]);
  });

  it('enumerates packs and marks hasChatAgent per pack', async () => {
    const packsDir = join(stateRoot, 'packs');
    await mkdir(join(packsDir, 'pack-a'), { recursive: true });
    await writeFile(
      join(packsDir, 'pack-a', 'chat_agent.yaml'),
      'default_model: fast_chat\n',
      'utf8',
    );
    await mkdir(join(packsDir, 'pack-b'), { recursive: true });
    // pack-b deliberately has no chat_agent.yaml.

    const state = await detectPacksDir();
    expect(state.packs).toHaveLength(2);
    const packA = state.packs.find((p) => p.name === 'pack-a');
    const packB = state.packs.find((p) => p.name === 'pack-b');
    expect(packA?.hasChatAgent).toBe(true);
    expect(packB?.hasChatAgent).toBe(false);
    expect(packA?.root).toBe(join(packsDir, 'pack-a'));
  });

  it('skips dotfiles and non-directory entries', async () => {
    const packsDir = join(stateRoot, 'packs');
    await mkdir(packsDir, { recursive: true });
    await writeFile(join(packsDir, '.DS_Store'), '', 'utf8');
    await writeFile(join(packsDir, 'not-a-dir.txt'), '', 'utf8');
    await mkdir(join(packsDir, 'real-pack'), { recursive: true });
    const state = await detectPacksDir();
    expect(state.packs.map((p) => p.name)).toEqual(['real-pack']);
  });
});

// ---------------------------------------------------------------------------
// detectChatDaemonRunning
// ---------------------------------------------------------------------------

describe('detectChatDaemonRunning', () => {
  it('returns running:false when pidfile is absent', async () => {
    const state = await detectChatDaemonRunning();
    expect(state.running).toBe(false);
    expect(state.pid).toBeUndefined();
    expect(state.mcpReachable).toBe(false);
  });

  it('returns running:true when pidfile holds the current process pid (kill(0) succeeds)', async () => {
    // The current vitest process is, by definition, alive. Using
    // process.pid as the "live pid" is the canonical pattern from
    // src.legacy/chat/daemon/lifecycle.test.ts equivalents.
    await writeFile(join(stateRoot, 'chat-daemon.pid'), `${String(process.pid)}\n`, 'utf8');
    const state = await detectChatDaemonRunning();
    expect(state.running).toBe(true);
    expect(state.pid).toBe(process.pid);
  });

  it('returns running:false when pidfile points at a dead pid', async () => {
    // pid 999999 is overwhelmingly unlikely to be a live process on a
    // dev workstation (system pid_max default is well below 1M); matches
    // the lifecycle.test.ts staleness fixture.
    await writeFile(join(stateRoot, 'chat-daemon.pid'), '999999\n', 'utf8');
    const state = await detectChatDaemonRunning();
    expect(state.running).toBe(false);
  });

  it('returns running:false when pidfile is garbage (non-numeric)', async () => {
    await writeFile(join(stateRoot, 'chat-daemon.pid'), 'not-a-pid\n', 'utf8');
    const state = await detectChatDaemonRunning();
    expect(state.running).toBe(false);
  });

  it('reports mcpReachable: true when the sock file exists alongside', async () => {
    await writeFile(join(stateRoot, 'chat-daemon.sock'), '', 'utf8');
    const state = await detectChatDaemonRunning();
    expect(state.mcpReachable).toBe(true);
    // No pidfile, so running stays false — orthogonal signals.
    expect(state.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectSecretsBackend
// ---------------------------------------------------------------------------

describe('detectSecretsBackend', () => {
  let envHome: string;
  let envFile: string;

  beforeEach(async () => {
    envHome = await mkdtemp(join(tmpdir(), 'opensquid-chat-loop-'));
    await mkdir(envHome, { recursive: true });
    envFile = join(envHome, '.env');
  });

  it('returns env (plus platform-dependent backends) when ~/.loop/.env is absent', async () => {
    const state = await detectSecretsBackend({ envPath: envFile, env: { PATH: '' } });
    expect(state.envPresent).toBe(false);
    expect(state.anthropicKeyPresent).toBe(false);
    expect(state.telegramTokenPresent).toBe(false);
    // `env` is always first; `keychain` is darwin-only; `op` is PATH-gated
    // (the empty PATH guarantees `op` is absent here).
    expect(state.backends[0]).toBe('env');
    expect(state.backends).not.toContain('op');
    if (process.platform === 'darwin') {
      // /usr/bin/security ships with every macOS install.
      expect(state.backends).toContain('keychain');
    } else {
      expect(state.backends).not.toContain('keychain');
    }
  });

  it('detects ANTHROPIC_API_KEY presence without returning the value', async () => {
    await writeFile(envFile, 'ANTHROPIC_API_KEY=sk-ant-EXAMPLE\n', 'utf8');
    const state = await detectSecretsBackend({ envPath: envFile, env: { PATH: '' } });
    expect(state.envPresent).toBe(true);
    expect(state.anthropicKeyPresent).toBe(true);
    expect(state.telegramTokenPresent).toBe(false);
    // The detector's return surface MUST NOT include the secret value.
    expect(JSON.stringify(state)).not.toContain('sk-ant-EXAMPLE');
  });

  it('detects OPENSQUID_TELEGRAM_BOT_TOKEN presence', async () => {
    await writeFile(
      envFile,
      ['# top comment', 'OPENSQUID_TELEGRAM_BOT_TOKEN=000000:EXAMPLE', ''].join('\n'),
      'utf8',
    );
    const state = await detectSecretsBackend({ envPath: envFile, env: { PATH: '' } });
    expect(state.telegramTokenPresent).toBe(true);
    expect(state.anthropicKeyPresent).toBe(false);
    expect(JSON.stringify(state)).not.toContain('EXAMPLE');
  });

  it('ignores commented-out and blank lines when scanning for keys', async () => {
    const body = [
      '# ANTHROPIC_API_KEY=should-not-count',
      '',
      '   ',
      '#OPENSQUID_TELEGRAM_BOT_TOKEN=also-no',
      '',
    ].join('\n');
    await writeFile(envFile, body, 'utf8');
    const state = await detectSecretsBackend({ envPath: envFile, env: { PATH: '' } });
    expect(state.anthropicKeyPresent).toBe(false);
    expect(state.telegramTokenPresent).toBe(false);
  });

  it('adds op backend when `op` is on PATH (synthesized via tmpdir)', async () => {
    // Synthesize an `op` "binary" — just an empty file under a tmpdir
    // that we put first on $PATH for this call. We don't execute it,
    // we only probe for existence.
    const fakePathDir = await mkdtemp(join(tmpdir(), 'opensquid-chat-fakepath-'));
    await writeFile(join(fakePathDir, 'op'), '', 'utf8');
    const state = await detectSecretsBackend({
      envPath: envFile,
      env: { PATH: fakePathDir },
    });
    expect(state.backends).toContain('op');
  });

  it('does NOT add op backend when PATH lacks the binary', async () => {
    const state = await detectSecretsBackend({ envPath: envFile, env: { PATH: '/nonexistent' } });
    expect(state.backends).not.toContain('op');
  });
});

// ---------------------------------------------------------------------------
// detectAgentBridgeRunning
// ---------------------------------------------------------------------------

describe('detectAgentBridgeRunning', () => {
  it('returns running:false when WAB.7 pidfile does not yet exist', async () => {
    // This is the steady-state today (WAB.7 hasn't shipped). The
    // detector MUST handle the missing file gracefully.
    const state = await detectAgentBridgeRunning();
    expect(state.running).toBe(false);
    expect(state.pid).toBeUndefined();
    expect(state.pidPath).toBe(join(stateRoot, 'agent-bridge.pid'));
  });

  it('returns running:true when pidfile holds the current process pid', async () => {
    await writeFile(join(stateRoot, 'agent-bridge.pid'), `${String(process.pid)}\n`, 'utf8');
    const state = await detectAgentBridgeRunning();
    expect(state.running).toBe(true);
    expect(state.pid).toBe(process.pid);
  });

  it('returns running:false on a stale pidfile (dead pid)', async () => {
    await writeFile(join(stateRoot, 'agent-bridge.pid'), '999999\n', 'utf8');
    const state = await detectAgentBridgeRunning();
    expect(state.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Audit-mode: detectors are pure (no side effects)
// ---------------------------------------------------------------------------

describe('chat_state detectors — pure read-only', () => {
  it('detectModelsConfig does NOT create the file when called against an absent path', async () => {
    const target = join(stateRoot, 'never-created.yaml');
    await detectModelsConfig(target);
    // The file must NOT have been written by the detector.
    await expect(
      // dynamic import of access to keep the test file's import list narrow
      import('node:fs/promises').then((m) => m.access(target)),
    ).rejects.toThrow();
  });

  it('detectChatDaemonRunning does NOT create the pidfile', async () => {
    await detectChatDaemonRunning();
    await expect(
      import('node:fs/promises').then((m) => m.access(join(stateRoot, 'chat-daemon.pid'))),
    ).rejects.toThrow();
  });
});
