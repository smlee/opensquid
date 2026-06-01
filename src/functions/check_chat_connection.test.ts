/**
 * Tests for the `check_chat_connection` primitive (T-HANDOFF-HARDENING HH6.2).
 *
 * Covers the spec's "Test fixtures":
 *   - opt-out (chat.session_start_check: "off") → null
 *   - telegram configured + fresh chat-watch lease → '✅' + 'lease held'
 *   - telegram configured + no lease → 'NOT running'
 *   - no chat wired → 'opensquid setup' nudge
 *   - generic umbrella drift (2 projects, same dest, differing inbound) → flagged
 *   - no drift (single project) → no drift line
 *   - project not resolved → 'project not resolved' nudge
 *
 * Isolated OPENSQUID_HOME (tmpdir) per test; OPENSQUID_PROJECT_UUID forces
 * project resolution (env-first in resolveProjectUuid). No network, no real
 * config.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeLease } from '../runtime/chat/live_session_lease.js';
import type { Event } from '../runtime/types.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { registerCheckChatConnectionFunction } from './check_chat_connection.js';

let home: string;
let priorHome: string | undefined;
let priorUuid: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorUuid = process.env.OPENSQUID_PROJECT_UUID;
  home = await mkdtemp(join(tmpdir(), 'opensquid-ccc-test-'));
  process.env.OPENSQUID_HOME = home;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorUuid === undefined) delete process.env.OPENSQUID_PROJECT_UUID;
  else process.env.OPENSQUID_PROJECT_UUID = priorUuid;
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

async function writeRouting(uuid: string, routing: unknown): Promise<void> {
  const dir = join(home, 'projects', uuid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'chat-routing.json'), JSON.stringify(routing), 'utf8');
}

async function call(): Promise<unknown> {
  const r = await registry().call('check_chat_connection', {}, makeCtx());
  if (!r.ok) throw new Error('unexpected err result');
  return r.value;
}

describe('check_chat_connection', () => {
  it('returns null when the opt-out (chat.session_start_check: "off") is set', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'u1';
    await writeConfig({ chat: { session_start_check: 'off' } });
    expect(await call()).toBeNull();
  });

  it('reports ✅ + lease held when telegram is configured and chat watch holds the lease', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'u1';
    await writeConfig({ chat_connections: { telegram: { bot_token: 'tok' } } });
    await writeRouting('u1', {
      telegram: { report_channel: 'telegram:-100', report_topic_id: 15 },
    });
    await writeLease('u1', 'test-session'); // fresh lease

    const v = (await call()) as { kind: string; content: string };
    expect(v.kind).toBe('inject_context');
    expect(v.content).toContain('✅');
    expect(v.content).toContain('topic 15');
    expect(v.content).toContain('lease held');
  });

  it('reports "NOT running" when telegram is configured but no lease is held', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'u1';
    await writeConfig({ chat_connections: { telegram: { bot_token: 'tok' } } });
    await writeRouting('u1', {
      telegram: { report_channel: 'telegram:-100', report_topic_id: 15 },
    });

    const v = (await call()) as { content: string };
    expect(v.content).toContain('NOT running');
  });

  it('nudges `opensquid setup` when no chat is wired', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'u1';
    await writeConfig({});
    await writeRouting('u1', {}); // no telegram block

    const v = (await call()) as { content: string };
    expect(v.content).toContain('opensquid setup');
  });

  it('flags generic umbrella drift when projects sharing a destination have inconsistent inbound', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'u1';
    await writeConfig({ chat_connections: { telegram: { bot_token: 'tok' } } });
    // u1 + u2 share telegram:-100 topic 15 but differ on inbound config.
    await writeRouting('u1', {
      telegram: {
        report_channel: 'telegram:-100',
        report_topic_id: 15,
        inbound_chat_ids: ['-100'],
        inbound_topic_ids: [15],
      },
    });
    await writeRouting('u2', {
      telegram: { report_channel: 'telegram:-100', report_topic_id: 15 },
    });

    const v = (await call()) as { content: string };
    expect(v.content).toContain('Umbrella routing drift');
  });

  it('does NOT flag drift when a single project owns its destination', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'u1';
    await writeConfig({ chat_connections: { telegram: { bot_token: 'tok' } } });
    await writeRouting('u1', {
      telegram: { report_channel: 'telegram:-100', report_topic_id: 15, inbound_topic_ids: [15] },
    });

    const v = (await call()) as { content: string };
    expect(v.content).not.toContain('Umbrella routing drift');
  });

  it('nudges when the project cannot be resolved', async () => {
    delete process.env.OPENSQUID_PROJECT_UUID; // force cwd-walk, which fails in tmp
    await writeConfig({});
    const r = await registry().call(
      'check_chat_connection',
      { cwd: home }, // a dir with no .opensquid/project.json ancestor
      makeCtx(),
    );
    if (!r.ok) throw new Error('unexpected err result');
    const v = r.value as { content: string };
    expect(v.content).toContain('project not resolved');
  });
});
