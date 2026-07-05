import { describe, expect, it } from 'vitest';

import { renderFailureReport, type FailureReport } from './failure_report.js';

const ISO = '2026-07-05T12:34:56.000Z';
const DATE = '2026-07-05';

const base: FailureReport = {
  taskId: 'wg-abc123',
  kind: 'held_gate',
  reason: 'the doc-only gate holds — no code-write permission',
  criterion: 'src/runtime/loop/doc_only_gate.ts:42',
  evidence: 'allow-code-write flag absent',
  resolvingAction: 'run /code-write to grant the flag, then re-run the lap',
};

describe('renderFailureReport', () => {
  it('renders every field, the kind, and the date into the body', () => {
    const { body } = renderFailureReport(base, ISO);
    expect(body).toContain(base.reason);
    expect(body).toContain(base.criterion);
    expect(body).toContain(base.evidence);
    expect(body).toContain(base.resolvingAction);
    expect(body).toContain(base.kind);
    expect(body).toContain(DATE);
  });

  it('leads with a PLAIN header and NEVER uses the 🦑 emoji', () => {
    const { body } = renderFailureReport(base, ISO);
    expect(body).not.toContain('🦑');
    expect(body.startsWith('Failure report — ')).toBe(true);
  });

  it('ends with a trailing newline', () => {
    const { body } = renderFailureReport(base, ISO);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('derives the dated root-relative filename from iso', () => {
    const { path } = renderFailureReport(base, ISO);
    expect(path).toBe(`failure-${base.taskId}-${DATE}.md`);
  });

  it('renders each failure kind into the header', () => {
    for (const kind of ['wedge', 'held_gate', 'crash'] as const) {
      const { body } = renderFailureReport({ ...base, kind }, ISO);
      expect(body).toContain(`Failure report — ${kind} · ${base.taskId} · ${DATE}`);
    }
  });

  it('is pure: same input + iso → same output', () => {
    const a = renderFailureReport(base, ISO);
    const b = renderFailureReport(base, ISO);
    expect(a).toEqual(b);
  });
});
