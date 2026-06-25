/**
 * CFD.2 / AD.5 — backlog tests. Uses the vitest globalSetup OPENSQUID_HOME temp dir; unique sid per test.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sessionLogFile } from '../paths.js';
import { appendBacklog, BACKLOG_LOG, type BacklogItem, readBacklog } from './backlog.js';

let n = 0;
const sid = (): string => `backlog-test-${String(n++)}`;
const item = (id: string, text: string, addedAt = '2026-06-25T00:00:00.000Z'): BacklogItem => ({
  id,
  text,
  cls: 'nice_to_have',
  addedAt,
});

describe('backlog (AD.5)', () => {
  it('reads empty when absent', async () => {
    expect(await readBacklog(sid())).toEqual([]);
  });

  it('append/read round-trips two distinct items (first-seen order)', async () => {
    const s = sid();
    await appendBacklog(s, item('a', 'first nice-to-have'));
    await appendBacklog(s, item('b', 'second nice-to-have'));
    expect((await readBacklog(s)).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('dedups by id (a re-add collapses, latest text wins) so a surfacing does not repeat', async () => {
    const s = sid();
    await appendBacklog(s, item('a', 'old text', '2026-06-25T00:00:00.000Z'));
    await appendBacklog(s, item('a', 'new text', '2026-06-25T01:00:00.000Z'));
    const out = await readBacklog(s);
    expect(out).toEqual([item('a', 'new text', '2026-06-25T01:00:00.000Z')]);
  });

  it('skips a malformed line instead of breaking the read', async () => {
    const s = sid();
    const path = sessionLogFile(s, BACKLOG_LOG);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(item('good', 'ok'))}\n{ not json\n`, 'utf8');
    expect((await readBacklog(s)).map((i) => i.id)).toEqual(['good']);
  });
});
