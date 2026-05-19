/**
 * Tests for `unloads_when` condition evaluator + tick driver.
 *
 * Coverage matrix:
 *   - Each condition kind has a positive + negative case.
 *   - OR semantics across multiple conditions.
 *   - Empty list never unloads.
 *   - Shorthand normalization (bare-string + single-key object).
 *   - Tick driver: prompt_submit bumps counter, stop sets taskCompleted,
 *     session_end sets sessionEnded, tool_call is a no-op.
 *   - `idle_n_turns` boundary: n=5 with counter=5 fires; counter=4 does not.
 */

import { describe, expect, it } from 'vitest';

import { advanceTick, createTick, resetTick } from './tick.js';
import {
  normalizeUnloadCondition,
  shouldUnload,
  UnloadCondition,
  type TickState,
} from './unload_conditions.js';
import type { Event } from './types.js';

const baseTick: TickState = {
  turnsSinceActivation: 0,
  taskCompleted: false,
  sessionEnded: false,
};

describe('shouldUnload — session_ends', () => {
  it('fires when tick.sessionEnded is true', () => {
    expect(shouldUnload([{ kind: 'session_ends' }], { ...baseTick, sessionEnded: true })).toBe(
      true,
    );
  });

  it('does not fire when tick.sessionEnded is false', () => {
    expect(shouldUnload([{ kind: 'session_ends' }], baseTick)).toBe(false);
  });
});

describe('shouldUnload — active_task_completes', () => {
  it('fires when tick.taskCompleted is true', () => {
    expect(
      shouldUnload([{ kind: 'active_task_completes' }], { ...baseTick, taskCompleted: true }),
    ).toBe(true);
  });

  it('does not fire when tick.taskCompleted is false', () => {
    expect(shouldUnload([{ kind: 'active_task_completes' }], baseTick)).toBe(false);
  });
});

describe('shouldUnload — idle_n_turns', () => {
  it('fires when turnsSinceActivation === n (boundary)', () => {
    expect(
      shouldUnload([{ kind: 'idle_n_turns', n: 5 }], { ...baseTick, turnsSinceActivation: 5 }),
    ).toBe(true);
  });

  it('fires when turnsSinceActivation > n', () => {
    expect(
      shouldUnload([{ kind: 'idle_n_turns', n: 5 }], { ...baseTick, turnsSinceActivation: 7 }),
    ).toBe(true);
  });

  it('does not fire when turnsSinceActivation < n', () => {
    expect(
      shouldUnload([{ kind: 'idle_n_turns', n: 5 }], { ...baseTick, turnsSinceActivation: 4 }),
    ).toBe(false);
  });
});

describe('shouldUnload — OR semantics + empty list', () => {
  it('returns false on empty conditions', () => {
    expect(shouldUnload([], baseTick)).toBe(false);
  });

  it('returns true when ANY condition in a multi-condition list fires', () => {
    const conds: UnloadCondition[] = [
      { kind: 'session_ends' }, // miss
      { kind: 'idle_n_turns', n: 3 }, // hit
      { kind: 'active_task_completes' }, // miss
    ];
    expect(shouldUnload(conds, { ...baseTick, turnsSinceActivation: 3 })).toBe(true);
  });

  it('returns false when all conditions miss', () => {
    const conds: UnloadCondition[] = [
      { kind: 'session_ends' },
      { kind: 'idle_n_turns', n: 10 },
      { kind: 'active_task_completes' },
    ];
    expect(shouldUnload(conds, { ...baseTick, turnsSinceActivation: 3 })).toBe(false);
  });
});

