/**
 * Tests for the UserPromptSubmit hook's `priorAssistantText` fill (RJ.1).
 *
 * The hook bin's `main()` composes `extractTranscriptPath(raw)` +
 * `readLastAssistantText(path)` to recover the SETTLED prior assistant turn at
 * UserPromptSubmit (where it has NO off-by-one — the prior turn is flushed).
 * `extractTranscriptPath` is unit-tested directly here; the composition is
 * exercised against an on-disk fixture transcript (mirroring transcript.test.ts)
 * so the end-to-end fill is proven without spawning the compiled bin.
 *
 * Fail-open contract: a payload with no transcript path → null → the bin leaves
 * `priorAssistantText` undefined and the prompt rides through (exit 0).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLastAssistantText } from './transcript.js';
import { extractTranscriptPath } from './user-prompt-submit.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-ups-fill-test-'));
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
const user = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

describe('extractTranscriptPath', () => {
  it('reads snake_case transcript_path', () => {
    const raw = JSON.stringify({ prompt: 'hi', transcript_path: '/tmp/t.jsonl' });
    expect(extractTranscriptPath(raw)).toBe('/tmp/t.jsonl');
  });

  it('reads camelCase transcriptPath', () => {
    const raw = JSON.stringify({ prompt: 'hi', transcriptPath: '/tmp/t.jsonl' });
    expect(extractTranscriptPath(raw)).toBe('/tmp/t.jsonl');
  });

  it('returns null when no transcript path is present (fail-open)', () => {
    expect(extractTranscriptPath(JSON.stringify({ prompt: 'hi' }))).toBeNull();
  });

  it('returns null on an empty-string path', () => {
    expect(extractTranscriptPath(JSON.stringify({ prompt: 'hi', transcript_path: '' }))).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(extractTranscriptPath('{not json')).toBeNull();
  });
});

describe('UPS priorAssistantText fill (composition)', () => {
  it('recovers the settled prior assistant turn from the transcript', async () => {
    // A completed turn: user prompt → assistant reply. At the NEXT UPS the
    // assistant reply is the last text-bearing entry → recovered verbatim.
    const path = await writeTranscript([
      user('do the fix'),
      asst('I just committed the fix and pushed it'),
    ]);
    const raw = JSON.stringify({ prompt: 'now verify CI', transcript_path: path });

    const tp = extractTranscriptPath(raw);
    expect(tp).toBe(path);
    const prior = await readLastAssistantText(tp!);
    expect(prior).toBe('I just committed the fix and pushed it');
  });

  it('yields "" (fail-open) when the transcript file is absent', async () => {
    const raw = JSON.stringify({ prompt: 'x', transcript_path: join(dir, 'missing.jsonl') });
    const prior = await readLastAssistantText(extractTranscriptPath(raw)!);
    expect(prior).toBe('');
  });
});
