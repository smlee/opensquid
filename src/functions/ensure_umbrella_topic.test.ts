/**
 * Tests for the `ensure_umbrella_topic` primitive (T-CHAT-AS-TERMINAL CAT.7 —
 * SessionStart topic assurance, umbrella-level ≤1 topic).
 *
 * Covers the assurance FSM end-to-end against an isolated OPENSQUID_HOME
 * (tmpdir) with the create_topic RPC + the daemon-running gate INJECTED — no
 * socket, no Telegram, build+unit only:
 *
 *   - umbrella already has topic_id            → no-op (no RPC, config untouched)
 *   - chat_id but no topic_id + daemon running  → creates ONE topic, writes
 *     topic_id back to channels.json; a SECOND run is a no-op (idempotent)
 *   - two member cwds of one umbrella           → only ONE topic ever created
 *     (the "opensquid-cwd never creates a 2nd topic" acceptance)
 *   - no daemon running                         → no-op (no RPC)
 *   - cwd in no umbrella                         → no-op (no RPC)
 *   - cwd in an umbrella with NO telegram binding → no-op (no RPC)
 *   - fail-quiet on RPC error                    → ok(null), config untouched
 *
 * The cwd→umbrella binding is wired via a channels.json `members` prefix that
 * matches the injected `cwd`. The write-back is asserted by re-reading
 * channels.json off the tmpdir.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelsConfig } from '../channels/routing.js';
import type { Event } from '../runtime/types.js';

import {
  type CreateTopicFn,
  type DaemonRunningFn,
  type EnsureUmbrellaTopicDeps,
  registerEnsureUmbrellaTopicFunction,
} from './ensure_umbrella_topic.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

let home: string;
let priorHome: string | undefined;

const LOOP_CWD = '/workspace/loop';
const OPENSQUID_CWD = '/workspace/opensquid';

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-eut-test-'));
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

function registry(deps: EnsureUmbrellaTopicDeps): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEnsureUmbrellaTopicFunction(r, deps);
  return r;
}

async function writeChannels(config: ChannelsConfig): Promise<void> {
  await writeFile(join(home, 'channels.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

async function readChannels(): Promise<ChannelsConfig> {
  return JSON.parse(await readFile(join(home, 'channels.json'), 'utf8')) as ChannelsConfig;
}

/** Daemon-running stub: always live. */
const daemonUp: DaemonRunningFn = () => Promise.resolve(true);
/** Daemon-running stub: never live. */
const daemonDown: DaemonRunningFn = () => Promise.resolve(false);

/** Call `ensure_umbrella_topic` with an explicit cwd; assert ok. */
async function call(r: FunctionRegistry, cwd: string): Promise<unknown> {
  const res = await r.call('ensure_umbrella_topic', { cwd }, makeCtx());
  if (!res.ok) throw new Error('unexpected err result');
  return res.value;
}

