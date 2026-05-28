/**
 * Tests for the ASG.2 plausibility probe. Pure-function-over-fs semantics;
 * the only side effects are `stat` reads. Mtime fixtures use `utimes`.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activeTaskFile, sessionStateFile } from '../paths.js';

import { DEFAULT_FRESH_MS, FRESH_MS, isSessionPlausible } from './session_liveness.js';

let tempHome: string;
let priorHome: string | undefined;
let priorFreshEnv: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorFreshEnv = process.env.OPENSQUID_SESSION_FRESH_MS;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-session-liveness-'));
  process.env.OPENSQUID_HOME = tempHome;
  delete process.env.OPENSQUID_SESSION_FRESH_MS;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorFreshEnv === undefined) delete process.env.OPENSQUID_SESSION_FRESH_MS;
  else process.env.OPENSQUID_SESSION_FRESH_MS = priorFreshEnv;
  await rm(tempHome, { recursive: true, force: true });
});

async function seedFile(absPath: string, mtimeMs: number): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, '{}', 'utf8');
  const date = new Date(mtimeMs);
  await utimes(absPath, date, date);
}

describe('FRESH_MS', () => {
  it('returns DEFAULT_FRESH_MS when unset', () => {
    delete process.env.OPENSQUID_SESSION_FRESH_MS;
    expect(FRESH_MS()).toBe(DEFAULT_FRESH_MS);
  });

  it('honors an env override', () => {
    process.env.OPENSQUID_SESSION_FRESH_MS = '60000';
    expect(FRESH_MS()).toBe(60_000);
  });

  it('falls back to default for garbage input', () => {
    process.env.OPENSQUID_SESSION_FRESH_MS = 'not-a-number';
    expect(FRESH_MS()).toBe(DEFAULT_FRESH_MS);
  });

  it('falls back to default for non-positive input', () => {
    process.env.OPENSQUID_SESSION_FRESH_MS = '0';
    expect(FRESH_MS()).toBe(DEFAULT_FRESH_MS);
    process.env.OPENSQUID_SESSION_FRESH_MS = '-500';
    expect(FRESH_MS()).toBe(DEFAULT_FRESH_MS);
  });
});

describe('isSessionPlausible', () => {
  it('reports not-plausible + null mtime when the session dir does not exist', async () => {
    const result = await isSessionPlausible('absent-sid');
    expect(result.plausible).toBe(false);
    expect(result.newestMtimeMs).toBeNull();
    expect(result.probedFiles).toHaveLength(2);
    expect(result.probedFiles[0]).toBe(activeTaskFile('absent-sid'));
    expect(result.probedFiles[1]).toBe(sessionStateFile('absent-sid', 'tool-ledger'));
  });

  it('plausible when active-task.json is fresh', async () => {
    const now = Date.now();
    await seedFile(activeTaskFile('fresh-sid'), now - 1000);
    const result = await isSessionPlausible('fresh-sid', { nowMs: () => now });
    expect(result.plausible).toBe(true);
    expect(result.newestMtimeMs).toBeCloseTo(now - 1000, -1);
  });

  it('not plausible when active-task.json is older than the window', async () => {
    const now = Date.now();
    await seedFile(activeTaskFile('stale-sid'), now - 3_600_000); // 1h
    const result = await isSessionPlausible('stale-sid', { nowMs: () => now });
    expect(result.plausible).toBe(false);
    expect(result.newestMtimeMs).not.toBeNull();
  });

  it('plausible when only tool-ledger.json is present + fresh', async () => {
    const now = Date.now();
    await seedFile(sessionStateFile('ledger-only', 'tool-ledger'), now - 500);
    const result = await isSessionPlausible('ledger-only', { nowMs: () => now });
    expect(result.plausible).toBe(true);
  });

  it('returns the NEWEST mtime when both files exist', async () => {
    const now = Date.now();
    await seedFile(activeTaskFile('both'), now - 30_000);
    await seedFile(sessionStateFile('both', 'tool-ledger'), now - 1_000);
    const result = await isSessionPlausible('both', { nowMs: () => now });
    expect(result.plausible).toBe(true);
    // newest = tool-ledger (now - 1_000)
    expect(result.newestMtimeMs).toBeGreaterThan(now - 5_000);
  });

  it('honors a per-call freshMs override', async () => {
    const now = Date.now();
    await seedFile(activeTaskFile('window-test'), now - 10_000); // 10s old
    // Default 30min would say plausible; force a 5s window to make it stale.
    const tight = await isSessionPlausible('window-test', {
      nowMs: () => now,
      freshMs: 5_000,
    });
    expect(tight.plausible).toBe(false);
    const loose = await isSessionPlausible('window-test', {
      nowMs: () => now,
      freshMs: 60_000,
    });
    expect(loose.plausible).toBe(true);
  });

  it('honors OPENSQUID_SESSION_FRESH_MS env when freshMs not passed', async () => {
    process.env.OPENSQUID_SESSION_FRESH_MS = '3000';
    const now = Date.now();
    await seedFile(activeTaskFile('env-window'), now - 5_000);
    const result = await isSessionPlausible('env-window', { nowMs: () => now });
    expect(result.plausible).toBe(false);
  });
});
