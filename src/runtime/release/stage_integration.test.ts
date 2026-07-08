/** AGF.5 (wg-72134554548f) — mergeToStage: merge auto/wg-<id> → persistent `stage`, suite-gate, rc-tag on green.
 *  A conflict (abort) or a red suite (reset HEAD~1) → NO integration, NO tag, stage left green. Stubbed StageIo —
 *  NO real git. */
import { describe, it, expect } from 'vitest';
import { mergeToStage, STAGE_BRANCH, type StageIo } from './stage_integration.js';

function io(over: Partial<StageIo> = {}): StageIo & { log: string[] } {
  const log: string[] = [];
  const base: StageIo = {
    checkout: (ref) => (log.push(`checkout:${ref}`), Promise.resolve()),
    mergeNoFf: (b) => (log.push(`merge:${b}`), Promise.resolve()),
    abortMerge: () => (log.push('abort'), Promise.resolve()),
    resetHard: (ref) => (log.push(`reset:${ref}`), Promise.resolve()),
    runSuite: () => (log.push('suite'), Promise.resolve(true)),
    tagPush: (t) => (log.push(`tag:${t}`), Promise.resolve()),
    ...over,
  };
  return Object.assign(base, { log });
}

describe('AGF.5 mergeToStage', () => {
  it('clean merge + green suite → { integrated:true }, rc-tag pushed on the one stage branch', async () => {
    const i = io();
    const r = await mergeToStage('auto/wg-x', 'v0.5.11-rc.1', '/repo', i);
    expect(r).toEqual({ integrated: true });
    expect(i.log).toEqual([
      `checkout:${STAGE_BRANCH}`,
      'merge:auto/wg-x',
      'suite',
      'tag:v0.5.11-rc.1',
    ]);
  });

  it('a CONFLICT (mergeNoFf throws) → abort, { integrated:false }, NO suite, NO tag', async () => {
    const i = io({ mergeNoFf: () => Promise.reject(new Error('conflict')) });
    const r = await mergeToStage('auto/wg-x', 'v0.5.11-rc.1', '/repo', i);
    expect(r).toEqual({ integrated: false });
    expect(i.log).toContain('abort');
    expect(i.log).not.toContain('suite');
    expect(i.log.some((l) => l.startsWith('tag:'))).toBe(false);
  });

  it('a RED suite after a clean merge → reset HEAD~1 (rolled back), { integrated:false }, NO tag — stage stays green', async () => {
    const i = io({ runSuite: () => Promise.resolve(false) });
    const r = await mergeToStage('auto/wg-x', 'v0.5.11-rc.1', '/repo', i);
    expect(r).toEqual({ integrated: false });
    expect(i.log).toContain('reset:HEAD~1');
    expect(i.log.some((l) => l.startsWith('tag:'))).toBe(false);
  });
});
