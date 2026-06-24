/**
 * Live-path proof for the always-on RAG ingest wiring (T-memory-foundation). `maybeIngestTurn` is the exact
 * function `stop.ts` calls on every Stop, so exercising it through the REAL `ingestTurn` + parser chain
 * (only the backend injected via the `makeBackend` seam) proves the capture path is wired end-to-end.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeleteResult, Lesson, RagBackend } from '../../rag/types.js';
import { maybeIngestTurn } from './stop_ingest.js';

let dir: string;
let path: string;

function fakeBackend(over: Partial<RagBackend> = {}): {
  backend: RagBackend;
  stored: Lesson[];
  readonly inits: number;
} {
  const stored: Lesson[] = [];
  const state = { inits: 0 };
  const backend: RagBackend = {
    init: () => {
      state.inits++;
      return Promise.resolve();
    },
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: (l) => {
      stored.push(l);
      return Promise.resolve();
    },
    deleteLesson: () => Promise.resolve({ deleted: true } as unknown as DeleteResult),
    ...over,
  };
  return {
    backend,
    stored,
    get inits() {
      return state.inits;
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'os-stop-ingest-'));
  path = join(dir, 'transcript.jsonl');
  await writeFile(
    path,
    JSON.stringify({
      uuid: 'live1',
      timestamp: '2026-06-24T00:00:00Z',
      type: 'user',
      message: { role: 'user', content: 'a real captured turn' },
    }) + '\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('maybeIngestTurn (live wiring)', () => {
  it('captures the transcript into the backend through the real ingest chain', async () => {
    const fake = fakeBackend();
    const n = await maybeIngestTurn(JSON.stringify({ transcript_path: path }), {
      makeBackend: () => fake.backend,
    });
    expect(n).toBe(1);
    expect(fake.inits).toBe(1);
    expect(fake.stored).toHaveLength(1);
    expect(fake.stored[0]?.id).toBe('live1');
    expect(fake.stored[0]?.content).toBe('a real captured turn');
    expect(fake.stored[0]?.author).toBe('agent');
  });

  it('accepts the camelCase transcriptPath key too', async () => {
    const fake = fakeBackend();
    await maybeIngestTurn(JSON.stringify({ transcriptPath: path }), {
      makeBackend: () => fake.backend,
    });
    expect(fake.stored).toHaveLength(1);
  });

  it('returns 0 and never builds a backend when no transcript path is present', async () => {
    let built = false;
    const n = await maybeIngestTurn(JSON.stringify({ session_id: 's1' }), {
      makeBackend: () => {
        built = true;
        return fakeBackend().backend;
      },
    });
    expect(n).toBe(0);
    expect(built).toBe(false);
  });

  it('returns 0 on a malformed payload (fail-open, no throw)', async () => {
    expect(await maybeIngestTurn('not json{')).toBe(0);
  });

  it('returns 0 when the backend throws (fail-open)', async () => {
    const fake = fakeBackend({ storeLesson: () => Promise.reject(new Error('db down')) });
    const n = await maybeIngestTurn(JSON.stringify({ transcript_path: path }), {
      makeBackend: () => fake.backend,
    });
    expect(n).toBe(0);
  });
});
