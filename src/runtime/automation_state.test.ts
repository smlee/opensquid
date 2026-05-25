/**
 * Tests for the automation-mode flag-file helpers (G.12).
 *
 * Coverage:
 *   - automationFlagPath resolves under OPENSQUID_HOME/sessions/<id>/
 *   - setAutomationFlag creates the parent dir + file (idempotent)
 *   - clearAutomationFlag removes the file; ENOENT is a no-op
 *   - isAutomationFlagSet → true after set, false after clear, false initially
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  automationFlagPath,
  clearAutomationFlag,
  isAutomationFlagSet,
  setAutomationFlag,
} from './automation_state.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-automation-state-test-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('automationFlagPath', () => {
  it('resolves to <home>/sessions/<id>/automation.flag', () => {
    const p = automationFlagPath('sess-x');
    expect(p).toBe(join(tempHome, 'sessions', 'sess-x', 'automation.flag'));
  });
});

describe('setAutomationFlag / clearAutomationFlag / isAutomationFlagSet', () => {
  it('returns false when no flag exists', async () => {
    expect(await isAutomationFlagSet('fresh-session')).toBe(false);
  });

  it('setAutomationFlag creates the file (and parent dir) and flips the check', async () => {
    const sid = 'sess-set';
    await setAutomationFlag(sid);
    expect(await isAutomationFlagSet(sid)).toBe(true);
    const st = await stat(automationFlagPath(sid));
    expect(st.isFile()).toBe(true);
  });

  it('setAutomationFlag is idempotent (re-set refreshes file, no throw)', async () => {
    const sid = 'sess-idem';
    await setAutomationFlag(sid);
    await setAutomationFlag(sid);
    expect(await isAutomationFlagSet(sid)).toBe(true);
  });

  it('clearAutomationFlag removes the flag', async () => {
    const sid = 'sess-clear';
    await setAutomationFlag(sid);
    expect(await isAutomationFlagSet(sid)).toBe(true);
    await clearAutomationFlag(sid);
    expect(await isAutomationFlagSet(sid)).toBe(false);
  });

  it('clearAutomationFlag on missing file is a no-op', async () => {
    await expect(clearAutomationFlag('never-set')).resolves.toBeUndefined();
    expect(await isAutomationFlagSet('never-set')).toBe(false);
  });
});
