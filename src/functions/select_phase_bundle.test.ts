/** GI.3 — select_phase_bundle: pure FSM-state → phase + per-gate bundle. */
import { describe, expect, it } from 'vitest';

import { selectPhaseBundle, splitByHeading } from './select_phase_bundle.js';

// A procedure.md-shaped fixture: §0 flow-picker, §1/§2/§3 phases, §On-a-BLOCK — plus a title (dropped).
const PROCEDURE = [
  '# coding-flow — operating procedure',
  '',
  '## 0. Pick the flow by request type',
  'pick RESEARCH vs the 3-stage flow.',
  '',
  '## 1. SCOPE — gate: guess-audit',
  'write the pre-research.',
  '',
  '## 2. AUTHOR — gate: spec-audit',
  'write the 11-field task spec.',
  '',
  '## 3. CODE — gate: phase-log',
  'log all 7 phases before commit.',
  '',
  '## On a BLOCK',
  'do the named step; never narrate-and-stop.',
].join('\n');

const RUBRICS = { scope: 'SCOPE-RUBRIC: never-guess', author: 'AUTHOR-RUBRIC: 11-field' };

describe('splitByHeading', () => {
  it('keys numbered headings by digit and others by heading text; drops the preamble title', () => {
    const s = splitByHeading(PROCEDURE);
    expect(Object.keys(s).sort()).toEqual(['0', '1', '2', '3', 'On a BLOCK']);
    expect(s['0']).toContain('Pick the flow');
    expect(s['On a BLOCK']).toContain('named step');
    expect(s['#']).toBeUndefined(); // the `# title` is not a `## ` section
  });
});

describe('selectPhaseBundle', () => {
  it('SCOPE states → §0 + §1 + §On-a-BLOCK + scope rubric; NOT §2/§3/author', () => {
    for (const state of ['idle', 'phases_complete', 'scoping', 'researching']) {
      const { phase, text } = selectPhaseBundle(state, PROCEDURE, RUBRICS);
      expect(phase).toBe('SCOPE');
      expect(text).toContain('Pick the flow'); // §0 always-on
      expect(text).toContain('write the pre-research'); // §1
      expect(text).toContain('do the named step'); // §On-a-BLOCK always-on
      expect(text).toContain('SCOPE-RUBRIC'); // scope rubric
      expect(text).not.toContain('write the 11-field'); // NOT §2
      expect(text).not.toContain('log all 7 phases'); // NOT §3
      expect(text).not.toContain('AUTHOR-RUBRIC');
    }
  });

  it('AUTHOR states → §0 + §2 + §On-a-BLOCK + author rubric', () => {
    for (const state of ['researched', 'spec_authored']) {
      const { phase, text } = selectPhaseBundle(state, PROCEDURE, RUBRICS);
      expect(phase).toBe('AUTHOR');
      expect(text).toContain('Pick the flow');
      expect(text).toContain('write the 11-field'); // §2
      expect(text).toContain('do the named step');
      expect(text).toContain('AUTHOR-RUBRIC');
      expect(text).not.toContain('write the pre-research'); // NOT §1
      expect(text).not.toContain('SCOPE-RUBRIC');
    }
  });

  it('CODE states → §0 + §3 + §On-a-BLOCK, NO rubric', () => {
    for (const state of ['spec_complete', 'tasks_loaded', 'phases_in_flight']) {
      const { phase, text } = selectPhaseBundle(state, PROCEDURE, RUBRICS);
      expect(phase).toBe('CODE');
      expect(text).toContain('Pick the flow');
      expect(text).toContain('log all 7 phases'); // §3
      expect(text).toContain('do the named step');
      expect(text).not.toContain('SCOPE-RUBRIC');
      expect(text).not.toContain('AUTHOR-RUBRIC');
    }
  });

  it('null/unknown state coalesces to idle → SCOPE', () => {
    expect(selectPhaseBundle(null, PROCEDURE, RUBRICS).phase).toBe('SCOPE');
    expect(selectPhaseBundle('not_a_real_state', PROCEDURE, RUBRICS).phase).toBe('SCOPE');
  });

  it('§0 + §On-a-BLOCK appear in EVERY phase (the always-on guarantee)', () => {
    for (const state of ['scoping', 'researched', 'tasks_loaded']) {
      const { text } = selectPhaseBundle(state, PROCEDURE, RUBRICS);
      expect(text).toContain('Pick the flow');
      expect(text).toContain('do the named step');
    }
  });

  it('a null rubric is simply omitted (no empty join artifact)', () => {
    const { text } = selectPhaseBundle('scoping', PROCEDURE, { scope: null, author: null });
    expect(text).toContain('write the pre-research');
    expect(text).not.toContain('null');
  });
});
