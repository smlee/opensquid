/**
 * Tests for the `createBackend` factory — specifically the T.3 addition
 * of the `'loop-engine'` discriminated variant.
 *
 * Existing variants (libsql-qwen3, libsql-lexical, claude-auto-memory)
 * are exercised by their own backend tests + the fallback wrapper test
 * in libsql_lexical.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { createBackend } from './backend_factory.js';

// Mock the loop_engine module so the factory test doesn't try to
// construct a real EngineClient (which would attempt UDS connection
// on init). We only assert the factory dispatches to the right
// constructor + forwards opts cleanly.
vi.mock('./backends/loop_engine.js', () => ({
  loopEngineBackend: vi.fn((opts: unknown) => ({
    _stub: 'loop-engine',
    _opts: opts,
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: () => Promise.resolve(),
  })),
}));

describe('createBackend — loop-engine variant', () => {
  it('accepts kind: "loop-engine" and returns a backend', () => {
    const backend = createBackend({ kind: 'loop-engine' });
    expect(backend).toBeDefined();
    expect(typeof backend.init).toBe('function');
    expect(typeof backend.recall).toBe('function');
    expect(typeof backend.storeLesson).toBe('function');
    expect(typeof backend.embed).toBe('function');
  });

  it('forwards mode + ollamaUrl opts to loopEngineBackend', async () => {
    const { loopEngineBackend } = await import('./backends/loop_engine.js');
    const mocked = vi.mocked(loopEngineBackend);
    mocked.mockClear();

    createBackend({
      kind: 'loop-engine',
      mode: 'semantic',
      ollamaUrl: 'http://127.0.0.1:11434',
    });

    expect(mocked).toHaveBeenCalledWith({
      mode: 'semantic',
      ollamaUrl: 'http://127.0.0.1:11434',
    });
  });

  it('omits undefined opts (no `mode: undefined` in payload)', async () => {
    const { loopEngineBackend } = await import('./backends/loop_engine.js');
    const mocked = vi.mocked(loopEngineBackend);
    mocked.mockClear();

    createBackend({ kind: 'loop-engine' });
    expect(mocked).toHaveBeenCalledWith({});
  });
});
