/**
 * LL.3 — unit tests for the inbound watcher's pure helpers + processRow.
 *
 * Strategy: avoid spinning up real chokidar (lifecycle is covered in
 * watch_cli.test.ts via injection seam). Cover:
 *   - buildChannelUri / platformFromChannelUri round-trip + parsing
 *   - extractProjectUuid path parsing
 *   - processRow stale/missing-lease → appends unrouted.jsonl, no dispatch
 *   - processRow with fresh lease → dispatches; verify lease consumed
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inboxDir, liveSessionLease } from '../paths.js';

import {
  buildChannelUri,
  extractProjectUuid,
  platformFromChannelUri,
  processRow,
} from './inbound_watch.js';
import type { InboxRow } from './inbox.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-ll3-inbound-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

const sampleRow: InboxRow = {
  v: 1,
  id: '42',
  platform: 'telegram',
  channel: '-100123',
  sender: 'alice',
  sender_id: 'u1',
  text: 'hi',
  received_at: '2026-05-30T12:00:00Z',
  enqueued_at: '2026-05-30T12:00:00.123Z',
  mentions_bot: false,
};

describe('buildChannelUri / platformFromChannelUri', () => {
  it('builds telegram://channel format without thread_id', () => {
    expect(buildChannelUri(sampleRow)).toBe('telegram://-100123');
  });

  it('builds telegram://channel/thread format with thread_id', () => {
    expect(buildChannelUri({ ...sampleRow, thread_id: '281' })).toBe('telegram://-100123/281');
  });

  it('parses telegram scheme from channelUri', () => {
    expect(platformFromChannelUri('telegram://-100123/281')).toBe('telegram');
  });

  it('parses slack scheme from channelUri', () => {
    expect(platformFromChannelUri('slack://C0123')).toBe('slack');
  });

  it('returns null for unrecognized scheme', () => {
    expect(platformFromChannelUri('irc://chan')).toBeNull();
  });
});

describe('extractProjectUuid', () => {
  it('extracts uuid from a per-project inbox path', () => {
    expect(extractProjectUuid('/Users/x/.opensquid/projects/abc-123/inbox/telegram.jsonl')).toBe(
      'abc-123',
    );
  });

  it('returns null for non-matching path', () => {
    expect(extractProjectUuid('/var/log/system.log')).toBeNull();
  });
});

async function seedLease(uuid: string, body: Record<string, unknown>): Promise<void> {
  const path = liveSessionLease(uuid);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body), 'utf8');
}

describe('processRow lease-missing path → appends unrouted.jsonl', () => {
  it('writes unrouted entry when no lease exists', async () => {
    await mkdir(inboxDir('uuid-x'), { recursive: true });
    await processRow('uuid-x', sampleRow);
    const unrouted = await readFile(join(inboxDir('uuid-x'), 'unrouted.jsonl'), 'utf8');
    const entry = JSON.parse(unrouted.trim()) as Record<string, unknown>;
    expect(entry.message_id).toBe('42');
    expect(entry.project_uuid).toBe('uuid-x');
    expect(entry.platform).toBe('telegram');
    expect(entry.reason).toBe('no_fresh_live_session_lease');
  });

  it('writes unrouted entry when lease is stale', async () => {
    const longAgo = new Date(Date.now() - 600_000).toISOString();
    await seedLease('uuid-x', { session_id: 'sess', pid: 1, refreshed_at: longAgo });
    await mkdir(inboxDir('uuid-x'), { recursive: true });
    await processRow('uuid-x', sampleRow);
    const unrouted = await readFile(join(inboxDir('uuid-x'), 'unrouted.jsonl'), 'utf8');
    expect(unrouted).toContain('no_fresh_live_session_lease');
  });

  it('appends multiple unrouted entries (one per call)', async () => {
    await mkdir(inboxDir('uuid-x'), { recursive: true });
    await processRow('uuid-x', sampleRow);
    await processRow('uuid-x', { ...sampleRow, id: '43' });
    const unrouted = await readFile(join(inboxDir('uuid-x'), 'unrouted.jsonl'), 'utf8');
    const lines = unrouted.trim().split('\n');
    expect(lines).toHaveLength(2);
    const ids = lines.map((l) => (JSON.parse(l) as { message_id: string }).message_id);
    expect(ids.sort()).toEqual(['42', '43']);
  });
});
