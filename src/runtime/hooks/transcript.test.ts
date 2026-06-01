/**
 * Tests for `readLastAssistantText` (T-HANDOFF-HARDENING HH7.1).
 *
 * The transcript schema is harness-owned; these fixtures mirror the verified
 * Claude Code shape (entries with top-level `type` + `message.role` +
 * `message.content[]` blocks). Covers: text recovery, tool_use-only skip,
 * absent/unreadable file, malformed-line resilience, and the
 * `message.role`-without-`type` variant.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLastAssistantText, readLastNTurns } from './transcript.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-transcript-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeTranscript(lines: unknown[]): Promise<string> {
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  return path;
}

const asst = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const asstToolUse = () => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] },
});
const user = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

describe('readLastAssistantText', () => {
  it('returns the text of the last text-bearing assistant entry', async () => {
    const path = await writeTranscript([
      user('hi'),
      asst('first reply'),
      user('again'),
      asst('per [[X]] recalled the routing facts'),
    ]);
    expect(await readLastAssistantText(path)).toBe('per [[X]] recalled the routing facts');
  });

  it('skips a pure tool_use last turn and returns the prior assistant text', async () => {
    const path = await writeTranscript([
      asst('the prose answer, per memory'),
      asstToolUse(), // last assistant entry has no text
    ]);
    expect(await readLastAssistantText(path)).toBe('the prose answer, per memory');
  });

  it('returns "" when the transcript file is absent / unreadable', async () => {
    expect(await readLastAssistantText(join(dir, 'does-not-exist.jsonl'))).toBe('');
  });

  it('skips malformed lines and still finds the assistant text', async () => {
    const path = join(dir, 't.jsonl');
    await writeFile(
      path,
      ['{not json', '', JSON.stringify(asst('survived the malformed line')), '   '].join('\n'),
      'utf8',
    );
    expect(await readLastAssistantText(path)).toBe('survived the malformed line');
  });

  it('recognizes an entry by message.role even without a top-level type', async () => {
    const path = await writeTranscript([
      { message: { role: 'assistant', content: [{ type: 'text', text: 'role-only entry' }] } },
    ]);
    expect(await readLastAssistantText(path)).toBe('role-only entry');
  });

  it('returns "" when there are no assistant entries', async () => {
    const path = await writeTranscript([user('only user turns'), { type: 'system' }]);
    expect(await readLastAssistantText(path)).toBe('');
  });

  it('joins multiple text blocks in one assistant entry', async () => {
    const path = await writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'tool_use', name: 'X' },
            { type: 'text', text: 'part two' },
          ],
        },
      },
    ]);
    expect(await readLastAssistantText(path)).toBe('part one\npart two');
  });
});

describe('readLastNTurns (FU.2)', () => {
  it('returns the last N text-bearing turns, oldest→newest, role-labeled', async () => {
    const path = await writeTranscript([
      user('one'),
      asst('two'),
      user('three'),
      asst('four'),
      user('five'),
    ]);
    expect(await readLastNTurns(path, 4)).toBe(
      'Assistant: two\n\nUser: three\n\nAssistant: four\n\nUser: five',
    );
  });

  it('returns all turns when n exceeds the available count', async () => {
    const path = await writeTranscript([user('a'), asst('b')]);
    expect(await readLastNTurns(path, 10)).toBe('User: a\n\nAssistant: b');
  });

  it('skips pure tool_use turns', async () => {
    const path = await writeTranscript([user('q'), asstToolUse(), asst('real answer')]);
    expect(await readLastNTurns(path, 5)).toBe('User: q\n\nAssistant: real answer');
  });

  it('returns "" for n <= 0', async () => {
    const path = await writeTranscript([user('a'), asst('b')]);
    expect(await readLastNTurns(path, 0)).toBe('');
  });

  it('returns "" when the transcript is absent', async () => {
    expect(await readLastNTurns(join(dir, 'nope.jsonl'), 5)).toBe('');
  });

  it('skips malformed lines', async () => {
    const path = join(dir, 'm.jsonl');
    await writeFile(
      path,
      ['{bad', JSON.stringify(user('kept-u')), '', JSON.stringify(asst('kept-a'))].join('\n'),
      'utf8',
    );
    expect(await readLastNTurns(path, 5)).toBe('User: kept-u\n\nAssistant: kept-a');
  });
});
