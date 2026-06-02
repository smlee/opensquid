/**
 * LL.4 — unit tests for the durable acked.jsonl writer.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { umbrellaInboxAckedPath } from '../paths.js';

import type { AckRow } from './inbox.js';
import { appendAckRows, rewriteAckedAfterPurge } from './inbox_writer.js';

let tempHome: string;
let priorHome: string | undefined;
const UMBRELLA = 'umb-x';

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-ll4-writer-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function row(message_id: string, ts = '2026-05-30T12:00:00Z'): AckRow {
  return {
    v: 1,
    message_id,
    platform: 'telegram',
    injected_at_sessionId: 'sess-A',
    injected_at_timestamp: ts,
  };
}

describe('appendAckRows — durable append with mutex', () => {
  it('empty rows → no-op (file not created)', async () => {
    await appendAckRows(UMBRELLA, []);
    await expect(readFile(umbrellaInboxAckedPath(UMBRELLA), 'utf8')).rejects.toThrow();
  });

  it('appends 2 rows to a new acked.jsonl', async () => {
    await appendAckRows(UMBRELLA, [row('1'), row('2')]);
    const body = await readFile(umbrellaInboxAckedPath(UMBRELLA), 'utf8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]!) as AckRow).message_id).toBe('1');
    expect((JSON.parse(lines[1]!) as AckRow).message_id).toBe('2');
  });

  it('appends to an existing acked.jsonl (preserves prior rows)', async () => {
    const path = umbrellaInboxAckedPath(UMBRELLA);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(row('0')) + '\n', 'utf8');
    await appendAckRows(UMBRELLA, [row('1')]);
    const body = await readFile(path, 'utf8');
    expect(body.trim().split('\n')).toHaveLength(2);
  });
});

describe('rewriteAckedAfterPurge — atomic replace', () => {
  it('rewrites file with kept rows only', async () => {
    await appendAckRows(UMBRELLA, [row('1'), row('2'), row('3')]);
    await rewriteAckedAfterPurge(UMBRELLA, [row('2')]);
    const body = await readFile(umbrellaInboxAckedPath(UMBRELLA), 'utf8');
    expect(body.trim().split('\n')).toHaveLength(1);
    expect((JSON.parse(body.trim()) as AckRow).message_id).toBe('2');
  });

  it('rewrites to empty file when kept is empty', async () => {
    await appendAckRows(UMBRELLA, [row('1')]);
    await rewriteAckedAfterPurge(UMBRELLA, []);
    const body = await readFile(umbrellaInboxAckedPath(UMBRELLA), 'utf8');
    expect(body).toBe('');
  });
});
