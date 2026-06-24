/**
 * Tests for the transcript per-entry parser (T-memory-foundation). Drives a real tmp `.jsonl` fixture
 * matching the live transcript schema (string OR array content; text/thinking/tool_use/tool_result blocks;
 * non-message + malformed lines).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTranscriptEntries } from './transcript_entries.js';

let dir: string;
let path: string;

const lines = [
  // 1: string content (user)
  {
    uuid: 'u1',
    timestamp: '2026-06-24T00:00:00Z',
    type: 'user',
    message: { role: 'user', content: 'hello world' },
  },
  // 2: array content (assistant) — thinking + text + tool_use
  {
    uuid: 'a1',
    timestamp: '2026-06-24T00:00:01Z',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'SECRET REASONING' },
        { type: 'text', text: 'hi there' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  },
  // 3: tool_result with string content (user)
  {
    uuid: 'u2',
    timestamp: '2026-06-24T00:00:02Z',
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt', is_error: false }],
    },
  },
  // 4: tool_result with array content (user)
  {
    uuid: 'u3',
    timestamp: '2026-06-24T00:00:03Z',
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'arr' }] },
      ],
    },
  },
  // 5: thinking-only assistant — must be skipped (empty serialized content)
  {
    uuid: 'a2',
    timestamp: '2026-06-24T00:00:04Z',
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thinking' }] },
  },
  // 6: non-message line — no uuid, no message.role
  { type: 'attachment', content: 'an attachment record' },
];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'os-transcript-'));
  path = join(dir, 'transcript.jsonl');
  const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\nthis is not json{\n';
  await writeFile(path, jsonl, 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readTranscriptEntries', () => {
  it('parses message entries, skips non-message + malformed + thinking-only lines', async () => {
    const entries = await readTranscriptEntries(path);
    // u1, a1, u2, u3 — a2 (thinking-only) and the attachment + malformed lines are skipped.
    expect(entries.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'u3']);
  });

  it('carries uuid / timestamp / role', async () => {
    const [u1] = await readTranscriptEntries(path);
    expect(u1).toMatchObject({ uuid: 'u1', timestamp: '2026-06-24T00:00:00Z', role: 'user' });
  });

  it('serializes string content verbatim', async () => {
    const [u1] = await readTranscriptEntries(path);
    expect(u1?.content).toBe('hello world');
    expect(u1?.hasTool).toBe(false);
  });

  it('excludes thinking, includes text + tool_use; flags hasTool', async () => {
    const a1 = (await readTranscriptEntries(path)).find((e) => e.uuid === 'a1');
    expect(a1?.content).toContain('hi there');
    expect(a1?.content).toContain('[tool_use Bash]');
    expect(a1?.content).toContain('ls');
    expect(a1?.content).not.toContain('SECRET REASONING');
    expect(a1?.hasTool).toBe(true);
  });

  it('serializes tool_result string and array content', async () => {
    const all = await readTranscriptEntries(path);
    expect(all.find((e) => e.uuid === 'u2')?.content).toBe('[tool_result] file.txt');
    expect(all.find((e) => e.uuid === 'u3')?.content).toContain('[tool_result]');
    expect(all.find((e) => e.uuid === 'u3')?.hasTool).toBe(true);
  });

  it('returns [] for an unreadable path (fail-soft)', async () => {
    expect(await readTranscriptEntries(join(dir, 'nope.jsonl'))).toEqual([]);
  });
});
