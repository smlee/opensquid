/**
 * Tests for `stage_inject` — the v2 per-stage instruction injector. Seeds a live session-level FSM state via
 * `persistActorState` (the v2 actor-state writer; `readFsmStateRaw` reads the same `fsmStateKey(pack, null)`)
 * and asserts the injected bundle = the CURRENT stage's procedure (+ rubric for the audited stages, none for
 * deploy), with the dedup + terminal-state paths. Runs against the REAL shipped fullstack-flow files.
 */
import { describe, expect, it } from 'vitest';

import type { Event } from '../runtime/event.js';
import { persistActorState } from '../runtime/fsm_state.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { registerStageInject } from './stage_inject.js';

const PACK = 'fullstack-flow';
const ISO = '2026-06-29T00:00:00.000Z';
const ev = (kind: string): Event => ({ kind } as unknown as Event);
const ctx = (sessionId: string, event: Event): EvalCtx => ({
  event,
  bindings: new Map<string, unknown>(),
  sessionId,
  packId: PACK,
});
function reg(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerStageInject(r);
  return r;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const content = (v: any): string => (v && v.kind === 'inject_context' ? (v.content as string) : '');

describe('stage_inject', () => {
  it('injects the current stage procedure + rubric before action (scope)', async () => {
    const sid = 'si-scope';
    await persistActorState(sid, PACK, 'scope', ISO, null);
    const res = await reg().call('stage_inject', {}, ctx(sid, ev('prompt_submit')));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(content(res.value)).toContain('CHECKPOINT'); // slot 1: where you are
      expect(content(res.value)).toContain('stage: scope');
      expect(content(res.value)).toContain('SCOPE'); // slot 2: the procedure
      expect(content(res.value)).toContain('NEVER-GUESS'); // slot 3: the scope rubric (audited stage)
    }
  });

  it('injects procedure ONLY for deploy (deploy has no rubric)', async () => {
    const sid = 'si-deploy';
    await persistActorState(sid, PACK, 'deploy', ISO, null);
    const res = await reg().call('stage_inject', {}, ctx(sid, ev('prompt_submit')));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(content(res.value)).toContain('DEPLOY'); // the procedure
      expect(content(res.value)).not.toContain('NEVER-GUESS'); // no rubric injected for deploy
    }
  });

  it('injects nothing for a terminal/decision state with no procedure file', async () => {
    const sid = 'si-done';
    await persistActorState(sid, PACK, 'done', ISO, null);
    const res = await reg().call('stage_inject', {}, ctx(sid, ev('prompt_submit')));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeNull();
  });

  it('dedups a same-stage tool_call (channel b) after a prompt_submit refresh', async () => {
    const sid = 'si-dedup';
    await persistActorState(sid, PACK, 'author', ISO, null);
    const r = reg();
    const first = await r.call('stage_inject', {}, ctx(sid, ev('prompt_submit')));
    expect(first.ok && content(first.value)).toContain('AUTHOR'); // refresh injects + records the stage
    const dup = await r.call('stage_inject', {}, ctx(sid, ev('tool_call')));
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.value).toBeNull(); // same stage on tool_call → deduped
  });
});
