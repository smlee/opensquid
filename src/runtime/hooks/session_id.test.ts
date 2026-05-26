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
  recordCurrentSession,
} from './session_id.js';

let tempHome: string;
let priorHome: string | undefined;
let priorEnv: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorEnv = process.env.CLAUDE_SESSION_ID;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-session-id-'));
  process.env.OPENSQUID_HOME = tempHome;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = priorEnv;
  await rm(tempHome, { recursive: true, force: true });
});

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
