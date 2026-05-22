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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { killEngineByPidfile } from '../../test/__util/kill-engine.js';

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
  let priorLoopHome: string | undefined;
  let priorOpensquidHome: string | undefined;

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'opensquid-engine-live-'));
    priorBin = process.env.OPENSQUID_ENGINE_BIN;
    priorLoopHome = process.env.LOOP_HOME;
    priorOpensquidHome = process.env.OPENSQUID_HOME;
    if (binary) process.env.OPENSQUID_ENGINE_BIN = binary;
    // T.8.K.01: override BOTH homes so the singleton's pidfile +
    // socket land in tmpHome — not the user's real ~/.opensquid (which
    // would either collide with a real daemon or leak our spawn into
    // the user's workspace).
    process.env.LOOP_HOME = tmpHome;
    process.env.OPENSQUID_HOME = tmpHome;
  });

  afterAll(async () => {
    // T.8.K.01: kill any engine daemon spawned under this test's
    // tmpHome (the singleton's pidfile lives at $OPENSQUID_HOME/
    // loop-engine.pid, which we pinned to tmpHome above). Best-effort —
    // never throws. The globalSetup teardown in vitest.config.ts is the
    // belt-and-suspenders backstop for anything missed here.
    await killEngineByPidfile(tmpHome);
    if (priorBin === undefined) delete process.env.OPENSQUID_ENGINE_BIN;
    else process.env.OPENSQUID_ENGINE_BIN = priorBin;
    if (priorLoopHome === undefined) delete process.env.LOOP_HOME;
    else process.env.LOOP_HOME = priorLoopHome;
    if (priorOpensquidHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorOpensquidHome;
    // Clean the tmpdir (best-effort).
    rmSync(tmpHome, { recursive: true, force: true });
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