describe('UnloadCondition schema — shorthand normalization', () => {
  it('parses bare string "session_ends" as {kind: session_ends}', () => {
    expect(UnloadCondition.parse('session_ends')).toEqual({ kind: 'session_ends' });
  });

  it('parses bare string "active_task_completes" as {kind: active_task_completes}', () => {
    expect(UnloadCondition.parse('active_task_completes')).toEqual({
      kind: 'active_task_completes',
    });
  });

  it('parses single-key object {idle_n_turns: 5} as canonical form', () => {
    expect(UnloadCondition.parse({ idle_n_turns: 5 })).toEqual({
      kind: 'idle_n_turns',
      n: 5,
    });
  });

  it('passes canonical form through unchanged', () => {
    expect(UnloadCondition.parse({ kind: 'session_ends' })).toEqual({ kind: 'session_ends' });
  });

  it('rejects an unknown bare-string condition', () => {
    const result = UnloadCondition.safeParse('mystery_event');
    expect(result.success).toBe(false);
  });

  it('rejects idle_n_turns with a non-integer or non-positive n', () => {
    expect(UnloadCondition.safeParse({ kind: 'idle_n_turns', n: 0 }).success).toBe(false);
    expect(UnloadCondition.safeParse({ kind: 'idle_n_turns', n: -1 }).success).toBe(false);
    expect(UnloadCondition.safeParse({ kind: 'idle_n_turns', n: 1.5 }).success).toBe(false);
  });

  it('normalizeUnloadCondition returns non-string/non-object values unchanged', () => {
    expect(normalizeUnloadCondition(42)).toBe(42);
    expect(normalizeUnloadCondition(null)).toBe(null);
  });
});

describe('tick driver — advanceTick', () => {
  it('increments turnsSinceActivation on prompt_submit only', () => {
    const t0 = createTick();
    const t1 = advanceTick(t0, { kind: 'prompt_submit', prompt: 'hi' });
    expect(t1.turnsSinceActivation).toBe(1);
    const t2 = advanceTick(t1, { kind: 'prompt_submit', prompt: 'again' });
    expect(t2.turnsSinceActivation).toBe(2);
  });

  it('does NOT increment turnsSinceActivation on tool_call', () => {
    const t0 = createTick();
    const evt: Event = { kind: 'tool_call', tool: 'Bash', args: { command: 'ls' } };
    const t1 = advanceTick(t0, evt);
    expect(t1.turnsSinceActivation).toBe(0);
  });

  it('sets taskCompleted on stop event', () => {
    const t0 = createTick();
    const t1 = advanceTick(t0, { kind: 'stop', assistantText: 'done' });
    expect(t1.taskCompleted).toBe(true);
    expect(t1.sessionEnded).toBe(false);
  });

  it('sets sessionEnded on session_end event', () => {
    const t0 = createTick();
    const t1 = advanceTick(t0, { kind: 'session_end', sessionId: 's1' });
    expect(t1.sessionEnded).toBe(true);
    expect(t1.taskCompleted).toBe(false);
  });

  it('treats the input state as immutable (returns a new object)', () => {
    const t0 = createTick();
    const t1 = advanceTick(t0, { kind: 'prompt_submit', prompt: 'x' });
    expect(t0.turnsSinceActivation).toBe(0); // not mutated
    expect(t1).not.toBe(t0);
  });

  it('resetTick zeroes all counters', () => {
    const dirty: TickState = { turnsSinceActivation: 5, taskCompleted: true, sessionEnded: true };
    const fresh = resetTick();
    expect(fresh).toEqual({ turnsSinceActivation: 0, taskCompleted: false, sessionEnded: false });
    // sanity: dirty was not aliased
    expect(dirty.turnsSinceActivation).toBe(5);
  });
});

describe('tick + shouldUnload integration', () => {
  it('idle_n_turns fires only after n prompt_submit events', () => {
    let t = createTick();
    const cond: UnloadCondition[] = [{ kind: 'idle_n_turns', n: 3 }];
    expect(shouldUnload(cond, t)).toBe(false);
    t = advanceTick(t, { kind: 'prompt_submit', prompt: 'a' });
    expect(shouldUnload(cond, t)).toBe(false);
    t = advanceTick(t, { kind: 'prompt_submit', prompt: 'b' });
    expect(shouldUnload(cond, t)).toBe(false);
    t = advanceTick(t, { kind: 'prompt_submit', prompt: 'c' });
    expect(shouldUnload(cond, t)).toBe(true);
  });
});
