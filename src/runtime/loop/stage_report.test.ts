/**
 * T2.12 / RD.1-4 — stage_report PURE renderers (zero LLM, deterministic, iso injected).
 *
 * Covers the STANDARDIZED format: the plain (no-🦑, reserved for drift/gate notices) header, Summary, the CODE
 * phase-chart, the "Next → <stage>: <work>" line, and the SCOPE-only Goal line. RD.4 removed `emitStageReport`
 * (the `.opensquid/reports/` disk writer) — the COMMUNICATION report is DISPLAYED live now (see
 * report_display.test.ts), never saved. `renderStageReport` returns a root-relative FILENAME + the body; the
 * body is the live-shown artifact.
 */
import { describe, expect, it } from 'vitest';

import {
  CODE_PHASES,
  renderStageReport,
  renderStageSummary,
  type StageReport,
} from './stage_report.js';

const ISO = '2026-06-22T13:45:07.000Z';

describe('renderStageSummary (before-stage summary — pure)', () => {
  // GENERIC — the `Will:` text is the entered stage's pack-declared `does:` (passed in), NOT a core map.
  it('renders the "Starting <STAGE> · Will: <work>" orientation line from the passed-in work text', () => {
    const { body } = renderStageSummary(
      'AUTHOR',
      'author the spec + real code covering every scoped element',
      'T-x',
      ISO,
    );
    expect(body).toContain('Starting AUTHOR · T-x · 2026-06-22');
    expect(body).not.toContain('🦑'); // reports never use the drift/gate glyph (design §4)
    expect(body).toContain('Will: author the spec + real code covering every scoped element');
  });

  it('renders a non-coding stage label + its work (the label/work are pack data, not a closed enum)', () => {
    const { body } = renderStageSummary(
      'TRIAGE',
      'sort the inbound reports by severity',
      'T-x',
      ISO,
    );
    expect(body).toContain('Starting TRIAGE · T-x · 2026-06-22');
    expect(body).toContain('Will: sort the inbound reports by severity');
  });

  it('falls back to a generic "begin this stage" when no work text is supplied', () => {
    const { body } = renderStageSummary('CODE', undefined, 'T-x', ISO);
    expect(body).toContain('Starting CODE · T-x · 2026-06-22');
    expect(body).toContain('Will: begin this stage');
  });
});

describe('renderStageReport (pure, standardized format)', () => {
  it('standardized header + Summary + Next-with-work; NO goal line / NO phases when absent', () => {
    const r: StageReport = {
      stage: 'PLAN',
      taskId: 'T-x',
      summary: 'plan complete',
      nextDirective: 'author',
      nextWork: 'author the spec + real code covering every scoped element', // pack data (the next state's `does:`)
    };
    const { path, body } = renderStageReport(r, ISO);
    expect(path).toBe('plan-T-x-2026-06-22.md'); // root-relative FILENAME only (the body is DISPLAYED, not filed)
    expect(body).toContain('After-stage report — PLAN complete · T-x · 2026-06-22');
    expect(body).not.toContain('🦑'); // no drift/gate glyph in a report body (design §4)
    expect(body).toContain('Summary: plan complete');
    // "Next" names the next stage AND what it will work on (the "tell me what you'll be working on" line)
    expect(body).toContain(
      'Next → author: author the spec + real code covering every scoped element',
    );
    expect(body).not.toContain('Goal:');
    expect(body).not.toContain('Phases:');
  });

  it('a non-coding stage label + no work text renders a bare `Next → <state>` line', () => {
    // GENERIC — `stage` is any string (a non-coding pack names its own stage); with no `nextWork` the
    // `Next →` line names the state with no work suffix (no core map to consult).
    const { path, body } = renderStageReport(
      { stage: 'TRIAGE', taskId: 'T-t', summary: 'triaged', nextDirective: 'remediate' },
      ISO,
    );
    expect(path).toBe('triage-T-t-2026-06-22.md');
    expect(body).toContain('After-stage report — TRIAGE complete · T-t · 2026-06-22');
    expect(body).toContain('Next → remediate');
    expect(body).not.toContain('Next → remediate:'); // no work suffix when nextWork is absent
  });

  it('CODE report renders the 7-phase step chart (the long, stand-out report)', () => {
    const r: StageReport = {
      stage: 'CODE',
      taskId: 'T-c',
      summary: 'all 7 phases logged',
      nextDirective: 'deploy',
      nextWork: 'verify deploy capability, then the human-accept gate',
      phases: CODE_PHASES.map((name) => ({ name, done: true })),
    };
    const { body } = renderStageReport(r, ISO);
    expect(body).toContain('Phases:');
    for (const p of CODE_PHASES) expect(body).toContain(`[x] ${p}`);
    expect(body).toContain('Next → deploy: verify deploy capability, then the human-accept gate');
  });

  it('renders the Evidence line — the deterministic gate predicates that backed the phase', () => {
    const { body } = renderStageReport(
      {
        stage: 'SCOPE',
        taskId: 'T',
        summary: 's',
        nextDirective: 'plan',
        evidence: [
          { label: 'anchors_ok', ok: true },
          { label: 'depth 4≥3', ok: true },
          { label: 'no open question', ok: true },
        ],
      },
      ISO,
    );
    expect(body).toContain('Evidence: anchors_ok ✓ · depth 4≥3 ✓ · no open question ✓');
  });

  it('marks a failed predicate with ✗', () => {
    const { body } = renderStageReport(
      {
        stage: 'PLAN',
        taskId: 'T',
        summary: 's',
        nextDirective: 'author',
        evidence: [
          { label: 'acyclic', ok: true },
          { label: 'complete', ok: false },
        ],
      },
      ISO,
    );
    expect(body).toContain('acyclic ✓ · complete ✗');
  });

  it('an unchecked phase renders an empty box', () => {
    const { body } = renderStageReport(
      {
        stage: 'CODE',
        taskId: 'T-c',
        summary: 's',
        nextDirective: 'deploy',
        phases: [
          { name: 'code', done: true },
          { name: 'test', done: false },
        ],
      },
      ISO,
    );
    expect(body).toContain('[x] code');
    expect(body).toContain('[ ] test');
  });

  it('SCOPE goal line: ON when goalAligned true, OFF/drift when false', () => {
    expect(
      renderStageReport(
        { stage: 'SCOPE', taskId: 'T-y', summary: 's', nextDirective: 'plan', goalAligned: true },
        ISO,
      ).body,
    ).toContain('Goal: on the captured goal');
    expect(
      renderStageReport(
        { stage: 'SCOPE', taskId: 'T-z', summary: 's', nextDirective: 'plan', goalAligned: false },
        ISO,
      ).body,
    ).toContain('Goal: OFF the captured goal — destination drift');
  });

  it('lowercases the stage + slices the iso date in the path', () => {
    const { path } = renderStageReport(
      { stage: 'AUTHOR', taskId: 'T-a', summary: 's', nextDirective: 'code' },
      ISO,
    );
    expect(path).toBe('author-T-a-2026-06-22.md');
  });
});
