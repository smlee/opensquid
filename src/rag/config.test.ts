/**
 * Tests for the default-backend selection (T-LIBSQL-DEFAULT). The no-engine fallback is now the
 * self-contained `libsql-fastembed` (no Ollama); `loop-engine` stays default when its binary is
 * present; an explicit env/persisted kind still overrides. `resolveEngineBin` is mocked (the
 * presence of a real engine binary on the test host must not decide the outcome).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../engine/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveEngineBin: vi.fn(),
}));

import { resolveEngineBin } from '../engine/config.js';

import { resolveBackendConfig } from './config.js';

const mockEngine = vi.mocked(resolveEngineBin);

describe('resolveBackendConfig — default selection', () => {
  let home: string;
  let priorHome: string | undefined;
  let priorEnv: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'rag-cfg-')); // empty → no persisted rag-config.json
    priorHome = process.env.OPENSQUID_HOME;
    priorEnv = process.env.OPENSQUID_RAG_BACKEND;
    process.env.OPENSQUID_HOME = home;
    delete process.env.OPENSQUID_RAG_BACKEND;
    mockEngine.mockReset();
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    if (priorEnv === undefined) delete process.env.OPENSQUID_RAG_BACKEND;
    else process.env.OPENSQUID_RAG_BACKEND = priorEnv;
    await rm(home, { recursive: true, force: true });
  });

  it('no engine + no env/persisted → self-contained libsql-fastembed', async () => {
    mockEngine.mockResolvedValue(null);
    expect((await resolveBackendConfig()).kind).toBe('libsql-fastembed');
  });

  it('engine present → loop-engine (unchanged)', async () => {
    mockEngine.mockResolvedValue('/path/to/opensquid-engine');
    expect((await resolveBackendConfig()).kind).toBe('loop-engine');
  });

  it('explicit env override beats the fallback', async () => {
    mockEngine.mockResolvedValue(null);
    process.env.OPENSQUID_RAG_BACKEND = 'libsql-qwen3';
    expect((await resolveBackendConfig()).kind).toBe('libsql-qwen3');
  });
});
