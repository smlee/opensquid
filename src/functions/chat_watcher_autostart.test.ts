/**
 * Tests for `chat_watcher_autostart` (T-CHAT-REALTIME) — the SessionStart
 * directive that starts the inbound watcher. Channel config isolated via
 * OPENSQUID_HOME + channels.json.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelsConfigPath } from '../channels/routing.js';

import { ChatWatcherAutostart } from './chat_watcher_autostart.js';

const CWD = '/x/loop';
const ctx = {
  sessionId: 'cwa-test',
  event: { kind: 'session_start' as const, cwd: CWD },
} as never;

describe('chat_watcher_autostart (T-CHAT-REALTIME)', () => {
  let home: string;
  let prior: string | undefined;

  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'cwa-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('umbrella with a telegram channel → inject_context to start the watcher', async () => {
    await writeFile(
      channelsConfigPath(),
      JSON.stringify({
        v: 1,
        umbrellas: [{ id: 'loop', members: [CWD], telegram: { chat_id: '-100', topic_id: 15 } }],
      }),
      'utf8',
    );
    const r = await ChatWatcherAutostart.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toBeNull();
      expect(r.value?.content).toMatch(/chat watch/);
      expect(r.value?.content).toMatch(/Monitor\(/);
    }
  });

  it('umbrella WITHOUT a telegram channel → null (nothing to watch)', async () => {
    await writeFile(
      channelsConfigPath(),
      JSON.stringify({ v: 1, umbrellas: [{ id: 'loop', members: [CWD] }] }),
      'utf8',
    );
    const r = await ChatWatcherAutostart.execute({}, ctx);
    expect(r.ok && r.value).toBeNull();
  });

  it('no channels.json → null (fail-soft, never throws)', async () => {
    const r = await ChatWatcherAutostart.execute({}, ctx);
    expect(r.ok && r.value).toBeNull();
  });

  it('cwd resolves to no umbrella → null', async () => {
    await writeFile(
      channelsConfigPath(),
      JSON.stringify({
        v: 1,
        umbrellas: [{ id: 'loop', members: [CWD], telegram: { chat_id: '-100', topic_id: 15 } }],
      }),
      'utf8',
    );
    const elsewhere = {
      sessionId: 'cwa-test',
      event: { kind: 'session_start' as const, cwd: '/somewhere/else' },
    } as never;
    const r = await ChatWatcherAutostart.execute({}, elsewhere);
    expect(r.ok && r.value).toBeNull();
  });
});
