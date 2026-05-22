/**
 * Live integration test for the loop-engine RAG backend.
 *
 * SKIPPED by default — only runs when:
 *   - the loop-engine binary is discoverable (env / persisted config /
 *     dev-path search), AND
 *   - the user hasn't explicitly opted out via OPENSQUID_RAG_LIVE=0.
 *
 * Asserts cross-session memory contract: write a memory via the backend,
 * search for it, get it back. Proves the wire is whole — UDS connection,
 * memory.create, memory.search, RecallHit adapter — all on the live
 * engine daemon (T.4 singleton).
 *
 * Isolated OPENSQUID_HOME under the OS temp dir so we don't pollute the
 * user's real memory store. Also kills any leftover engine at that path
 * after the test to keep the workspace clean.
 *
 * Binary detection runs synchronously at module load via a top-level
 * await so the `describe.skipIf` decision is settled before vitest
 * registers any test bodies — `beforeAll` runs too late for that.
 *
 * Run manually:
 *   pnpm vitest run test/live/loop-engine-rag-live.test.ts
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveEngineBin } from '../../src/engine/config.js';
import { loopEngineBackend } from '../../src/rag/backends/loop_engine.js';
import { killEngineByPidfile } from '../__util/kill-engine.js';

import type { Lesson } from '../../src/rag/types.js';

const optOut = process.env.OPENSQUID_RAG_LIVE === '0';

// Top-level await: resolve the binary path at module load so the
// describe.skipIf condition is final before any test body registers.
const bin: string | null = optOut ? null : await resolveEngineBin().catch(() => null);

let testHome = '';

beforeAll(() => {
  if (!bin) return;
  // Isolated home for this test so we don't touch the user's data.
  testHome = mkdtempSync(join(tmpdir(), 'opensquid-rag-live-'));
  process.env.OPENSQUID_HOME = testHome;
  process.env.LOOP_HOME = testHome;
});

afterAll(async () => {
  if (!bin || testHome === '') return;
  // T.8.K.01: shared helper handles SIGTERM + grace + socket/pidfile
  // cleanup. Best-effort — never throws. The vitest globalSetup
  // teardown is the backstop if this misses anything.
  await killEngineByPidfile(testHome);
  await rm(testHome, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(bin === null)('loopEngineBackend — live integration', () => {
  it('write a memory, then recall it back', async () => {
    const backend = loopEngineBackend();
    await backend.init();

    const lesson: Lesson = {
      id: 'live-test-1',
      content: 'opensquid loop-engine RAG live integration test marker phrase: pumpkin-otter-sigil',
      tags: [],
      source: 'live-test',
      author: 'agent',
      createdAt: new Date().toISOString(),
    };

    await backend.storeLesson(lesson);

    const hits = await backend.recall('pumpkin-otter-sigil', 5);
    expect(hits.length).toBeGreaterThan(0);
    const found = hits.find((h) => h.lesson.content.includes('pumpkin-otter-sigil'));
    expect(found).toBeDefined();
    expect(found!.score).toBeGreaterThan(0);
  }, 30_000);
});
