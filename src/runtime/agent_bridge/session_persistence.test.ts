/**
 * agent_bridge — SessionPersistence unit tests (WAB.3, 0.5.95).
 *
 * Fixtures aligned with the WAB.3 spec test plan:
 *   - appendEntries + loadHistory round-trip preserves order
 *   - malformed line in history file → skipped + warning logged, valid
 *     rows still loaded
 *   - append-only invariant: file size grows monotonically across
 *     repeated appends (no truncation / rewrite)
 *   - slug encoding survives colons + non-alphanumeric ids
 *   - missing file → empty array (not an error)
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionPersistence, encodeSessionSlug } from './session_persistence.js';
import type { ChatHistoryEntry } from './types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'wab3-persist-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeEntry(role: 'user' | 'assistant', text: string): ChatHistoryEntry {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
  };
}

describe('encodeSessionSlug', () => {
  it('replaces colons with double underscore', () => {
    expect(encodeSessionSlug('telegram:8075471258')).toBe('telegram__8075471258');
  });
  it('preserves negative ids + threaded keys', () => {
    expect(encodeSessionSlug('telegram:-1003923174632:15')).toBe('telegram__-1003923174632__15');
  });
  it('scrubs non-alphanumeric characters besides - and _', () => {
    // `:` → `__` then `/`, `.`, `.`, `/` each → `_` (4 chars between abc + etc).
    expect(encodeSessionSlug('telegram:abc/../etc/passwd')).toBe('telegram__abc____etc_passwd');
  });
  it('blocks path traversal by replacing slashes + dots', () => {
    const slug = encodeSessionSlug('telegram:../../escape');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('..');
  });
});

describe('SessionPersistence', () => {
  it('returns [] when the session file does not exist', async () => {
    const p = new SessionPersistence({ root: tmpRoot });
    const history = await p.loadHistory('telegram:111');
    expect(history).toEqual([]);
  });

  it('round-trips entries in append order across multiple appendEntries calls', async () => {
    const p = new SessionPersistence({ root: tmpRoot });
    const slug = 'telegram:222';
    const t1 = [makeEntry('user', 'hello'), makeEntry('assistant', 'hi there')];
    const t2 = [makeEntry('user', 'how are you?'), makeEntry('assistant', 'great')];
    await p.appendEntries(slug, t1);
    await p.appendEntries(slug, t2);
    const loaded = await p.loadHistory(slug);
    expect(loaded.map((e) => (e.content[0] as { text: string }).text)).toEqual([
      'hello',
      'hi there',
      'how are you?',
      'great',
    ]);
  });

  it('file size grows monotonically (append-only, no truncation)', async () => {
    const p = new SessionPersistence({ root: tmpRoot });
    const slug = 'telegram:333';
    const path = p.pathFor(slug);
    await p.appendEntries(slug, [makeEntry('user', 'one')]);
    const size1 = (await fs.stat(path)).size;
    await p.appendEntries(slug, [makeEntry('user', 'two')]);
    const size2 = (await fs.stat(path)).size;
    await p.appendEntries(slug, [makeEntry('user', 'three')]);
    const size3 = (await fs.stat(path)).size;
    expect(size2).toBeGreaterThan(size1);
    expect(size3).toBeGreaterThan(size2);
  });

  it('appendEntries is a no-op when given an empty batch (no file created)', async () => {
    const p = new SessionPersistence({ root: tmpRoot });
    const slug = 'telegram:444';
    await p.appendEntries(slug, []);
    await expect(fs.stat(p.pathFor(slug))).rejects.toThrow();
  });

  it('skips malformed JSON lines with a warning, still returns valid rows', async () => {
    const warnings: string[] = [];
    const p = new SessionPersistence({ root: tmpRoot, onWarn: (m) => warnings.push(m) });
    const slug = 'telegram:555';
    const valid = makeEntry('user', 'real');
    // Manually craft a file with: valid, garbage, valid.
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(
      p.pathFor(slug),
      `${JSON.stringify(valid)}\n{this is not json\n${JSON.stringify(valid)}\n`,
      'utf8',
    );
    const loaded = await p.loadHistory(slug);
    expect(loaded).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/malformed JSON/);
  });

  it('skips schema-mismatched rows with a warning', async () => {
    const warnings: string[] = [];
    const p = new SessionPersistence({ root: tmpRoot, onWarn: (m) => warnings.push(m) });
    const slug = 'telegram:666';
    await fs.mkdir(tmpRoot, { recursive: true });
    // Missing required `role` field.
    await fs.writeFile(p.pathFor(slug), `${JSON.stringify({ content: [] })}\n`, 'utf8');
    const loaded = await p.loadHistory(slug);
    expect(loaded).toEqual([]);
    expect(warnings[0]).toMatch(/schema mismatch/);
  });

  it('strips cacheMark before writing (transient field stays in-memory only)', async () => {
    const p = new SessionPersistence({ root: tmpRoot });
    const slug = 'telegram:777';
    const entry: ChatHistoryEntry = {
      ...makeEntry('user', 'with-mark'),
      cacheMark: true,
    };
    await p.appendEntries(slug, [entry]);
    const raw = await fs.readFile(p.pathFor(slug), 'utf8');
    expect(raw).not.toContain('cacheMark');
    const loaded = await p.loadHistory(slug);
    expect(loaded[0]?.cacheMark).toBeUndefined();
  });
});
