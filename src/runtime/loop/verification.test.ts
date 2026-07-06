/**
 * DBL.1b — the deploy-verification record (mirrors readiness's record/read). Sandboxes OPENSQUID_HOME per test.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bumpBugfixRounds,
  readBugfixRounds,
  readNeedsRedesign,
  readSuite,
  readVerification,
  recordNeedsRedesign,
  recordSuite,
  recordVerification,
  resetBugfixRounds,
} from './verification.js';

let home: string;
let prior: string | undefined;
const SID = 'sess-verify';

beforeEach(async () => {
  prior = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-verify-'));
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (prior === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prior;
  await rm(home, { recursive: true, force: true });
});

describe('verification record (DBL.1b)', () => {
  it('absent → null (never run; the caller decides skip-vs-fail-closed)', async () => {
    expect(await readVerification(SID, 't1')).toBeNull();
  });

  it('record(true) → read true; record(false) → read false (latest-verify-wins)', async () => {
    await recordVerification(SID, 't1', true);
    expect(await readVerification(SID, 't1')).toBe(true);
    await recordVerification(SID, 't1', false); // a re-run after a regression overwrites
    expect(await readVerification(SID, 't1')).toBe(false);
  });

  it("is per-task (one task's result does not leak to another)", async () => {
    await recordVerification(SID, 't1', true);
    expect(await readVerification(SID, 't2')).toBeNull();
  });
});

// scope-1 (T-deploy-commit-gate §2.1) — the project-SUITE record mirrors the verifyCommand record.
describe('suite record (scope-1: the DEPLOY floor)', () => {
  it('absent → null (never run; the caller decides skip-vs-fail-closed)', async () => {
    expect(await readSuite(SID, 't1')).toBeNull();
  });

  it('record(true) → read true; record(false) → read false (latest-suite-wins)', async () => {
    await recordSuite(SID, 't1', true);
    expect(await readSuite(SID, 't1')).toBe(true);
    await recordSuite(SID, 't1', false); // a re-run after a regression overwrites
    expect(await readSuite(SID, 't1')).toBe(false);
  });

  it('is per-task + independent of the verifyCommand record (distinct keys)', async () => {
    await recordSuite(SID, 't1', true);
    expect(await readSuite(SID, 't2')).toBeNull();
    await recordVerification(SID, 't1', false); // the verifyCommand record must not clobber the suite record
    expect(await readSuite(SID, 't1')).toBe(true);
  });
});

describe('bug-fix rounds (DBL.2)', () => {
  it('absent → 0; bump increments + returns the new count; reset → 0', async () => {
    expect(await readBugfixRounds(SID, 't1')).toBe(0);
    expect(await bumpBugfixRounds(SID, 't1')).toBe(1);
    expect(await bumpBugfixRounds(SID, 't1')).toBe(2);
    expect(await readBugfixRounds(SID, 't1')).toBe(2);
    await resetBugfixRounds(SID, 't1');
    expect(await readBugfixRounds(SID, 't1')).toBe(0);
  });

  it('is per-task', async () => {
    await bumpBugfixRounds(SID, 't1');
    expect(await readBugfixRounds(SID, 't2')).toBe(0);
  });
});

describe('needs-redesign flag (scope-2: the DEPLOY-local fix loop escape hatch)', () => {
  it('absent → false (the safe narrowing: default DEPLOY-local, not AUTHOR)', async () => {
    expect(await readNeedsRedesign(SID, 't1')).toBe(false);
  });

  it('set → true; cleared → false (the flag round-trips, latest write wins)', async () => {
    await recordNeedsRedesign(SID, 't1', true);
    expect(await readNeedsRedesign(SID, 't1')).toBe(true);
    await recordNeedsRedesign(SID, 't1', false); // a clean verify (or --clear) reverts it
    expect(await readNeedsRedesign(SID, 't1')).toBe(false);
  });

  it('is per-task (flagging t1 never routes t2 to AUTHOR)', async () => {
    await recordNeedsRedesign(SID, 't1', true);
    expect(await readNeedsRedesign(SID, 't2')).toBe(false);
  });
});
