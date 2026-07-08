/**
 * SPLIT BOUNDARY guard (T-project-local-state PLS.3, design §4 OUT): RAG/recall = memories STAY GLOBAL.
 *
 * The checkpoint + loop TABLES of `opensquid.db` moved project-local (`<root>/.opensquid/opensquid.db`), but
 * RAG memories did NOT — `defaultRagBackend(home)` must keep resolving `<home>/opensquid.db` (the global home),
 * never a project-local store. This is a TABLE split, not a file move. The test mocks the two libsql backend
 * builders so it can capture the exact `dbUrl` the factory threads through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./backends/libsql_qwen3.js', () => ({
  libsqlQwen3Backend: vi.fn((opts: { dbUrl: string }) => ({ __dbUrl: opts.dbUrl })),
}));
vi.mock('./backends/libsql_lexical.js', () => ({
  libsqlLexicalBackend: vi.fn((opts: { dbUrl: string }) => ({ __dbUrl: opts.dbUrl })),
}));

import { libsqlQwen3Backend } from './backends/libsql_qwen3.js';
import { libsqlLexicalBackend } from './backends/libsql_lexical.js';
import { defaultRagBackend } from './backend_factory.js';

describe('defaultRagBackend — RAG stays GLOBAL (PLS.3 boundary)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('targets `<home>/opensquid.db` (the GLOBAL home) — NOT a project-local store', () => {
    defaultRagBackend('/tmp/global-home');
    // The primary (qwen3) and the lexical fallback both open the GLOBAL home db — a project-local resolver
    // (`resolveLocalStoreDir`) is deliberately NOT used here.
    expect(vi.mocked(libsqlQwen3Backend)).toHaveBeenCalledWith(
      expect.objectContaining({ dbUrl: 'file:/tmp/global-home/opensquid.db' }),
    );
    expect(vi.mocked(libsqlLexicalBackend)).toHaveBeenCalledWith(
      expect.objectContaining({ dbUrl: 'file:/tmp/global-home/opensquid.db' }),
    );
  });

  it('the db path is derived from the passed home, not the cwd/project root', () => {
    defaultRagBackend('/somewhere/else/.opensquid-global');
    expect(vi.mocked(libsqlQwen3Backend)).toHaveBeenCalledWith(
      expect.objectContaining({ dbUrl: 'file:/somewhere/else/.opensquid-global/opensquid.db' }),
    );
  });
});
