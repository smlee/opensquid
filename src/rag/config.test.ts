/**
 * Tests for the default-backend selection. retire-Rust (RES-1): `libsql-fastembed` is the
 * UNCONDITIONAL default — engine-binary presence no longer changes selection (the loop-engine
 * backend is removed). An explicit env/persisted kind still overrides; a stale `loop-engine`
 * override degrades to `libsql-fastembed` with a stderr warning.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveBackendConfig } from './config.js';

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
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    if (priorEnv === undefined) delete process.env.OPENSQUID_RAG_BACKEND;
    else process.env.OPENSQUID_RAG_BACKEND = priorEnv;
    await rm(home, { recursive: true, force: true });
  });

  it('no env/persisted → libsql-fastembed (unconditional default; engine presence is irrelevant)', async () => {
    expect((await resolveBackendConfig()).kind).toBe('libsql-fastembed');
  });

  it('a stale loop-engine override → warns + falls back to libsql-fastembed', async () => {
    process.env.OPENSQUID_RAG_BACKEND = 'loop-engine';
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cfg = await resolveBackendConfig();
    expect(cfg.kind).toBe('libsql-fastembed');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('loop-engine backend has been removed'),
    );
    warn.mockRestore();
  });

  it('explicit env override beats the default', async () => {
    process.env.OPENSQUID_RAG_BACKEND = 'libsql-qwen3';
    expect((await resolveBackendConfig()).kind).toBe('libsql-qwen3');
  });
});
