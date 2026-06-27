/**
 * T2.12 — stage_report renderer + emitter (zero LLM, deterministic, iso injected).
 *
 * Covers the STANDARDIZED format: the 🦑 header, Summary, the CODE phase-chart, the "Next → <stage>: <work>"
 * line, and the SCOPE-only Goal line. emitStageReport returns {path, body} + writes the dated file.
 */
import { describe, expect, it } from 'vitest';

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODE_PHASES,
  emitStageReport,
  renderStageReport,
  type StageReport,
} from './stage_report.js';

const ISO = '2026-06-22T13:45:07.000Z';

describe('renderStageReport (pure, standardized format)', () => {
  it('standardized header + Summary + Next-with-work; NO goal line / NO phases when absent', () => {
    const r: StageReport = {
      stage: 'PLAN',
      taskId: 'T-x',
      summary: 'plan complete',
      nextDirective: 'author',
    };
    const { path, body } = renderStageReport(r, ISO);
    expect(path).toBe(join('docs/reports', 'plan-T-x-2026-06-22.md'));
    expect(body).toContain('🦑 Phase report — PLAN complete · T-x · 2026-06-22');
    expect(body).toContain('Summary: plan complete');
    // "Next" names the next stage AND what it will work on (the "tell me what you'll be working on" line)
    expect(body).toContain(
      'Next → author: author the spec + real code covering every scoped element',
    );
    expect(body).not.toContain('Goal:');
    expect(body).not.toContain('Phases:');
  });

  it('CODE report renders the 7-phase step chart (the long, stand-out report)', () => {
    const r: StageReport = {
      stage: 'CODE',
      taskId: 'T-c',
      summary: 'all 7 phases logged',
      nextDirective: 'deploy',
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
    expect(path).toBe(join('docs/reports', 'author-T-a-2026-06-22.md'));
  });
});

describe('emitStageReport (writes a dated file under a temp root)', () => {
  it('atomic-writes the body to join(root, path) and returns {path, body}', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stage-report-'));
    const r: StageReport = {
      stage: 'DEPLOY',
      taskId: 'T-deploy',
      summary: 'deploy complete',
      nextDirective: 'accepted',
    };
    const { path, body } = await emitStageReport(root, r, ISO);
    expect(path).toBe(join('docs/reports', 'deploy-T-deploy-2026-06-22.md'));
    expect(await readFile(join(root, path), 'utf8')).toBe(body);
    expect(body).toBe(renderStageReport(r, ISO).body);
  });
});
