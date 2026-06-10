/**
 * T-AUTO-HANDOFF — render.ts: the locked resume-step rules + doc content
 * (research-flow-first when mid-flow; commit-the-doc LAST; phase ledger,
 * UNRESOLVED bullets, and artifact hashes present in the rendered doc).
 */

import { describe, expect, it } from 'vitest';

import type { HandoffState } from './collect.js';
import { renderHandoverDoc, renderResumeSteps } from './render.js';

const base: HandoffState = {
  sessionId: 'abcdefgh-1234',
  generatedAt: '2026-06-10T20:00:00.000Z',
  cwd: '/u/proj',
  umbrellaRoot: '/u',
  fsm: {
    state: 'spec_complete',
    history: [
      { state: 'researched', at: 't1' },
      { state: 'spec_complete', at: 't2' },
    ],
  },
  activeTask: { id: '3', subject: 'X', started_at: 'z', taskId: 'T.1' },
  phaseSet: { task_id: '3', phases: ['pre_research'] },
  phaseLedger: [{ phase: 'pre_research', note: 'GUESS_FREE on v2' }],
  guessAuditHead: 'VERDICT: UNRESOLVED\n- the one open bullet',
  specAuditHead: 'VERDICT: SPEC_COMPLETE',
  spawnLedgerTail: ['{"outcome":"verdict"}'],
  attestationsTail: ['{"sha":"x","allowed":true}'],
  artifacts: [
    { kind: 'pre_research', path: '/u/docs/research/pre.md', sha8: 'aabbccdd' },
    { kind: 'spec', path: '/u/docs/tasks/spec.md', sha8: null },
  ],
  git: [{ repo: '/u/proj', statusShort: ' M x.ts', unpushed: 'abc123 wip' }],
  openIssues: [{ id: 'wg-1', title: 'open item' }],
};

describe('renderResumeSteps (the locked rules)', () => {
  it('mid-flow → FIRST step is the pre-research re-fire with path + hash; LAST is commit-the-doc', () => {
    const steps = renderResumeSteps(base);
    expect(steps[0]).toContain('/u/docs/research/pre.md');
    expect(steps[0]).toContain('aabbccdd');
    expect(steps[0]).toContain('RESEARCH flow');
    expect(steps.at(-1)).toContain('Commit the handover doc');
  });

  it('an unreadable spec artifact is surfaced as NOT READABLE (disk-truth, never narrative)', () => {
    const steps = renderResumeSteps(base);
    expect(steps.join('\n')).toContain('NOT READABLE ON DISK');
  });

  it('terminal FSM → no recovery steps, but commit-the-doc still LAST', () => {
    const steps = renderResumeSteps({ ...base, fsm: { state: 'phases_complete', history: [] } });
    expect(steps[0]).toContain('phases_complete');
    expect(steps.at(-1)).toContain('Commit the handover doc');
  });
});

describe('renderHandoverDoc', () => {
  it('carries the surfaces index, FSM history, phase ledger, UNRESOLVED bullet, artifact hashes', () => {
    const doc = renderHandoverDoc(base);
    expect(doc).toContain('The handoff lives on 4 surfaces');
    expect(doc).toContain('spec_complete');
    expect(doc).toContain('GUESS_FREE on v2'); // durable phase-ledger note
    expect(doc).toContain('the one open bullet'); // UNRESOLVED resume point
    expect(doc).toContain('aabbccdd');
    expect(doc).toContain('handoff-abcdefgh'); // wg surface key in the index? sid8 present
    expect(doc).toContain('Commit the handover doc');
  });

  it('is deterministic in its input', () => {
    expect(renderHandoverDoc(base)).toBe(renderHandoverDoc(base));
  });
});
