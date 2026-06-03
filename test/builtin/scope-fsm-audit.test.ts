/**
 * scope-fsm guess-audit (C2/C3) — the capable-model adversarial audit + the
 * deterministic loop-back, driven through the real dispatcher with the model
 * call STUBBED. Proves: an UNRESOLVED verdict loops the FSM back from
 * `researched` to `researching` (so the research-before-code gate keeps
 * blocking) and surfaces the audit; a GUESS_FREE verdict leaves it at
 * `researched` (code now allowed).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerEventFunctions } from '../../src/functions/event.js';
import { registerFsmFunctions } from '../../src/functions/fsm.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import { registerVerdictFunctions } from '../../src/functions/verdict.js';
import { loadPack } from '../../src/packs/loader.js';
import { ok } from '../../src/runtime/result.js';
import { readFsmState } from '../../src/runtime/fsm_state.js';
import { dispatchEvent } from '../../src/runtime/hooks/dispatch.js';
import type { Event, Pack } from '../../src/runtime/types.js';

/** Registry whose stubbed `subagent_call` (the capable-model audit) returns a
 *  fixed verdict text — so the gate's determinism is what's under test. */
function registry(auditText: string): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerVerdictFunctions(r);
  r.register({
    name: 'subagent_call',
    argSchema: z.object({
      model: z.string(),
      prompt: z.string(),
      timeout_ms: z.number().optional(),
    }),
    durable: false,
    execute: () => Promise.resolve(ok(auditText)),
  });
  return r;
}

const writeResearch: Event = {
  kind: 'tool_call',
  tool: 'Write',
  args: {
    file_path: 'docs/research/feature-pre-research-2026.md',
    content: '# Pre-research\n\nWe will use library X (no citation).',
  },
};

describe('scope-fsm guess-audit — capable-model audit + deterministic loop-back', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-scope-audit-'));
    process.env.OPENSQUID_HOME = tempHome;
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('UNRESOLVED audit → loops researched back to researching + surfaces the audit', async () => {
    const pack: Pack = await loadPack(resolve('packs/builtin/scope-fsm'));
    const reg = registry('VERDICT: UNRESOLVED\n- "use library X": asserted without a citation.');
    const sid = 'audit-fail';
    const r = await dispatchEvent(writeResearch, [pack], reg, sid);
    // The research advanced to `researched`, then the failed audit looped it back.
    expect(await readFsmState(sid, 'scope-fsm', pack.fsm!)).toBe('researching');
    expect(r.stderr).toMatch(/looped back to research/);
    expect(r.stderr).toMatch(/use library X/); // the audit detail is surfaced
  });

  it('GUESS_FREE audit → stays at researched (code now allowed)', async () => {
    const pack: Pack = await loadPack(resolve('packs/builtin/scope-fsm'));
    const reg = registry('VERDICT: GUESS_FREE');
    const sid = 'audit-pass';
    const r = await dispatchEvent(writeResearch, [pack], reg, sid);
    expect(await readFsmState(sid, 'scope-fsm', pack.fsm!)).toBe('researched');
    expect(r.stderr).not.toMatch(/looped back/);
  });

  it('a non-research write does not trigger the (expensive) audit', async () => {
    const pack: Pack = await loadPack(resolve('packs/builtin/scope-fsm'));
    let called = 0;
    const r = new FunctionRegistry();
    registerEventFunctions(r);
    registerFsmFunctions(r);
    registerVerdictFunctions(r);
    r.register({
      name: 'subagent_call',
      argSchema: z.object({
        model: z.string(),
        prompt: z.string(),
        timeout_ms: z.number().optional(),
      }),
      durable: false,
      execute: () => {
        called += 1;
        return Promise.resolve(ok('VERDICT: UNRESOLVED'));
      },
    });
    const codeWrite: Event = { kind: 'tool_call', tool: 'Write', args: { file_path: 'src/x.ts' } };
    await dispatchEvent(codeWrite, [pack], r, 'audit-skip');
    expect(called).toBe(0);
  });
});
