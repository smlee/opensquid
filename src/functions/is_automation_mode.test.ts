/**
 * Tests for `is_automation_mode` primitive (G.12).
 *
 * Coverage per spec test fixtures (G.12 lines 1832–1836):
 *   - env var OPENSQUID_AUTOMATION=1 → returns true, source='env'
 *   - env var set + flag also set → still 'env' (env wins the source label)
 *   - flag file present (env unset) → returns true, source='flag'
 *   - neither → returns false, source='none'
 *   - empty args object is accepted; non-empty args rejected (strict schema)
 *
 * Isolation: per-test temp OPENSQUID_HOME so the on-disk flag never leaks
 * across cases; env var saved + restored.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAutomationFlag } from '../runtime/automation_state.js';
import type { Event } from '../runtime/types.js';

import { IsAutomationMode } from './is_automation_mode.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

let tempHome: string;
let priorHome: string | undefined;
let priorAutomationEnv: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorAutomationEnv = process.env.OPENSQUID_AUTOMATION;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-is-automation-mode-test-'));
  process.env.OPENSQUID_HOME = tempHome;
  delete process.env.OPENSQUID_AUTOMATION;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorAutomationEnv === undefined) delete process.env.OPENSQUID_AUTOMATION;
  else process.env.OPENSQUID_AUTOMATION = priorAutomationEnv;
  await rm(tempHome, { recursive: true, force: true });
});

function freshRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  reg.register(IsAutomationMode);
  return reg;
}

function ctxFor(sessionId: string): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId,
    packId: 'test-pack',
  };
}

describe('is_automation_mode', () => {
  it('returns {value:true, source:"env"} when OPENSQUID_AUTOMATION=1', async () => {
    process.env.OPENSQUID_AUTOMATION = '1';
    const reg = freshRegistry();
    const result = await reg.call('is_automation_mode', {}, ctxFor('sess-env'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: true, source: 'env' });
    }
  });

  it('returns env source when env=1 AND flag set (env wins the label)', async () => {
    process.env.OPENSQUID_AUTOMATION = '1';
    await setAutomationFlag('sess-both');
    const reg = freshRegistry();
    const result = await reg.call('is_automation_mode', {}, ctxFor('sess-both'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: true, source: 'env' });
    }
  });

  it('returns {value:true, source:"flag"} when flag file present and env unset', async () => {
    await setAutomationFlag('sess-flag');
    const reg = freshRegistry();
    const result = await reg.call('is_automation_mode', {}, ctxFor('sess-flag'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: true, source: 'flag' });
    }
  });

  it('returns {value:false, source:"none"} when neither signal present', async () => {
    const reg = freshRegistry();
    const result = await reg.call('is_automation_mode', {}, ctxFor('sess-none'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: false, source: 'none' });
    }
  });

  it('ignores OPENSQUID_AUTOMATION values other than "1" (strict equality)', async () => {
    process.env.OPENSQUID_AUTOMATION = 'true';
    const reg = freshRegistry();
    const result = await reg.call('is_automation_mode', {}, ctxFor('sess-true'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: false, source: 'none' });
    }
  });

  it('rejects unexpected args via strict zod schema', async () => {
    const reg = freshRegistry();
    const result = await reg.call('is_automation_mode', { extra: 'nope' }, ctxFor('sess-strict'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });
});
