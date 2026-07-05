import { describe, expect, it } from 'vitest';

import { renderFollowReminder } from './follow_reminder.js';

describe('renderFollowReminder', () => {
  it('always contains the stage and the procedure', () => {
    const out = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module against the plan',
    });
    expect(out).toContain('author');
    expect(out).toContain('write the module against the plan');
  });

  it('is imperative and points back at the current stage procedure', () => {
    const out = renderFollowReminder({
      stage: 'plan',
      procedure: 'decompose the scope into ordered issues',
    });
    expect(out).toContain('Stay on the plan procedure.');
  });

  it('ends with a trailing newline', () => {
    const out = renderFollowReminder({ stage: 'scope', procedure: 'capture the ask' });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('includes a Rubric section iff a rubric is given', () => {
    const withRubric = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module',
      rubric: 'every design element cited and delivered',
    });
    expect(withRubric).toContain('Rubric:');
    expect(withRubric).toContain('every design element cited and delivered');

    const withoutRubric = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module',
    });
    expect(withoutRubric).not.toContain('Rubric:');
  });

  it('treats an empty/whitespace rubric as absent', () => {
    const out = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module',
      rubric: '   ',
    });
    expect(out).not.toContain('Rubric:');
  });

  it('includes a leading drift note iff a drift signal is given', () => {
    const withDrift = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module',
      drift: 'started editing unrelated files',
    });
    expect(withDrift).toContain('Drift noticed:');
    expect(withDrift).toContain('started editing unrelated files');

    const withoutDrift = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module',
    });
    expect(withoutDrift).not.toContain('Drift noticed:');
  });

  it('treats an empty/whitespace drift signal as absent', () => {
    const out = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module',
      drift: '  ',
    });
    expect(out).not.toContain('Drift noticed:');
  });

  it('never emits the literal string "undefined"', () => {
    const full = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module',
      rubric: 'all criteria met',
      drift: 'scope creep',
    });
    const minimal = renderFollowReminder({ stage: 'author', procedure: 'write the module' });
    expect(full).not.toContain('undefined');
    expect(minimal).not.toContain('undefined');
  });

  it('never uses the 🦑 marker (reserved for drift/gate notices)', () => {
    const out = renderFollowReminder({
      stage: 'author',
      procedure: 'write the module',
      rubric: 'all criteria met',
      drift: 'scope creep',
    });
    expect(out).not.toContain('🦑');
  });
});
