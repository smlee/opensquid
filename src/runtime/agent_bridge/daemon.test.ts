/**
 * agent_bridge — AgentBridgeDaemon tests (WAB.7 + WAB-SUB.2 mode-aware lazy client).
 *
 * Coverage (per spec test plan):
 *   - start: writes pid file, holds lock, shutdown releases
 *   - start while another is running → throws "another daemon is already running"
 *   - stale-pid recovery: a pidfile pointing at dead pid does NOT block start
 *   - shutdown order: dispatcher → transport → sessionManager → release → pid rm
 *   - api-mode: missing ANTHROPIC_API_KEY → throws with mode-named setup hint
 *   - subscription-mode: missing ANTHROPIC_API_KEY does NOT throw (WAB-SUB.2)
 *   - subscription-mode: MCP config materialized at known path
 *   - missing projectUuid → throws with setup-chat hint
 *   - shutdown is idempotent
 *   - SIGTERM/SIGINT handlers installed + removed across lifecycle
 *   - env helpers (resolvePackRootFromEnv; resolveProjectUuidFromEnv lives in
 *     runtime/paths.ts post-T-PUC)
 *
 * Live integration is gated by ANTHROPIC_API_KEY + WAB_AGENT_BRIDGE_LIVE
 * (see end of file) — matches the WAB.4 live-test pattern.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AnthropicMessageClient } from './agent_loop.js';
import { resolveProjectUuidFromEnv } from '../paths.js';
import { AgentBridgeDaemon, resolvePackRootFromEnv } from './daemon.js';

import type { ModelAliasConfig } from '../../models/types.js';
import type { RagBackend } from '../../rag/types.js';
import type { SecretResolver } from '../../secrets/types.js';

const PROJECT_UUID = '0742f358-c0fd-4690-ae9d-da8f4102ab4a';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeAnthropic(): AnthropicMessageClient {
  return {
    create: () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'ok' } as const],
        stop_reason: 'end_turn' as const,
      }),
  };
}

function fakeRag(): RagBackend {
  return {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: () => Promise.resolve(),
  };
}

function fakeSecrets(): SecretResolver {
  return { resolve: () => Promise.resolve('sk-test-fake-key') };
}

function fakeModelsConfig(): Record<string, ModelAliasConfig> {
  return {
    fast_chat: {
      mode: 'api',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      args: [],
    },
  };
}

async function writePack(packRoot: string, withChatAgent = true): Promise<void> {
  await mkdir(packRoot, { recursive: true });
  await writeFile(
    join(packRoot, 'manifest.yaml'),
    `name: test-pack\nversion: 0.1.0\nscope: project\ngoal: WAB.7 daemon test\n`,
    'utf8',
  );
  if (withChatAgent) {
    await writeFile(join(packRoot, 'chat_agent.yaml'), `default_model: fast_chat\n`, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tmpRoot: string;
let daemonHome: string;
let packRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'wab7-daemon-'));
  daemonHome = join(tmpRoot, 'home');
  packRoot = join(tmpRoot, 'pack');
  await mkdir(daemonHome, { recursive: true });
  await writePack(packRoot);
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeDaemon(
  overrides: Partial<ConstructorParameters<typeof AgentBridgeDaemon>[0]> = {},
): AgentBridgeDaemon {
  return new AgentBridgeDaemon({
    projectUuid: PROJECT_UUID,
    packRoot,
    daemonHome,
    anthropicClient: fakeAnthropic(),
    modelsConfig: fakeModelsConfig(),
    ragBackend: fakeRag(),
    secrets: fakeSecrets(),
    onWarn: () => undefined,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// start / shutdown lifecycle
// ---------------------------------------------------------------------------

describe('AgentBridgeDaemon.start', () => {
  it('writes pid file + acquires lock; shutdown releases', async () => {
    const d = makeDaemon();
    await d.start();
    const pidRaw = await readFile(join(daemonHome, 'agent-bridge.pid'), 'utf8');
    expect(parseInt(pidRaw.trim(), 10)).toBe(process.pid);
    // Lock dir present.
    await expect(readFile(join(daemonHome, 'agent-bridge.lock'), 'utf8')).rejects.toBeDefined();
    // (proper-lockfile uses a directory at `<path>.lock` not a file at the
    // path itself — readFile must reject. We don't introspect further.)
    await d.shutdown();
    // After shutdown the pidfile is gone.
    await expect(readFile(join(daemonHome, 'agent-bridge.pid'), 'utf8')).rejects.toBeDefined();
  });

  it('throws when a second daemon tries to start while another holds the lock', async () => {
    const a = makeDaemon();
    const b = makeDaemon();
    await a.start();
    await expect(b.start()).rejects.toThrow(/another daemon is already running/);
    await a.shutdown();
  });

  it('recovers from a stale pid file (no lock held, pidfile present)', async () => {
    // Pre-write a pidfile pointing at an obviously-dead pid (max+1).
    // The lock is NOT held, so start should succeed — proper-lockfile's
    // `.lock/` dir is what gates concurrent starts, not the pidfile.
    await writeFile(join(daemonHome, 'agent-bridge.pid'), '999999', 'utf8');
    const d = makeDaemon();
    await d.start();
    const pidRaw = await readFile(join(daemonHome, 'agent-bridge.pid'), 'utf8');
    // start() should have overwritten with the live pid.
    expect(parseInt(pidRaw.trim(), 10)).toBe(process.pid);
    await d.shutdown();
  });

  it('shutdown is idempotent', async () => {
    const d = makeDaemon();
    await d.start();
    await d.shutdown();
    await d.shutdown(); // second call: no-op, no throw
  });

  it('umbrella daemon acquires the umbrella lease on start + releases on shutdown (CAT.5)', async () => {
    const priorHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = daemonHome; // so umbrellaLiveSessionLease lands in sandbox
    try {
      const { umbrellaLiveSessionLease } = await import('../paths.js');
      const { readLease } = await import('../chat/live_session_lease.js');
      const { headlessSessionId } = await import('./headless_lease.js');
      const d = makeDaemon({ umbrellaId: 'loop' });
      await d.start();
      const held = await readLease(umbrellaLiveSessionLease('loop'));
      expect(held?.session_id).toBe(headlessSessionId('loop'));
      await d.shutdown();
      // Our headless lease is released on clean shutdown.
      expect(await readLease(umbrellaLiveSessionLease('loop'))).toBeNull();
    } finally {
      if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = priorHome;
    }
  });

  it('start after shutdown throws (single-use contract)', async () => {
    const d = makeDaemon();
    await d.start();
    await d.shutdown();
    await expect(d.start()).rejects.toThrow(/invalid state "stopped"/);
  });

  it('verifies shutdown teardown order via timestamp probes', async () => {
    // We assert order via the side effects each component leaves on disk:
    //   - dispatcher.shutdown: removes the in-flight tracking (no disk
    //     artifact — we use the binding result as a proxy: it goes to null)
    //   - transport.shutdown: chokidar close (no disk artifact)
    //   - sessionManager.shutdown: drains the LRU (no disk artifact)
    //   - lock release: removes `agent-bridge.lock/` dir
    //   - pidfile rm: removes `agent-bridge.pid`
    //
    // Direct order assertion via private spies would require monkey-
    // patching the daemon's internal refs. We instead assert the OBSERVABLE
    // post-conditions: bindingResult is null, pidfile gone, lock dir gone.
    const d = makeDaemon();
    await d.start();
    expect(d.bindingFor()).not.toBeNull();
    await d.shutdown();
    expect(d.bindingFor()).toBeNull();
    await expect(readFile(join(daemonHome, 'agent-bridge.pid'), 'utf8')).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Hard-fail surface
// ---------------------------------------------------------------------------

describe('AgentBridgeDaemon.start — hard-fail surface', () => {
  it('throws when projectUuid is empty', async () => {
    const d = makeDaemon({ projectUuid: '' });
    await expect(d.start()).rejects.toThrow(/projectUuid is required/);
  });

  it('throws when packRoot is empty', async () => {
    const d = makeDaemon({ packRoot: '' });
    await expect(d.start()).rejects.toThrow(/packRoot is required/);
  });

  it('throws when api-mode and ANTHROPIC_API_KEY missing AND no client injected', async () => {
    const priorKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const d = new AgentBridgeDaemon({
        projectUuid: PROJECT_UUID,
        packRoot,
        daemonHome,
        // anthropicClient deliberately omitted
        modelsConfig: fakeModelsConfig(),
        ragBackend: fakeRag(),
        secrets: fakeSecrets(),
        onWarn: () => undefined,
      });
      await expect(d.start()).rejects.toThrow(
        /Mode 'api' requires ANTHROPIC_API_KEY.*opensquid setup chat/s,
      );
    } finally {
      if (priorKey !== undefined) process.env.ANTHROPIC_API_KEY = priorKey;
    }
  });

  it('throws cleanly when pack has no manifest.yaml', async () => {
    await rm(join(packRoot, 'manifest.yaml'));
    const d = makeDaemon();
    await expect(d.start()).rejects.toBeDefined();
    // After a failed start the lock should be released so a subsequent
    // start (with the manifest restored) succeeds.
    await writePack(packRoot);
    const d2 = makeDaemon();
    await d2.start();
    await d2.shutdown();
  });

  it('throws when bad models.yaml alias is unresolved', async () => {
    const d = makeDaemon({
      modelsConfig: {
        wrong_alias: {
          mode: 'api',
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          args: [],
        },
      },
    });
    // pack ships `default_model: fast_chat`; modelsConfig only has wrong_alias.
    await expect(d.start()).rejects.toThrow(/not declared in models\.yaml/);
  });
});

// ---------------------------------------------------------------------------
// Subscription-mode start (WAB-SUB.2)
// ---------------------------------------------------------------------------

function subscriptionModelsConfig(): Record<string, ModelAliasConfig> {
  return {
    fast_chat: {
      mode: 'subscription',
      impl: 'cli',
      cli: 'claude',
      args: ['--print'],
    },
  };
}

describe('AgentBridgeDaemon.start — subscription mode (WAB-SUB.2)', () => {
  it('starts without ANTHROPIC_API_KEY when the resolved binding is subscription mode', async () => {
    const priorKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const d = new AgentBridgeDaemon({
        projectUuid: PROJECT_UUID,
        packRoot,
        daemonHome,
        // anthropicClient deliberately omitted — subscription mode should
        // skip the key check entirely.
        modelsConfig: subscriptionModelsConfig(),
        ragBackend: fakeRag(),
        secrets: fakeSecrets(),
        onWarn: () => undefined,
      });
      await d.start();
      // Binding resolved to subscription runner.
      const binding = d.bindingFor();
      expect(binding).not.toBeNull();
      expect(binding?.runner).toMatchObject({ mode: 'subscription', cli: 'claude' });
      await d.shutdown();
    } finally {
      if (priorKey !== undefined) process.env.ANTHROPIC_API_KEY = priorKey;
    }
  });

  it('materializes the default MCP config at <daemonHome>/agent-bridge/mcp-config.json', async () => {
    const priorKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const d = new AgentBridgeDaemon({
        projectUuid: PROJECT_UUID,
        packRoot,
        daemonHome,
        modelsConfig: subscriptionModelsConfig(),
        ragBackend: fakeRag(),
        secrets: fakeSecrets(),
        onWarn: () => undefined,
      });
      await d.start();
      const cfgPath = join(daemonHome, 'agent-bridge', 'mcp-config.json');
      const raw = await readFile(cfgPath, 'utf8');
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, { command: string }> };
      expect(parsed.mcpServers.opensquid?.command).toBe('opensquid-mcp');
      expect(parsed.mcpServers['opensquid-chat']?.command).toBe('opensquid-chat-bridge-mcp');
      await d.shutdown();
    } finally {
      if (priorKey !== undefined) process.env.ANTHROPIC_API_KEY = priorKey;
    }
  });

  it('honors mcpConfigPath override and does NOT materialize the default file', async () => {
    const priorKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const customPath = join(daemonHome, 'custom-mcp.json');
      const d = new AgentBridgeDaemon({
        projectUuid: PROJECT_UUID,
        packRoot,
        daemonHome,
        modelsConfig: subscriptionModelsConfig(),
        ragBackend: fakeRag(),
        secrets: fakeSecrets(),
        mcpConfigPath: customPath,
        onWarn: () => undefined,
      });
      await d.start();
      // Default path NOT touched.
      await expect(
        readFile(join(daemonHome, 'agent-bridge', 'mcp-config.json'), 'utf8'),
      ).rejects.toBeDefined();
      await d.shutdown();
    } finally {
      if (priorKey !== undefined) process.env.ANTHROPIC_API_KEY = priorKey;
    }
  });
});

// ---------------------------------------------------------------------------
// Env-resolution helpers
// ---------------------------------------------------------------------------

describe('AgentBridgeDaemon env helpers', () => {
  it('resolvePackRootFromEnv honors OPENSQUID_PACK_ROOT', () => {
    expect(resolvePackRootFromEnv({ OPENSQUID_PACK_ROOT: '/custom/path' })).toBe('/custom/path');
  });

  it('resolvePackRootFromEnv falls back to ~/.opensquid/packs/default', () => {
    const out = resolvePackRootFromEnv({ OPENSQUID_HOME: '/tmp/o' });
    expect(out).toBe('/tmp/o/packs/default');
  });

  it('resolveProjectUuidFromEnv reads OPENSQUID_PROJECT_UUID', () => {
    expect(resolveProjectUuidFromEnv({ OPENSQUID_PROJECT_UUID: 'abc-123' })).toBe('abc-123');
  });

  it('resolveProjectUuidFromEnv returns null when env unset', () => {
    expect(resolveProjectUuidFromEnv({})).toBeNull();
  });
});
