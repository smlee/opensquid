/**
 * T-AUTO-HANDOFF — render.ts: the locked resume-step rules + doc content
 * (research-flow-first when mid-flow; the doc is a gitignored projection — NO commit step; phase ledger,
 * UNRESOLVED bullets, and artifact hashes present in the rendered doc).
 */

import { describe, expect, it } from 'vitest';

import type { HandoffState } from './collect.js';
import { renderHandoverDoc, renderResumeSteps, spliceNarrative } from './render.js';

const base: HandoffState = {
  sessionId: 'abcdefgh-1234',
  generatedAt: '2026-06-10T20:00:00.000Z',
  cwd: '/u/proj',
  root: '/u',
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
  storyIssues: [
    { id: 'wg-done', title: 'shipped', status: 'closed' },
    { id: 'wg-act', title: 'in flight', status: 'in_progress' },
    { id: 'wg-1', title: 'open item', status: 'open' },
  ],
  readyIds: ['wg-1'],
  storyGoal: 'ship the kanban story',
};

describe('renderResumeSteps (the locked rules)', () => {
  it('mid-flow → FIRST step is the pre-research re-fire with path + hash; NO commit step', () => {
    const steps = renderResumeSteps(base);
    expect(steps[0]).toContain('/u/docs/research/pre.md');
    expect(steps[0]).toContain('aabbccdd');
    expect(steps[0]).toContain('RESEARCH flow');
    expect(steps.join('\n')).not.toContain('Commit the handover doc');
  });

  it('an unreadable spec artifact is surfaced as NOT READABLE (disk-truth, never narrative)', () => {
    const steps = renderResumeSteps(base);
    expect(steps.join('\n')).toContain('NOT READABLE ON DISK');
  });

  it('terminal FSM → a single step (pick the next backlog item), no commit step', () => {
    const steps = renderResumeSteps({ ...base, fsm: { state: 'phases_complete', history: [] } });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain('phases_complete');
    expect(steps.join('\n')).not.toContain('Commit the handover doc');
  });

  it('re-armed scoping with cleared artifacts → "start at SCOPE", NOT a re-fire of a shipped track (wg-4c48ef1b9969)', () => {
    // The scope_start re-arm cleared the per-track keys → artifactOf yields none.
    const steps = renderResumeSteps({
      ...base,
      fsm: { state: 'scoping', history: [] },
      activeTask: null,
      phaseLedger: [],
      artifacts: [],
    });
    const joined = steps.join('\n');
    expect(joined).toContain('start the track at SCOPE');
    expect(joined).not.toContain('Re-fire');
    expect(joined).not.toContain('NOT READABLE ON DISK');
    expect(joined).not.toContain('Commit the handover doc');
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
    expect(doc).not.toContain('Commit the handover doc');
    expect(doc).toContain('never commit it'); // surface-1 reframed as a gitignored projection
  });

  it('is deterministic in its input', () => {
    expect(renderHandoverDoc(base)).toBe(renderHandoverDoc(base));
  });

  it('KANBAN.5: renders the kanban STORY (goal + lanes) in place of the flat issue list', () => {
    const doc = renderHandoverDoc(base);
    expect(doc).toContain('Kanban story (work-graph)');
    expect(doc).toContain('ship the kanban story'); // the goal
    expect(doc).toContain('**Active**');
    expect(doc).toContain('**Backlog (ready)**');
    expect(doc).toContain('**Done**');
    expect(doc).toContain('`wg-1` open item'); // open + in readyIds → Backlog
    expect(doc).toContain('`wg-done` shipped'); // closed → Done
    expect(doc).not.toContain('Open work-graph issues'); // the old flat section is gone
  });

  it('KANBAN.5: an unreadable work-graph degrades to a marker (no throw)', () => {
    const doc = renderHandoverDoc({
      ...base,
      storyIssues: '<unreadable: boom>',
      readyIds: '<unreadable: boom>',
    });
    expect(doc).toContain('work-graph unreadable');
  });
});

describe('spliceNarrative (AHO.2 — byte-identity outside the section)', () => {
  it('inserts before RESUME; removing the section restores the original bytes', () => {
    const doc = renderHandoverDoc(base);
    const out = spliceNarrative(doc, 'a narrative line');
    expect(out).toContain('## Narrative (LLM layer — non-load-bearing)');
    expect(out.indexOf('## Narrative')).toBeLessThan(out.indexOf('## RESUME steps'));
    const restored = out.replace(
      /## Narrative \(LLM layer — non-load-bearing\)\n\na narrative line\n\n/,
      '',
    );
    expect(restored).toBe(doc);
  });
});

// HRA.1 (wg-c34349377f81) — the injection is a DIRECTIVE, not an FYI.
describe('renderInjection (the resume-on-any-prompt directive)', () => {
  it('carries the imperative, the yield clause, and the doc path', async () => {
    const { renderInjection } = await import('./render.js');
    const out = renderInjection('/u/loop/docs/handover-session-abc-auto.md');
    expect(out).toContain('PENDING');
    expect(out).toContain('NOW');
    expect(out).toContain('Yield ONLY');
    expect(out).toContain('/u/loop/docs/handover-session-abc-auto.md');
    expect(out).toContain('any first prompt');
  });
});

// HPB.1 (wg-c34349377f81) — the resume block is a POINTER-ONLY projection.
describe('renderResumeBlock (pointer-only)', () => {
  it('two lines: heading + pointer; no step content', async () => {
    const { renderResumeBlock, renderResumeSteps } = await import('./render.js');
    const state = {
      sessionId: 'abcdef1234567890',
      generatedAt: '2026-06-11T12:00:00.000Z',
      cwd: '/u/loop',
      umbrellaRoot: '/u/loop',
      fsm: { state: 'scoping' },
      activeTask: null,
      phaseSet: {},
      phaseLedger: [],
      guessAuditHead: '',
      specAuditHead: '',
      spawnLedgerTail: [],
      attestationsTail: [],
      artifacts: [
        {
          kind: 'pre_research',
          path: '/u/loop/docs/research/T-x-pre-research.md',
          sha8: 'deadbeef',
        },
      ],
      git: [],
      storyIssues: [],
      readyIds: [],
      storyGoal: '',
    } as never;

    const out = renderResumeBlock(state);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('abcdef12');
    expect(out).toContain('2026-06-11T12:00:00.000Z');
    expect(out).toContain('scoping');
    expect(out).toContain('handover-session-abcdef12-auto.md');
    expect(out).toContain('AUTO-RESUMES');
    expect(out).toContain('any first prompt');
    // The duplication pin: NO inline steps survive.
    expect(out).not.toContain('First step');
    expect(out).not.toContain('Final step');
    const steps = renderResumeSteps(state);
    if (steps.length > 0 && steps[0] !== undefined) {
      expect(out).not.toContain(steps[0]);
    }
  });
});
