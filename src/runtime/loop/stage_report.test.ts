/**
 * T2.12 — stage_report renderer + emitter (zero LLM, deterministic, iso injected).
 *
 * Covers: renderStageReport path + plain-header body (with AND without the goal-alignment line);
 * emitStageReport writes the dated file under a TEMP root (never the real repo docs/reports/).
 */
import { describe, expect, it } from 'vitest';

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emitStageReport, renderStageReport, type StageReport } from './stage_report.js';

const ISO = '2026-06-22T13:45:07.000Z';

describe('renderStageReport (pure)', () => {
  it('plain-header body + dated path, NO goal line when goalAligned is undefined', () => {
    const r: StageReport = {
      stage: 'PLAN',
      taskId: 'T-x',
      summary: 'plan complete',
      nextDirective: 'author',
    };
    const { path, body } = renderStageReport(r, ISO);
    expect(path).toBe(join('docs/reports', 'plan-T-x-2026-06-22.md'));
    expect(body).toBe(
      '# PLAN report — T-x (2026-06-22T13:45:07.000Z)\n\n## Summary\nplan complete\n\n## Next\nauthor\n',
    );
    expect(body).not.toContain('## Goal alignment');
  });

  it('emits the goal-alignment line (ON) when goalAligned === true', () => {
    const { body } = renderStageReport(
      {
        stage: 'SCOPE',
        taskId: 'T-y',
        summary: 'scope complete',
        nextDirective: 'plan',
        goalAligned: true,
      },
      ISO,
    );
    expect(body).toContain('## Goal alignment\non the captured goal');
  });

  it('emits the goal-alignment line (OFF/drift) when goalAligned === false', () => {
    const { body } = renderStageReport(
      {
        stage: 'SCOPE',
        taskId: 'T-z',
        summary: 'scope complete',
        nextDirective: 'plan',
        goalAligned: false,
      },
      ISO,
    );
    expect(body).toContain('## Goal alignment\nOFF the captured goal — destination drift');
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
  it('atomic-writes the body to join(root, path) and returns the root-relative path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stage-report-'));
    const r: StageReport = {
      stage: 'DEPLOY',
      taskId: 'T-deploy',
      summary: 'deploy complete',
      nextDirective: 'shipped',
    };
    const rel = await emitStageReport(root, r, ISO);
    expect(rel).toBe(join('docs/reports', 'deploy-T-deploy-2026-06-22.md'));
    const onDisk = await readFile(join(root, rel), 'utf8');
    expect(onDisk).toBe(renderStageReport(r, ISO).body);
  });
});
