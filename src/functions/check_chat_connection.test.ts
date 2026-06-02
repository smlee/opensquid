/**
 * Tests for the `check_chat_connection` primitive (T-HANDOFF-HARDENING HH6.2;
 * re-keyed to UMBRELLA in T-CHAT-AS-TERMINAL CAT.1c).
 *
 * Covers:
 *   - opt-out (chat.session_start_check: "off") → null
 *   - telegram configured (channels.json umbrella) + fresh chat-watch lease →
 *     '✅' + 'lease held'
 *   - telegram configured + no lease → 'NOT running'
 *   - no chat wired (umbrella with no telegram) → 'opensquid setup' nudge
 *   - cwd resolves to no umbrella → 'umbrella not resolved' nudge
 *
 * Isolated OPENSQUID_HOME (tmpdir) per test. The cwd→umbrella binding is wired
 * via a channels.json `members` prefix matching the injected `cwd`. No network,
 * no real config.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeLease } from '../runtime/chat/live_session_lease.js';
import { umbrellaLiveSessionLease } from '../runtime/paths.js';
import type { Event } from '../runtime/types.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { registerCheckChatConnectionFunction } from './check_chat_connection.js';

let home: string;
const CWD = '/workspace/loop';
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-ccc-test-'));
  process.env.OPENSQUID_HOME = home;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
});

const ev: Event = { kind: 'session_start', source: 'startup' };
const makeCtx = (event: Event = ev): EvalCtx => ({
  event,
  bindings: new Map<string, unknown>(),
  sessionId: 'test-session',
  packId: 'test-pack',
});

function registry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerCheckChatConnectionFunction(r);
  return r;
}

async function writeConfig(config: unknown): Promise<void> {
  await writeFile(join(home, 'config.json'), JSON.stringify(config), 'utf8');
}

async function writeChannels(config: unknown): Promise<void> {
  await writeFile(join(home, 'channels.json'), JSON.stringify(config), 'utf8');
}

async function seedUmbrellaLease(umbrellaId: string): Promise<void> {
  const path = umbrellaLiveSessionLease(umbrellaId);
  await mkdir(dirname(path), { recursive: true });
  await writeLease(path, 'test-session'); // fresh lease
}

/** Call the function with `cwd: CWD` (so umbrella resolution is deterministic). */
async function call(cwd: string = CWD): Promise<unknown> {
  const r = await registry().call('check_chat_connection', { cwd }, makeCtx());
  if (!r.ok) throw new Error('unexpected err result');
  return r.value;
}

describe('check_chat_connection', () => {
  it('returns null when the opt-out (chat.session_start_check: "off") is set', async () => {
    await writeConfig({ chat: { session_start_check: 'off' } });
    expect(await call()).toBeNull();
  });

  it('reports ✅ + lease held when telegram is configured and chat watch holds the lease', async () => {
    await writeConfig({ chat_connections: { telegram: { bot_token: 'tok' } } });
    await writeChannels({
      v: 1,
      umbrellas: [{ id: 'loop', members: [CWD], telegram: { chat_id: '-100', topic_id: 15 } }],
    });
    await seedUmbrellaLease('loop');

    const v = (await call()) as { kind: string; content: string };
    expect(v.kind).toBe('inject_context');
    expect(v.content).toContain('✅');
    expect(v.content).toContain('topic 15');
    expect(v.content).toContain('lease held');
  });

  it('reports "NOT running" when telegram is configured but no lease is held', async () => {
    await writeConfig({ chat_connections: { telegram: { bot_token: 'tok' } } });
    await writeChannels({
      v: 1,
      umbrellas: [{ id: 'loop', members: [CWD], telegram: { chat_id: '-100', topic_id: 15 } }],
    });

    const v = (await call()) as { content: string };
    expect(v.content).toContain('NOT running');
  });

  it('nudges `opensquid setup` when the umbrella has no telegram binding', async () => {
    await writeConfig({});
    await writeChannels({ v: 1, umbrellas: [{ id: 'loop', members: [CWD] }] });

    const v = (await call()) as { content: string };
    expect(v.content).toContain('opensquid setup');
  });

  it('nudges when the cwd resolves to no umbrella', async () => {
    await writeConfig({});
    await writeChannels({ v: 1, umbrellas: [{ id: 'other', members: ['/somewhere/else'] }] });

    const v = (await call()) as { content: string };
    expect(v.content).toContain('umbrella not resolved');
  });

  it('nudges when channels.json is absent (pre-CAT.1d cutover)', async () => {
    await writeConfig({});
    // no channels.json written → loadChannelsConfig returns null

    const v = (await call()) as { content: string };
    expect(v.content).toContain('umbrella not resolved');
  });
});
