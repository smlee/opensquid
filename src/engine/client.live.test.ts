/**
 * Live-binary smoke test for EngineClient.
 *
 * Runs only when a real `loop-engine` binary is discoverable. Skips
 * gracefully otherwise — no CI breakage when the binary isn't built.
 *
 * Skip order:
 *   1. `OPENSQUID_ENGINE_BIN` env var — explicit override
 *   2. ~/projects/loop/engine/target/release/loop-engine — primary dev path
 *
 * Uses a throwaway `LOOP_HOME` under `os.tmpdir()` to keep the user's
 * `~/.opensquid` memory store untouched.
 */

import { statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EngineClient } from './client.js';

function locateBinary(): string | null {
  const fromEnv = process.env.OPENSQUID_ENGINE_BIN?.trim();
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  const devPath = join(
    process.env.HOME ?? '/tmp',
    'projects',
    'loop',
    'engine',
    'target',
    'release',
    'loop-engine',
  );
  if (isExecutable(devPath)) return devPath;
  return null;
}

function isExecutable(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

const binary = locateBinary();
const describeIfBinary = binary ? describe : describe.skip;

describeIfBinary('EngineClient — live binary round-trip', () => {
  let tmpHome: string;
  let priorBin: string | undefined;
  let priorHome: string | undefined;

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'opensquid-engine-live-'));
    priorBin = process.env.OPENSQUID_ENGINE_BIN;
    priorHome = process.env.LOOP_HOME;
    if (binary) process.env.OPENSQUID_ENGINE_BIN = binary;
    process.env.LOOP_HOME = tmpHome;
  });

  afterAll(() => {
    if (priorBin === undefined) delete process.env.OPENSQUID_ENGINE_BIN;
    else process.env.OPENSQUID_ENGINE_BIN = priorBin;
    if (priorHome === undefined) delete process.env.LOOP_HOME;
    else process.env.LOOP_HOME = priorHome;
  });

  it('ping() resolves with ok: true + a version string', async () => {
    const client = new EngineClient();
    try {
      const res = await client.ping();
      expect(res.ok).toBe(true);
      expect(typeof res.version).toBe('string');
      expect(res.version).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await client.close();
    }
  });
});
