/**
 * Tests for hook session-id resolution + the `.current-session` pointer.
 *
 * Root-cause coverage: `extractSessionId` must prefer the stdin `session_id`
 * (the authoritative Claude Code hook field) over the `CLAUDE_SESSION_ID` env
 * fallback — the inverse of the pre-2026-05-26 bug where the hooks only read
 * the (usually unset) env var and collapsed every session to `'unknown'`.
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  currentSessionPath,
  extractSessionId,
  readCurrentSession,
  readProjectCurrentSession,
  readSessionPointer,
  recordCurrentSession,
  resolveMcpSessionId,
  writeSessionPointer,
} from './session_id.js';

let tempHome: string;
let priorHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CLAUDE_SESSION_ID',
  'OPENSQUID_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
  'OPENSQUID_PROJECT_UUID',
];
const projDirs: string[] = [];

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-session-id-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(tempHome, { recursive: true, force: true });
  for (const d of projDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Create a temp dir bound to `uuid` via `.opensquid/project.json` (so
 *  `resolveProjectUuid({cwd})` resolves it through the real walk). */
async function makeProject(uuid: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opensquid-proj-'));
  projDirs.push(dir);
  await mkdir(join(dir, '.opensquid'), { recursive: true });
  await writeFile(
    join(dir, '.opensquid', 'project.json'),
    JSON.stringify({ version: 1, uuid, id: 'test-proj' }),
    'utf-8',
  );
  return dir;
}

describe('extractSessionId', () => {
  it('prefers stdin session_id (snake_case) over the env fallback', () => {
    process.env.CLAUDE_SESSION_ID = 'env-id';
    expect(extractSessionId(JSON.stringify({ session_id: 'stdin-id' }))).toBe('stdin-id');
  });

  it('accepts camelCase sessionId', () => {
    expect(extractSessionId(JSON.stringify({ sessionId: 'camel-id' }))).toBe('camel-id');
  });

  it('falls back to CLAUDE_SESSION_ID when stdin carries no id', () => {
    process.env.CLAUDE_SESSION_ID = 'env-id';
    expect(extractSessionId(JSON.stringify({ prompt: 'hi' }))).toBe('env-id');
  });

  it("returns 'unknown' when neither stdin nor env provides an id", () => {
    expect(extractSessionId(JSON.stringify({ prompt: 'hi' }))).toBe('unknown');
  });

  it('never throws on malformed JSON — falls through to env/unknown', () => {
    process.env.CLAUDE_SESSION_ID = 'env-id';
    expect(extractSessionId('not json at all {')).toBe('env-id');
  });

  it('ignores an empty-string stdin id and uses the env fallback', () => {
    process.env.CLAUDE_SESSION_ID = 'env-id';
    expect(extractSessionId(JSON.stringify({ session_id: '' }))).toBe('env-id');
  });
});

describe('recordCurrentSession / readCurrentSession', () => {
  it('round-trips a recorded session id', async () => {
    await recordCurrentSession('sess-abc');
    expect(await readCurrentSession()).toBe('sess-abc');
    expect(await readFile(currentSessionPath(), 'utf-8')).toBe('sess-abc');
  });

  it('returns null when no pointer exists', async () => {
    expect(await readCurrentSession()).toBeNull();
  });

  it("refuses to record the 'unknown' sentinel (would mislead the CLI)", async () => {
    await recordCurrentSession('unknown');
    expect(await readCurrentSession()).toBeNull();
  });

  it('refuses to record an empty id', async () => {
    await recordCurrentSession('');
    expect(await readCurrentSession()).toBeNull();
  });

  it('treats a whitespace-only pointer as absent', async () => {
    await mkdir(tempHome, { recursive: true });
    await writeFile(currentSessionPath(), '   \n', 'utf-8');
    expect(await readCurrentSession()).toBeNull();
  });

  it('overwrites a prior pointer (latest session wins)', async () => {
    await recordCurrentSession('first');
    await recordCurrentSession('second');
    expect(await readCurrentSession()).toBe('second');
  });
});

describe('FU.3 — project-scoped session pointer', () => {
  const UUID = 'da96385b-8d0d-43c0-a637-35b70915b68b';

  it('dual-writes the global AND project-scoped pointer for a uuid-bound cwd', async () => {
    const proj = await makeProject(UUID);
    await recordCurrentSession('sess-1', proj);
    expect(await readCurrentSession()).toBe('sess-1'); // global
    expect(await readProjectCurrentSession(UUID)).toBe('sess-1'); // project-scoped
  });

  it('writes ONLY the global pointer when the cwd is not in a uuid-bound project', async () => {
    const noProj = await mkdtemp(join(tmpdir(), 'opensquid-noproj-'));
    projDirs.push(noProj);
    await recordCurrentSession('sess-1', noProj);
    expect(await readCurrentSession()).toBe('sess-1');
    expect(await readProjectCurrentSession(UUID)).toBeNull();
  });

  it('resolveMcpSessionId prefers the project pointer over a CLOBBERED global (the FU.3 regression)', async () => {
    const proj = await makeProject(UUID);
    await recordCurrentSession('mine', proj); // global+project = 'mine'
    // A concurrent session in ANOTHER project clobbers the GLOBAL pointer:
    await writeFile(currentSessionPath(), 'other-session', 'utf-8');
    process.env.CLAUDE_PROJECT_DIR = proj;
    // Project-scoped pointer still says 'mine' → resolution is NOT clobbered.
    expect(await resolveMcpSessionId()).toBe('mine');
  });

  it('resolveMcpSessionId: OPENSQUID_SESSION_ID env wins over everything', async () => {
    const proj = await makeProject(UUID);
    await recordCurrentSession('mine', proj);
    process.env.CLAUDE_PROJECT_DIR = proj;
    process.env.OPENSQUID_SESSION_ID = 'env-wins';
    expect(await resolveMcpSessionId()).toBe('env-wins');
  });

  it('resolveMcpSessionId falls back to the global pointer when no CLAUDE_PROJECT_DIR', async () => {
    await recordCurrentSession('global-only'); // no cwd → global only
    expect(await resolveMcpSessionId()).toBe('global-only');
  });

  it('resolveMcpSessionId falls back to global when the project has no scoped pointer', async () => {
    const proj = await makeProject(UUID);
    process.env.CLAUDE_PROJECT_DIR = proj;
    await writeFile(currentSessionPath(), 'global-fallback', 'utf-8'); // no project pointer written
    expect(await resolveMcpSessionId()).toBe('global-fallback');
  });
});

