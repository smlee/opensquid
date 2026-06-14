/**
 * Tests for `classifyRequestType` (wg-3d175ec06767) — the pure cheap-first deterministic
 * request-type classifier (research vs work), and the session-state round-trip.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyRequestType, type RequestTypeRecord } from './request_type.js';
import { readRequestType, writeRequestType } from './session_state.js';

describe('classifyRequestType', () => {
  it('work-lead with no understand signal → work/high', () => {
    expect(classifyRequestType('build the X endpoint')).toEqual({
      type: 'work',
      confidence: 'high',
    });
    expect(classifyRequestType('refactor the loader')).toEqual({
      type: 'work',
      confidence: 'high',
    });
  });

  it('interrogative / investigation → research/high', () => {
    expect(classifyRequestType('why is X designed this way?')).toEqual({
      type: 'research',
      confidence: 'high',
    });
    expect(classifyRequestType("what's the plan here?")).toEqual({
      type: 'research',
      confidence: 'high',
    });
    expect(classifyRequestType('look at how dispatch works')).toEqual({
      type: 'research',
      confidence: 'high',
    });
  });

  it('conflicting work + understand → research/low (safe default, never work)', () => {
    expect(classifyRequestType('fix the bug and explain why it happened')).toEqual({
      type: 'research',
      confidence: 'low',
    });
  });

  it('no signal → research/low (safe default)', () => {
    expect(classifyRequestType('')).toEqual({ type: 'research', confidence: 'low' });
    expect(classifyRequestType('ok')).toEqual({ type: 'research', confidence: 'low' });
  });

  it('is pure — same input, same output (no time/randomness)', () => {
    const a = classifyRequestType('add a feature');
    const b = classifyRequestType('add a feature');
    expect(a).toEqual(b);
  });
});

describe('request-type session-state round-trip', () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-rt-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('writeRequestType → readRequestType round-trips', async () => {
    const rec: RequestTypeRecord = {
      type: 'work',
      confidence: 'high',
      source: 'deterministic',
      prompt_hash: 'abc123',
      at: '2026-06-14T00:00:00.000Z',
    };
    await writeRequestType('sid-1', rec);
    expect(await readRequestType('sid-1')).toEqual(rec);
  });

  it('readRequestType returns null when absent (ENOENT)', async () => {
    expect(await readRequestType('no-such-sid')).toBeNull();
  });
});
