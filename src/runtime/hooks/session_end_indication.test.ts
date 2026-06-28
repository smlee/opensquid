import { describe, expect, it } from 'vitest';

import type { ActiveTask } from '../session_state.js';

import { sessionEndIndication } from './session_end_indication.js';

describe('sessionEndIndication (wg-a9af600828fe)', () => {
  const SID = '2de11a07-1de0-42f8-ac06-2da2bb7a58ea';

  const STARTED = '2026-06-28T00:00:00.000Z';

  it('names the session (short id) + the active task subject + taskId', () => {
    const active: ActiveTask = {
      id: '77',
      subject: 'drain the kanban',
      started_at: STARTED,
      taskId: 'V2ENG',
    };
    const line = sessionEndIndication(SID, active);
    expect(line).toContain('2de11a07'); // the session is named
    expect(line).toContain('drain the kanban');
    expect(line).toContain('[V2ENG]');
  });

  it('omits the taskId bracket when absent', () => {
    const active: ActiveTask = { id: '77', subject: 'a task', started_at: STARTED };
    const line = sessionEndIndication(SID, active);
    expect(line).toContain('2de11a07');
    expect(line).toMatch(/"a task"$/); // ends at the subject — no taskId bracket appended
  });

  it('says "no active task" when none is active (fail-open shape)', () => {
    const line = sessionEndIndication(SID, null);
    expect(line).toContain('2de11a07');
    expect(line).toContain('no active task');
  });
});
