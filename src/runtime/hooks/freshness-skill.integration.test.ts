/**
 * Integration test for G.5's verify-before-citing-memory skill.
 *
 * Wires the real evaluator + dispatcher + the two new G.5 primitives
 * (text_pattern_match + session_tool_history) against a hand-built Pack
 * that mirrors the YAML shipped at
 * `~/.opensquid/codexes/sangmin-personal-rules/skills/verify-before-citing-memory/skill.yaml`.
 *
 * Covers spec acceptance criteria (lines 1082–1085 + 1094–1095):
 *   - Stop with drift phrase + no tool calls this turn → warn verdict
 *   - Stop with drift phrase + verification tool called this turn → no warn
 *   - Stop with NO drift phrase → no warn
 *   - Turn reset between prompts isolates verification scope correctly
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FunctionRegistry } from '../../functions/registry.js';
import { SessionToolHistory } from '../../functions/session_tool_history.js';
import { TextPatternMatch } from '../../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../../functions/verdict.js';
import { appendTool, resetTurnLedger } from '../session_state.js';
import type { Pack, Rule, Skill, StopEvent } from '../types.js';

import { dispatchEvent } from './dispatch.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-g5-integration-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function buildFreshnessRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  reg.register(TextPatternMatch);
  reg.register(SessionToolHistory);
  registerVerdictFunctions(reg);
  return reg;
}

// Mirrors the shipped skill.yaml. The dispatcher routes verdict-level=warn
// through drift_response → block_tool policy → action.kind='warn', so the
// expected exit code is 0 and stderr carries the warn message.
function buildFreshnessPack(): Pack {
  const rule: Rule = {
    id: 'drift-state-assertion-without-verification',
    kind: 'track_check',
    process: [
      {
        call: 'text_pattern_match',
        as: 'drift_phrases',
        args: {
          text_field: 'assistantText',
          patterns: [
            '\\bper memory\\b',
            '\\bthe plan is\\b',
            '\\bcurrently planned\\b',
            '\\bdeferred\\b',
            '\\bthe spec said\\b',
            '\\bas I recall\\b',
            '\\blast time we\\b',
            '\\b(was|were) supposed to\\b',
          ],
        },
      },
      {
        call: 'session_tool_history',
        as: 'verification_tools',
        if: 'drift_phrases.matched.length > 0',
        args: {
          scope: 'current_turn',
          filter_names: [
            'Bash',
            'Read',
            'Grep',
            'mcp__opensquid__recall',
            'mcp__opensquid__inspect_skill',
          ],
        },
      },
      {
        call: 'verdict',
        if: 'drift_phrases.matched.length > 0 && verification_tools.count === 0',
        args: {
          level: 'warn',
          message: 'opensquid drift-flag: asserted state without verification',
        },
      },
    ],
  };
  const skill: Skill = {
    name: 'verify-before-citing-memory',
    load: 'preload',
    when_to_load: [],
    unloads_when: [],
    triggers: [{ kind: 'stop' }],
    rules: [rule],
  };
  return {
    name: 'sangmin-personal-rules',
    version: '0.0.1',
    scope: 'universal',
    goal: 'Codify personal anti-drift rules',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [skill],
  };
}

describe('verify-before-citing-memory — end-to-end dispatch', () => {
  it('emits a drift warn message when a drift phrase appears with no verification tool this turn', async () => {
    const sid = 'g5-sess-warn';
    // No tool calls this turn — empty ledger.
    await resetTurnLedger(sid);

    const event: StopEvent = {
      kind: 'stop',
      assistantText: 'per memory loop-engine is deferred',
    };
    const result = await dispatchEvent(
      event,
      [buildFreshnessPack()],
      buildFreshnessRegistry(),
      sid,
    );

    // The skill returns verdict.level='warn'. The Phase-1 dispatcher routes
    // every verdict through the hard-coded `block_tool` default policy, so
    // the host-visible exitCode is 2 today — pack-declared per-rule policies
    // wire in Phase 2+ via the loader. The load-bearing assertion is that
    // the drift message reaches stderr verbatim.
    expect(result.stderr).toContain('opensquid drift-flag');
  });

  it('does NOT fire when a verification tool was called this turn', async () => {
    const sid = 'g5-sess-verified';
    await appendTool(sid, 'Read'); // verification present this turn

    const event: StopEvent = {
      kind: 'stop',
      assistantText: 'per memory loop-engine is deferred',
    };
    const result = await dispatchEvent(
      event,
      [buildFreshnessPack()],
      buildFreshnessRegistry(),
      sid,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('does NOT fire when no drift phrase is present', async () => {
    const sid = 'g5-sess-clean';
    // No tool calls AND no drift phrase — the early-skip `if:` keeps the
    // verification step from running and the verdict from firing.
    const event: StopEvent = {
      kind: 'stop',
      assistantText: 'everything went fine; tests passing',
    };
    const result = await dispatchEvent(
      event,
      [buildFreshnessPack()],
      buildFreshnessRegistry(),
      sid,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('fires once turn reset clears prior-turn verification (cross-turn isolation)', async () => {
    const sid = 'g5-sess-cross-turn';
    // Turn 1: read happens; drift phrase NOT yet asserted.
    await appendTool(sid, 'Read');
    // User submits a new prompt — turn ledger resets.
    await resetTurnLedger(sid);
    // Turn 2 (this turn): no tool calls, but assistant asserts a drift phrase.
    const event: StopEvent = {
      kind: 'stop',
      assistantText: 'the spec said this was already shipped',
    };
    const result = await dispatchEvent(
      event,
      [buildFreshnessPack()],
      buildFreshnessRegistry(),
      sid,
    );

    expect(result.stderr).toContain('opensquid drift-flag');
  });
});
