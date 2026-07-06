/**
 * T-WORKGRAPH-PROJECT-SCOPE (lap/loop agreement) — proves the real bug fix end-to-end at the resolution
 * boundary: the loop resolves its project from the cwd `.opensquid/project.json` marker and PUBLISHES it
 * as `OPENSQUID_PROJECT_UUID`; a lap (whose own session→cwd marker is unresolvable) then resolves the
 * SAME project through that env fallback — the identical coalesce the MCP server's `resolveWgProject`
 * runs (`resolveWgNamespace(markerUuid, resolveProjectUuidFromEnv())`).
 *
 * Pre-fix, the loop never published the env, so the lap's null marker + null env → 'legacy-global' →
 * empty board (`workgraph_get(<claimed id>)` → null). This test reproduces that and shows the fix.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAndPublishLoopProject } from './ralph.js';
import { resolveWgNamespace } from '../../workgraph/project_scope.js';
import { resolveProjectUuidFromEnv } from '../../runtime/paths.js';

const LOOP_UUID = '0742f358-c0fd-4690-ae9d-da8f4102ab4a';

describe('resolveAndPublishLoopProject → lap agreement', () => {
  let projectDir: string;
  let priorCwd: string;
  let priorEnv: string | undefined;

  beforeEach(async () => {
    priorCwd = process.cwd();
    priorEnv = process.env.OPENSQUID_PROJECT_UUID;
    delete process.env.OPENSQUID_PROJECT_UUID; // clean baseline (no inherited env)
    projectDir = await mkdtemp(join(tmpdir(), 'opensquid-loop-proj-'));
    await mkdir(join(projectDir, '.opensquid'), { recursive: true });
    await writeFile(
      join(projectDir, '.opensquid', 'project.json'),
      JSON.stringify({ version: 1, id: 'opensquid', uuid: LOOP_UUID }),
    );
    process.chdir(projectDir);
  });

  afterEach(async () => {
    process.chdir(priorCwd);
    if (priorEnv === undefined) delete process.env.OPENSQUID_PROJECT_UUID;
    else process.env.OPENSQUID_PROJECT_UUID = priorEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  it('the loop resolves its cwd marker AND publishes it into OPENSQUID_PROJECT_UUID', async () => {
    const project = await resolveAndPublishLoopProject();
    expect(project).toBe(LOOP_UUID);
    expect(process.env.OPENSQUID_PROJECT_UUID).toBe(LOOP_UUID);
  });

  it('a lap (marker unresolvable) resolves the SAME project as the loop via the published env', async () => {
    const loopProject = await resolveAndPublishLoopProject();

    // The lap's MCP resolveWgProject runs exactly this coalesce. In the lap context its own
    // session→cwd marker cannot resolve (→ null); it must fall through to the inherited env.
    const lapProject = resolveWgNamespace(null, resolveProjectUuidFromEnv());

    expect(lapProject).toBe(loopProject);
    expect(lapProject).toBe(LOOP_UUID);
    expect(lapProject).not.toBe('legacy-global');
  });

  it('WITHOUT the published env the lap degrades to the empty legacy-global board (the bug)', () => {
    // Simulate pre-fix: the loop did not publish the env.
    delete process.env.OPENSQUID_PROJECT_UUID;
    const lapProject = resolveWgNamespace(null, resolveProjectUuidFromEnv());
    expect(lapProject).toBe('legacy-global');
  });
});