describe('ensure_umbrella_topic (CAT.7)', () => {
  it('no-ops (no RPC) when the umbrella already has a topic_id', async () => {
    await writeChannels({
      v: 1,
      umbrellas: [{ id: 'loop', members: [LOOP_CWD], telegram: { chat_id: '-100', topic_id: 15 } }],
    });
    const createTopic = vi.fn<CreateTopicFn>();
    const r = registry({ createTopic, daemonRunning: daemonUp });

    expect(await call(r, LOOP_CWD)).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
    // config untouched
    expect((await readChannels()).umbrellas[0]!.telegram?.topic_id).toBe(15);
  });

  it('creates ONE topic + writes topic_id back when chat_id is present but topic_id is absent, daemon up; a second run is a no-op', async () => {
    await writeChannels({
      v: 1,
      umbrellas: [{ id: 'loop', members: [LOOP_CWD], telegram: { chat_id: '-100' } }],
    });
    const createTopic = vi.fn<CreateTopicFn>(() =>
      Promise.resolve({ message_thread_id: 42, name: 'opensquid: loop' }),
    );
    const r = registry({ createTopic, daemonRunning: daemonUp });

    // First run: creates the one topic + persists.
    expect(await call(r, LOOP_CWD)).toBeNull();
    expect(createTopic).toHaveBeenCalledTimes(1);
    expect(createTopic).toHaveBeenCalledWith({ chatId: '-100', name: 'opensquid: loop' });
    expect((await readChannels()).umbrellas[0]!.telegram?.topic_id).toBe(42);

    // Second run: topic_id now set → no-op, no further RPC, value unchanged.
    expect(await call(r, LOOP_CWD)).toBeNull();
    expect(createTopic).toHaveBeenCalledTimes(1);
    expect((await readChannels()).umbrellas[0]!.telegram?.topic_id).toBe(42);
  });

  it('two member cwds of ONE umbrella → only ONE topic ever created (opensquid-cwd never creates a 2nd)', async () => {
    // loop + opensquid are BOTH members of the SAME umbrella row.
    await writeChannels({
      v: 1,
      umbrellas: [
        { id: 'loop', members: [LOOP_CWD, OPENSQUID_CWD], telegram: { chat_id: '-100' } },
      ],
    });
    const createTopic = vi.fn<CreateTopicFn>(() =>
      Promise.resolve({ message_thread_id: 15, name: 'opensquid: loop' }),
    );
    const r = registry({ createTopic, daemonRunning: daemonUp });

    // Session A boots in the loop cwd → creates topic 15.
    expect(await call(r, LOOP_CWD)).toBeNull();
    // Session B boots in the opensquid cwd → resolves to the SAME loop umbrella
    // row, sees topic_id already set → NO second topic.
    expect(await call(r, OPENSQUID_CWD)).toBeNull();

    expect(createTopic).toHaveBeenCalledTimes(1);
    expect((await readChannels()).umbrellas[0]!.telegram?.topic_id).toBe(15);
  });

  it('no-ops (no RPC) when no daemon is running', async () => {
    await writeChannels({
      v: 1,
      umbrellas: [{ id: 'loop', members: [LOOP_CWD], telegram: { chat_id: '-100' } }],
    });
    const createTopic = vi.fn<CreateTopicFn>();
    const r = registry({ createTopic, daemonRunning: daemonDown });

    expect(await call(r, LOOP_CWD)).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
    expect((await readChannels()).umbrellas[0]!.telegram?.topic_id).toBeUndefined();
  });

  it('no-ops (no RPC) when the cwd resolves to no umbrella', async () => {
    await writeChannels({
      v: 1,
      umbrellas: [{ id: 'other', members: ['/somewhere/else'], telegram: { chat_id: '-200' } }],
    });
    const createTopic = vi.fn<CreateTopicFn>();
    const r = registry({ createTopic, daemonRunning: daemonUp });

    expect(await call(r, LOOP_CWD)).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
  });

  it('no-ops (no RPC) when the umbrella has NO telegram binding', async () => {
    await writeChannels({ v: 1, umbrellas: [{ id: 'loop', members: [LOOP_CWD] }] });
    const createTopic = vi.fn<CreateTopicFn>();
    const r = registry({ createTopic, daemonRunning: daemonUp });

    expect(await call(r, LOOP_CWD)).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
  });

  it('no-ops (no channels.json present) → no RPC', async () => {
    // no channels.json written → loadChannelsConfig returns null
    const createTopic = vi.fn<CreateTopicFn>();
    const r = registry({ createTopic, daemonRunning: daemonUp });

    expect(await call(r, LOOP_CWD)).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
  });

  it('fail-quiet on RPC error — returns null, leaves config untouched (no topic_id)', async () => {
    await writeChannels({
      v: 1,
      umbrellas: [{ id: 'loop', members: [LOOP_CWD], telegram: { chat_id: '-100' } }],
    });
    const createTopic = vi.fn<CreateTopicFn>(() =>
      Promise.reject(new Error('chat-daemon RPC error -32603: CHAT_ADMIN_REQUIRED')),
    );
    const r = registry({ createTopic, daemonRunning: daemonUp });

    expect(await call(r, LOOP_CWD)).toBeNull();
    expect(createTopic).toHaveBeenCalledTimes(1);
    // write-back never happened.
    expect((await readChannels()).umbrellas[0]!.telegram?.topic_id).toBeUndefined();
  });
});
