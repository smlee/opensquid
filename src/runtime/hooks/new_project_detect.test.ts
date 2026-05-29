/**
 * T-CTX-LOOP CTX.4 — unit tests for `detectNewProject`.
 *
 * Strategy: mkdtemp-isolated OPENSQUID_HOME + test-seam claudeProjectsRoot
 * so the live ~/.opensquid/ and ~/.claude/projects/ stay untouched
 * (ASG.1 + ASG5 pattern). The readCwd seam injects synthetic cwd values
 * without touching the actual session_state file.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectNewProject } from './new_project_detect.js';

let tempHome: string;
let tempClaude: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-ctx4-'));
  tempClaude = await mkdtemp(join(tmpdir(), 'claude-projects-ctx4-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
  await rm(tempClaude, { recursive: true, force: true });
});

describe('detectNewProject', () => {
  it('returns the new-project additionalContext line on first call when cwd has no claude project memory dir', async () => {
    const sid = 'ctx4-fresh';
    const cwd = '/Users/slee/projects/brand-new-thing';

    const result = await detectNewProject(sid, {
      claudeProjectsRoot: tempClaude,
      readCwd: () => Promise.resolve(cwd),
    });

    expect(result).not.toBeNull();
    expect(result).toContain('[opensquid CTX.4 — new project detected]');
    expect(result).toContain(cwd);
    expect(result).toContain('mcp__opensquid__memorize');
  });

  it('returns null on second call in the same session (once-marker)', async () => {
    const sid = 'ctx4-once';
    const cwd = '/Users/slee/projects/brand-new-thing';

    const first = await detectNewProject(sid, {
      claudeProjectsRoot: tempClaude,
      readCwd: () => Promise.resolve(cwd),
    });
    const second = await detectNewProject(sid, {
      claudeProjectsRoot: tempClaude,
      readCwd: () => Promise.resolve(cwd),
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('returns null when the project memory dir already exists (known project)', async () => {
    const sid = 'ctx4-known';
    const cwd = '/Users/slee/projects/known-project';
    // Pre-create the encoded memory dir
    const encoded = cwd.replace(/\//g, '-');
    await mkdir(join(tempClaude, encoded, 'memory'), { recursive: true });

    const result = await detectNewProject(sid, {
      claudeProjectsRoot: tempClaude,
      readCwd: () => Promise.resolve(cwd),
    });

    expect(result).toBeNull();
  });

  it('returns null when cwd is unknown (no PreToolUse has fired yet)', async () => {
    const sid = 'ctx4-no-cwd';
    const result = await detectNewProject(sid, {
      claudeProjectsRoot: tempClaude,
      readCwd: () => Promise.resolve(null),
    });
    expect(result).toBeNull();
  });

  it('writes the once-marker even when no new project is detected (avoid re-checking every prompt)', async () => {
    const sid = 'ctx4-marker-on-known';
    const cwd = '/Users/slee/projects/another-known';
    const encoded = cwd.replace(/\//g, '-');
    await mkdir(join(tempClaude, encoded, 'memory'), { recursive: true });

    await detectNewProject(sid, {
      claudeProjectsRoot: tempClaude,
      readCwd: () => Promise.resolve(cwd),
    });

    const markerPath = join(tempHome, 'sessions', sid, '.new-project-checked');
    await expect(stat(markerPath)).resolves.toBeDefined();
  });

  it('uses encodeProjectPath form (`/` → `-`) for the existence check', async () => {
    const sid = 'ctx4-encoding';
    const cwd = '/Users/slee/projects/loop';
    const encoded = cwd.replace(/\//g, '-');
    // Create the encoded dir; detector should treat as known
    await mkdir(join(tempClaude, encoded, 'memory'), { recursive: true });

    const result = await detectNewProject(sid, {
      claudeProjectsRoot: tempClaude,
      readCwd: () => Promise.resolve(cwd),
    });
    expect(result).toBeNull();
  });

  it('uses default readCwd (readSessionCwd) when no deps.readCwd provided', async () => {
    const sid = 'ctx4-default-cwd';
    // Seed the session_state file readSessionCwd reads from. Path shape per
    // src/runtime/paths.ts:sessionStateFile = sessionStateDir + `${key}.json`.
    const cwdFile = join(tempHome, 'sessions', sid, 'state', 'cwd.json');
    await mkdir(join(tempHome, 'sessions', sid, 'state'), { recursive: true });
    await writeFile(cwdFile, '/Users/slee/projects/seeded-cwd', 'utf8');

    const result = await detectNewProject(sid, {
      claudeProjectsRoot: tempClaude,
      // no readCwd → default to readSessionCwd
    });
    expect(result).not.toBeNull();
    expect(result).toContain('/Users/slee/projects/seeded-cwd');
  });
});
