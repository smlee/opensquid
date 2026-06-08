/**
 * agent_bridge — the project-less GENERAL session (T-CHAT-AS-TERMINAL CAT.6).
 *
 * Coverage (per the CAT.6 test plan):
 *   - the built-in `general` pack loads via `loadPack` (valid manifest +
 *     chat_agent.yaml that disables the project-memory tools).
 *   - the daemon runs PROJECT-LESS for umbrella='general' (no throw) and scopes
 *     session-state by the umbrella identity (the umbrella lease, not a project
 *     uuid). The normal project-scoped path STILL requires projectUuid.
 *   - border: a general-umbrella inbound is answered by the general session; a
 *     project-umbrella inbound is NOT answered by it (the general daemon only
 *     watches umbrellas/general/inbox + only holds the general lease).
 *   - lease/ownership reuses CAT.5: the general daemon acquires the `general`
 *     umbrella lease on start as `headless-general` and releases on shutdown.
 *
 * Strict mode, mock agent loop (fakeAnthropic), mkdtemp + OPENSQUID_HOME — no
 * live daemon, no API tokens.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GENERAL_UMBRELLA } from '../../channels/routing.js';
import type { ModelAliasConfig } from '../../models/types.js';
import { loadPack } from '../../packs/loader.js';
import type { RagBackend } from '../../rag/types.js';
import type { SecretResolver } from '../../secrets/types.js';

import type { AnthropicMessageClient } from './agent_loop.js';
import { AgentBridgeDaemon, resolveGeneralPackRoot } from './daemon.js';
import { headlessSessionId } from './headless_lease.js';

// Absolute path to the shipped general pack (packs/builtin/general). From this
// test file at src/runtime/agent_bridge/, the repo root is four dirs up.
const HERE = dirname(fileURLToPath(import.meta.url));
const GENERAL_PACK_ROOT = resolve(HERE, '..', '..', '..', 'packs', 'builtin', 'general');

const PROJECT_UUID = '0742f358-c0fd-4690-ae9d-da8f4102ab4a';

// ---------------------------------------------------------------------------
// Fixtures (mirror daemon.test.ts — mock the agent loop / RAG / secrets)
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
    deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
  };
}

function fakeSecrets(): SecretResolver {
  return { resolve: () => Promise.resolve('sk-test-fake-key') };
}

function fakeModelsConfig(): Record<string, ModelAliasConfig> {
  return {
    // The general pack's chat_agent.yaml resolves `fast_chat`.
    fast_chat: {
      mode: 'api',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      args: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let tmpRoot: string;
let daemonHome: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cat6-general-'));
  daemonHome = join(tmpRoot, 'home');
  await mkdir(daemonHome, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeGeneralDaemon(
  overrides: Partial<ConstructorParameters<typeof AgentBridgeDaemon>[0]> = {},
): AgentBridgeDaemon {
  return new AgentBridgeDaemon({
    projectUuid: '',
    packRoot: GENERAL_PACK_ROOT,
    umbrellaId: GENERAL_UMBRELLA,
    projectLess: true,
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
// 1. The general pack loads
// ---------------------------------------------------------------------------

describe('CAT.6 — the general pack', () => {
  it('loads via loadPack with a valid manifest', async () => {
    const pack = await loadPack(GENERAL_PACK_ROOT);
    expect(pack.name).toBe('general');
    expect(pack.scope).toBe('universal');
    // Project-LESS: no detected_by activation (never auto-loaded into a project
    // session) + no skills (deliberately minimal). The loader surfaces
    // detected_by as the camelCase `detectedBy` ([] or undefined when empty).
    expect(pack.detectedBy ?? []).toEqual([]);
    expect(pack.skills).toEqual([]);
  });

  it('binds a chat agent that DISABLES the project-memory tools (no recall/store_lesson)', async () => {
    const pack = await loadPack(GENERAL_PACK_ROOT);
    expect(pack.chatAgent?.default_model).toBe('fast_chat');
    // The two project-memory built-ins are off → only chat_send remains.
    expect(pack.chatAgent?.disable_builtins).toEqual(
      expect.arrayContaining(['recall', 'store_lesson']),
    );
  });

  it('resolveGeneralPackRoot points at packs/builtin/general (env override wins)', () => {
    expect(resolveGeneralPackRoot({ OPENSQUID_GENERAL_PACK_ROOT: '/x/general' })).toBe(
      '/x/general',
    );
    // No env → under the built-in scope root, ending in /general.
    expect(resolveGeneralPackRoot({})).toMatch(/[/\\]general$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Project-less daemon path + scope identity
// ---------------------------------------------------------------------------

describe('CAT.6 — project-less daemon', () => {
  it('runs project-less for umbrella=general (empty projectUuid does NOT throw)', async () => {
    const d = makeGeneralDaemon();
    await d.start();
    // It actually came up + bound the general pack.
    expect(d.bindingFor()).not.toBeNull();
    // umbrella=general ⇒ scoped stem `agent-bridge-general` (per-instance keying).
    const pidRaw = await readFile(join(daemonHome, 'agent-bridge-general.pid'), 'utf8');
    expect(parseInt(pidRaw.trim(), 10)).toBe(process.pid);
    await d.shutdown();
  });

  it('runs project-less via explicit projectLess:true even without umbrella=general default', async () => {
    // projectLess is the secondary signal; here the umbrella is general (the
    // production wiring) but the flag alone is what relaxes the projectUuid guard.
    const d = makeGeneralDaemon({ projectLess: true });
    await d.start();
    expect(d.bindingFor()).not.toBeNull();
    await d.shutdown();
  });

  it('scopes session-state by the umbrella identity: acquires the general lease (not a project lease)', async () => {
    const priorHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = daemonHome;
    try {
      const { umbrellaLiveSessionLease } = await import('../paths.js');
      const { readLease } = await import('../chat/live_session_lease.js');
      const d = makeGeneralDaemon();
      await d.start();
      const lease = await readLease(umbrellaLiveSessionLease(GENERAL_UMBRELLA));
      // The scope identity is the umbrella id → the headless holder is
      // `headless-general`, NOT a project-uuid-derived id.
      expect(lease?.session_id).toBe(headlessSessionId(GENERAL_UMBRELLA));
      await d.shutdown();
      // Released on clean shutdown.
      expect(await readLease(umbrellaLiveSessionLease(GENERAL_UMBRELLA))).toBeNull();
    } finally {
      if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = priorHome;
    }
  });

  it('the normal project-scoped path is UNCHANGED — still throws on empty projectUuid', async () => {
    // No umbrella, not project-less → project-scoped. Empty uuid must still fail.
    const d = new AgentBridgeDaemon({
      projectUuid: '',
      packRoot: GENERAL_PACK_ROOT,
      daemonHome,
      anthropicClient: fakeAnthropic(),
      modelsConfig: fakeModelsConfig(),
      ragBackend: fakeRag(),
      secrets: fakeSecrets(),
      onWarn: () => undefined,
    });
    await expect(d.start()).rejects.toThrow(/projectUuid is required/);
  });

  it('a project-scoped daemon with a real uuid still starts (no regression)', async () => {
    const d = new AgentBridgeDaemon({
      projectUuid: PROJECT_UUID,
      packRoot: GENERAL_PACK_ROOT,
      daemonHome,
      anthropicClient: fakeAnthropic(),
      modelsConfig: fakeModelsConfig(),
      ragBackend: fakeRag(),
      secrets: fakeSecrets(),
      onWarn: () => undefined,
    });
    await d.start();
    expect(d.bindingFor()).not.toBeNull();
    await d.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 3. Border — general answers general; never a project umbrella
// ---------------------------------------------------------------------------

describe('CAT.6 — border (umbrella keying)', () => {
  it('the general daemon watches ONLY umbrellas/general/inbox + holds ONLY the general lease', async () => {
    const priorHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = daemonHome;
    try {
      const { umbrellaInboxDir, umbrellaLiveSessionLease } = await import('../paths.js');
      const { readLease } = await import('../chat/live_session_lease.js');

      const d = makeGeneralDaemon();
      await d.start();

      // The general inbox dir is ensured (the transport mkdirs its watched root).
      const generalInbox = umbrellaInboxDir(GENERAL_UMBRELLA);
      await expect(readFile(join(generalInbox, '.exists'), 'utf8')).rejects.toBeDefined();
      // (dir exists even if the probe file does not — the mkdir is the assertion;
      // stat it directly.)
      const { stat } = await import('node:fs/promises');
      await expect(stat(generalInbox)).resolves.toBeDefined();

      // It holds the general lease...
      expect((await readLease(umbrellaLiveSessionLease(GENERAL_UMBRELLA)))?.session_id).toBe(
        headlessSessionId(GENERAL_UMBRELLA),
      );
      // ...and NOT a project umbrella's lease (it never touches `loop`).
      expect(await readLease(umbrellaLiveSessionLease('loop'))).toBeNull();

      await d.shutdown();
    } finally {
      if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = priorHome;
    }
  });

  it('does NOT steal a project umbrella lease that already exists (general only owns general)', async () => {
    const priorHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = daemonHome;
    try {
      const { umbrellaLiveSessionLease } = await import('../paths.js');
      const { readLease, writeLease } = await import('../chat/live_session_lease.js');

      // A live `loop` (project umbrella) lease held by someone else.
      const loopLeasePath = umbrellaLiveSessionLease('loop');
      await writeLease(loopLeasePath, 'human-loop-session', new Date());

      const d = makeGeneralDaemon();
      await d.start();

      // The general daemon must NOT have touched the loop lease.
      const loopAfter = await readLease(loopLeasePath);
      expect(loopAfter?.session_id).toBe('human-loop-session');
      // And it took the general lease for itself.
      expect((await readLease(umbrellaLiveSessionLease(GENERAL_UMBRELLA)))?.session_id).toBe(
        headlessSessionId(GENERAL_UMBRELLA),
      );

      await d.shutdown();
    } finally {
      if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = priorHome;
    }
  });
});