describe('FU.7 — CLAUDE_CODE_SESSION_ID guarded by session-dir existence', () => {
  const UUID = 'da96385b-8d0d-43c0-a637-35b70915b68b';

  it('prefers CLAUDE_CODE_SESSION_ID over the project pointer when its session dir EXISTS', async () => {
    const proj = await makeProject(UUID);
    await recordCurrentSession('project-session', proj); // project pointer says 'project-session'
    process.env.CLAUDE_PROJECT_DIR = proj;
    process.env.CLAUDE_CODE_SESSION_ID = 'cc-per-process';
    await mkdir(join(tempHome, 'sessions', 'cc-per-process'), { recursive: true }); // real persisted dir
    // Same-project concurrency: the per-process id (dir-backed) wins.
    expect(await resolveMcpSessionId()).toBe('cc-per-process');
  });

  it('IGNORES CLAUDE_CODE_SESSION_ID when its session dir is ABSENT (--resume safety) → project pointer', async () => {
    const proj = await makeProject(UUID);
    await recordCurrentSession('project-session', proj);
    process.env.CLAUDE_PROJECT_DIR = proj;
    process.env.CLAUDE_CODE_SESSION_ID = 'resumed-new-id'; // NO sessions/<id>/ dir created
    expect(await resolveMcpSessionId()).toBe('project-session');
  });

  it('OPENSQUID_SESSION_ID still outranks a dir-backed CLAUDE_CODE_SESSION_ID', async () => {
    process.env.OPENSQUID_SESSION_ID = 'override-wins';
    process.env.CLAUDE_CODE_SESSION_ID = 'cc-per-process';
    await mkdir(join(tempHome, 'sessions', 'cc-per-process'), { recursive: true });
    expect(await resolveMcpSessionId()).toBe('override-wins');
  });

  it('unset CLAUDE_CODE_SESSION_ID leaves resolution unchanged (global fallback)', async () => {
    await recordCurrentSession('global-only');
    expect(await resolveMcpSessionId()).toBe('global-only');
  });
});

describe('session pointer pair (wg-16803ed82901 — CLAUDE_PROJECT_DIR ?? cwd)', () => {
  it('writeSessionPointer keys on CLAUDE_PROJECT_DIR, NOT the (sub-repo) cwd', async () => {
    const dirA = await makeProject('uuid-A');
    const dirB = await makeProject('uuid-B'); // a different project (stands in for the sub-repo cwd)
    await writeSessionPointer('sid-live', dirB, { CLAUDE_PROJECT_DIR: dirA });
    expect(await readProjectCurrentSession('uuid-A')).toBe('sid-live'); // wrote to CLAUDE_PROJECT_DIR's pointer
    expect(await readProjectCurrentSession('uuid-B')).toBeNull(); // NOT the cwd's
  });

  it('back-compat: CLAUDE_PROJECT_DIR unset → writes the cwd-keyed pointer', async () => {
    const dirB = await makeProject('uuid-B');
    await writeSessionPointer('sid-cli', dirB, {});
    expect(await readProjectCurrentSession('uuid-B')).toBe('sid-cli');
  });

  it('readSessionPointer round-trips what writeSessionPointer wrote, via CLAUDE_PROJECT_DIR', async () => {
    const dirA = await makeProject('uuid-A');
    const dirB = await makeProject('uuid-B');
    await writeSessionPointer('sid-live', dirB, { CLAUDE_PROJECT_DIR: dirA });
    expect(await readSessionPointer(dirB, { CLAUDE_PROJECT_DIR: dirA })).toBe('sid-live');
  });

  it('resolveMcpSessionId resolves the LIVE session even when cwd is a sub-repo (the bug)', async () => {
    const dirA = await makeProject('uuid-A');
    const dirB = await makeProject('uuid-B');
    // The live session's UPS cwd is the sub-repo (dirB); CLAUDE_PROJECT_DIR is the umbrella (dirA).
    await recordCurrentSession('live-sid', dirB === '' ? undefined : dirB); // legacy write target would be uuid-B
    await writeSessionPointer('live-sid', dirB, { CLAUDE_PROJECT_DIR: dirA }); // the fixed write → uuid-A
    // MCP env: CLAUDE_CODE_SESSION_ID has no session dir; CLAUDE_PROJECT_DIR = dirA.
    process.env.CLAUDE_CODE_SESSION_ID = 'mcp-frozen-no-dir';
    process.env.CLAUDE_PROJECT_DIR = dirA;
    expect(await resolveMcpSessionId()).toBe('live-sid');
  });

  it('writeSessionPointer no-ops (no throw) when the uuid cannot be resolved', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'opensquid-nouuid-'));
    projDirs.push(plain);
    await expect(writeSessionPointer('sid', plain, {})).resolves.toBeUndefined();
  });
});
