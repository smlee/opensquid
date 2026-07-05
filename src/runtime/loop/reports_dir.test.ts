import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectReportsDir, projectReportsDirFor, saveProjectReport } from './reports_dir.js';

describe('projectReportsDir (pure)', () => {
  it('is the `reports/` subdir of an already-resolved `.opensquid` scope root', () => {
    expect(projectReportsDir('/a/b/.opensquid')).toBe(join('/a/b/.opensquid', 'reports'));
  });
});

describe('projectReportsDirFor / saveProjectReport (project scope)', () => {
  let root: string; // a temp dir standing in for a project working directory
  let scope: string; // its `.opensquid` marker dir

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reports-dir-'));
    scope = join(root, '.opensquid');
    await mkdir(scope, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves the reports dir under the project `.opensquid`, NEVER the global home', async () => {
    expect(await projectReportsDirFor(root)).toBe(join(scope, 'reports'));
  });

  it('returns null for a marker-less cwd (surfaced-only degrade, no home leak)', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'reports-bare-'));
    try {
      expect(await projectReportsDirFor(bare)).toBeNull();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('saveProjectReport writes the body atomically under reports/ and returns the abs path', async () => {
    const abs = await saveProjectReport(
      root,
      'after-stage-wg-0baaae4bcf2e-2026-07-05.md',
      '# body\n',
    );
    expect(abs).toBe(join(scope, 'reports', 'after-stage-wg-0baaae4bcf2e-2026-07-05.md'));
    expect(await readFile(abs!, 'utf8')).toBe('# body\n');
  });

  it('saveProjectReport returns null (writes nothing) when no project scope resolves', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'reports-bare-'));
    try {
      expect(await saveProjectReport(bare, 'after-stage.md', '# body\n')).toBeNull();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
