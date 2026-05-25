/**
 * Tests for `session_tool_history` primitive (G.5).
 *
 * Coverage per spec test fixtures (lines 1079–1081):
 *   - Current turn returns the appended tool names in order
 *   - filter_names narrows to a subset
 *   - scope: 'session' returns names across turns (turn reset preserved)
 *   - Missing ledger yields empty result (no throw, no crash)
 *   - Session list is trimmed to SESSION_LEDGER_CAP (200) on growth
 *
 * Isolation: per-test temp OPENSQUID_HOME so the on-disk ledger files
 * never leak across cases.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_LEDGER_CAP, appendTool, resetTurnLedger } from '../runtime/session_state.js';
import type { Event } from '../runtime/types.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { SessionToolHistory } from './session_tool_history.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-tool-history-test-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function freshRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  reg.register(SessionToolHistory);
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

describe('session_tool_history', () => {
  it('returns ledger entries appended this turn in order', async () => {
    const sid = 'sess-current';
    await appendTool(sid, 'Bash');
    await appendTool(sid, 'Read');
    await appendTool(sid, 'Edit');

    const reg = freshRegistry();
    const result = await reg.call('session_tool_history', { scope: 'current_turn' }, ctxFor(sid));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ tools: ['Bash', 'Read', 'Edit'], count: 3 });
    }
  });

  it('filters by filter_names allow-list', async () => {
    const sid = 'sess-filter';
    await appendTool(sid, 'Bash');
    await appendTool(sid, 'Read');
    await appendTool(sid, 'Edit');

    const reg = freshRegistry();
    const result = await reg.call(
      'session_tool_history',
      { scope: 'current_turn', filter_names: ['Bash'] },
      ctxFor(sid),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ tools: ['Bash'], count: 1 });
    }
  });

  it('scope: session returns tools across all turns (turn reset preserved)', async () => {
    const sid = 'sess-cross-turn';
    await appendTool(sid, 'Bash');
    await appendTool(sid, 'Read');
    // Turn boundary: new prompt arrives, turn slice resets.
    await resetTurnLedger(sid);
    await appendTool(sid, 'Edit');

    const reg = freshRegistry();
    const turnRes = await reg.call('session_tool_history', { scope: 'current_turn' }, ctxFor(sid));
    expect(turnRes.ok).toBe(true);
    if (turnRes.ok) {
      expect(turnRes.value).toEqual({ tools: ['Edit'], count: 1 });
    }

    const sessRes = await reg.call('session_tool_history', { scope: 'session' }, ctxFor(sid));
    expect(sessRes.ok).toBe(true);
    if (sessRes.ok) {
      expect(sessRes.value).toEqual({ tools: ['Bash', 'Read', 'Edit'], count: 3 });
    }
  });

  it('returns empty {tools:[], count:0} when no ledger exists yet', async () => {
    const reg = freshRegistry();
    const result = await reg.call('session_tool_history', {}, ctxFor('sess-empty'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ tools: [], count: 0 });
    }
  });

  it('session list is trimmed to SESSION_LEDGER_CAP on overflow', async () => {
    const sid = 'sess-trim';
    // Append CAP + 10 tools; the oldest 10 should be evicted.
    const total = SESSION_LEDGER_CAP + 10;
    for (let i = 0; i < total; i++) {
      await appendTool(sid, `Tool${String(i)}`);
    }

    const reg = freshRegistry();
    const result = await reg.call('session_tool_history', { scope: 'session' }, ctxFor(sid));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as { tools: string[]; count: number };
      expect(v.count).toBe(SESSION_LEDGER_CAP);
      expect(v.tools[0]).toBe('Tool10');
      expect(v.tools[v.tools.length - 1]).toBe(`Tool${String(total - 1)}`);
    }
  });

  it('defaults scope to current_turn when omitted', async () => {
    const sid = 'sess-default-scope';
    await appendTool(sid, 'Bash');
    await resetTurnLedger(sid);
    await appendTool(sid, 'Read');

    const reg = freshRegistry();
    const result = await reg.call('session_tool_history', {}, ctxFor(sid));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ tools: ['Read'], count: 1 });
    }
  });
});
