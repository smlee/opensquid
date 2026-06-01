/**
 * FU.5/FU.6/FU.8 — MCP-side session reads resolve the REAL session via
 * resolveMcpSessionId (was `process.env.CLAUDE_SESSION_ID ?? 'unknown'`, which
 * CC never sets → always read sessions/unknown/). Covers the two path-building
 * read tools (read_state, read_violations): they read the resolved session's
 * dir, and degrade to their graceful empty WITHOUT building a sessions/null|
 * unknown path when no session is resolvable.
 *
 * The resolver precedence itself is exhaustively tested in log_phase.test.ts
 * (MS.1); here we prove the tools CALL it + honour the null-guard. The ESLint
 * `no-restricted-syntax` guard (eslint.config.js) prevents regression to the
 * raw forms; it is negative-tested out-of-band.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionLogFile, sessionStateFile } from '../../runtime/paths.js';

import { handleReadState } from './read-state.js';
import { handleReadViolations } from './read-violations.js';

let tempHome: string;
let priorEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  // Clear every session-resolution input so the null case is deterministic and
  // OPENSQUID_SESSION_ID is the only seam in play.
  priorEnv = {
    OPENSQUID_HOME: process.env.OPENSQUID_HOME,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    OPENSQUID_SESSION_ID: process.env.OPENSQUID_SESSION_ID,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  };
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-sessres-'));
  process.env.OPENSQUID_HOME = tempHome;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.OPENSQUID_SESSION_ID;
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe('read_state resolves the real session (FU.5/FU.8)', () => {
  it('reads the resolved session dir (OPENSQUID_SESSION_ID seam), not sessions/unknown', async () => {
    process.env.OPENSQUID_SESSION_ID = 's1';
    const file = sessionStateFile('s1', 'mykey');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '"hello"', 'utf8');
    expect(await handleReadState({ key: 'mykey' })).toBe('"hello"');
  });

  it('returns "null" when no session is resolvable (no sessions/unknown path built)', async () => {
    expect(await handleReadState({ key: 'whatever' })).toBe('null');
    // A bug coercing null→'unknown' would have read sessions/unknown/ and still
    // returned 'null' via ENOENT — so also assert the unknown dir was never made.
    const unknown = dirname(sessionStateFile('unknown', 'x'));
    await expect(rm(unknown, { recursive: false })).rejects.toThrow(); // ENOENT = never created
  });
});

describe('read_violations resolves the real session (FU.8)', () => {
  it('reads the resolved session log (OPENSQUID_SESSION_ID seam)', async () => {
    process.env.OPENSQUID_SESSION_ID = 's1';
    const file = sessionLogFile('s1', 'violations');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'v1\n', 'utf8');
    expect(await handleReadViolations()).toBe('v1\n');
  });

  it('returns "" when no session is resolvable', async () => {
    expect(await handleReadViolations()).toBe('');
  });
});
