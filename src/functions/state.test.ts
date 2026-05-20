/**
 * Tests for state I/O primitives (`read_state`, `write_state`, `append_log`).
 *
 * Per Task 1.4 acceptance criteria: ≥ 5 cases including round-trip,
 * ENOENT-as-null, atomicity (no `.tmp.*` leak), and concurrent-append
 * serialization via `proper-lockfile`.
 *
 * Filesystem isolation: each test gets a fresh `os.tmpdir()/opensquid-test-<uuid>`
 * directory and `OPENSQUID_HOME` is pointed at it. We `beforeEach` set the
 * env-var, `afterEach` restore + `rm -rf` the temp dir. Tests never share
 * a state directory; concurrent-append is contained within a single test.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ok } from '../runtime/result.js';
import {
  packStateFile,
  sessionLogFile,
  sessionStateDir,
  sessionStateFile,
} from '../runtime/paths.js';
import type { Event } from '../runtime/types.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { registerStateFunctions } from './state.js';

// ---------------------------------------------------------------------------
// Test scaffolding — per-test OPENSQUID_HOME + EvalCtx helper.
// ---------------------------------------------------------------------------

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-test-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function createTestCtx(overrides: Partial<EvalCtx> = {}): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
    packId: 'test-pack',
    ...overrides,
  };
}

function freshRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerStateFunctions(reg);
  return reg;
}

// ---------------------------------------------------------------------------
// 1. read_state on missing file → ok(null) (canonical "no state" signal).
// ---------------------------------------------------------------------------

describe('read_state', () => {
  it('returns ok(null) when the state file does not exist', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const result = await reg.call('read_state', { key: 'absent' }, ctx);

    expect(result).toEqual(ok(null));
  });

  it('rejects an empty key via Zod min(1)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const result = await reg.call('read_state', { key: '' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });
});

// ---------------------------------------------------------------------------
// 2. write_state then read_state round-trip.
// 3. write_state overwrites an existing value.
// 4. atomicity — no `.tmp.*` files leak under the state dir after write.
// ---------------------------------------------------------------------------

describe('write_state', () => {
  it('round-trips a value through write_state + read_state', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const write = await reg.call(
      'write_state',
      { key: 'active-task', value: { id: 't1', subject: 'demo' } },
      ctx,
    );
    expect(write).toEqual(ok(undefined));

    const read = await reg.call('read_state', { key: 'active-task' }, ctx);
    expect(read).toEqual(ok({ id: 't1', subject: 'demo' }));
  });

  it('overwrites an existing value on a second write', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    await reg.call('write_state', { key: 'k', value: { v: 1 } }, ctx);
    await reg.call('write_state', { key: 'k', value: { v: 2 } }, ctx);

    const read = await reg.call('read_state', { key: 'k' }, ctx);
    expect(read).toEqual(ok({ v: 2 }));
  });

  it('leaves no .tmp.* file after a successful write', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    await reg.call('write_state', { key: 'k', value: { x: 42 } }, ctx);

    const dir = sessionStateDir(ctx.sessionId);
    const entries = await readdir(dir);
    const leaked = entries.filter((e) => e.includes('.tmp.'));
    expect(leaked).toEqual([]);
    // and the final file is exactly what we expect
    expect(entries).toContain('k.json');
  });
});

// ---------------------------------------------------------------------------
// 5. append_log creates the file if missing; one JSONL line per call.
// 6. append_log concurrent — 10 parallel writers, all lines land, valid JSONL.
// ---------------------------------------------------------------------------

describe('append_log', () => {
  it('creates the log file on first call and writes one JSONL line', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const r = await reg.call(
      'append_log',
      { name: 'violations', entry: { rule_id: 'r1', verdict: 'block' } },
      ctx,
    );
    expect(r).toEqual(ok(undefined));

    const raw = await readFile(sessionLogFile(ctx.sessionId, 'violations'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ rule_id: 'r1', verdict: 'block' });
  });

  it('serializes 10 concurrent append_log calls with no truncation', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const N = 10;
    const calls = Array.from({ length: N }, (_, i) =>
      reg.call('append_log', { name: 'concurrent', entry: { i, ts: Date.now() } }, ctx),
    );
    const results = await Promise.all(calls);
    for (const r of results) expect(r.ok).toBe(true);

    const raw = await readFile(sessionLogFile(ctx.sessionId, 'concurrent'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(N);

    // Every line is valid JSON, and the set of `i` values is exactly 0..N-1.
    const parsed = lines.map((l) => JSON.parse(l) as { i: number; ts: number });
    const seen = new Set(parsed.map((p) => p.i));
    expect(seen.size).toBe(N);
    for (let i = 0; i < N; i++) expect(seen.has(i)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. OPENSQUID_HOME respects env-var override — state lands inside the
// per-test temp dir, never under $HOME/.opensquid. Verifies the path
// resolver and the filesystem-isolation contract that the test suite
// relies on for parallel safety.
// ---------------------------------------------------------------------------

describe('paths via OPENSQUID_HOME', () => {
  it('writes state under the per-test temp directory', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    await reg.call('write_state', { key: 'probe', value: { ok: true } }, ctx);

    const path = sessionStateFile(ctx.sessionId, 'probe');
    expect(path.startsWith(tempHome)).toBe(true);
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Task 5.3: per-pack state namespacing
//
// `read_state` / `write_state` accept an optional `pack` arg that routes
// the file to `~/.opensquid/packs/<id>/state/<key>.json` instead of the
// session-scoped location. Two packs must produce two separate files,
// path-traversal pack ids must sanitize away, and the no-`pack` path must
// continue to land in the session directory exactly as before.
// ---------------------------------------------------------------------------

describe('per-pack state namespacing', () => {
  it('isolates state per pack — two packs writing key `foo` produce two files', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    await reg.call('write_state', { key: 'foo', value: { from: 'a' }, pack: 'pack-a' }, ctx);
    await reg.call('write_state', { key: 'foo', value: { from: 'b' }, pack: 'pack-b' }, ctx);

    const a = await reg.call('read_state', { key: 'foo', pack: 'pack-a' }, ctx);
    const b = await reg.call('read_state', { key: 'foo', pack: 'pack-b' }, ctx);

    expect(a).toEqual(ok({ from: 'a' }));
    expect(b).toEqual(ok({ from: 'b' }));

    // And the files genuinely live at the pack-state paths, not the session one.
    expect(packStateFile('pack-a', 'foo').startsWith(tempHome)).toBe(true);
    const rawA = await readFile(packStateFile('pack-a', 'foo'), 'utf8');
    const rawB = await readFile(packStateFile('pack-b', 'foo'), 'utf8');
    expect(JSON.parse(rawA)).toEqual({ from: 'a' });
    expect(JSON.parse(rawB)).toEqual({ from: 'b' });
  });

  it('sanitizes a traversal pack id (../etc/passwd) — file lands inside the pack root', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const evilId = '../etc/passwd';
    const write = await reg.call(
      'write_state',
      { key: 'k', value: { trapped: true }, pack: evilId },
      ctx,
    );
    expect(write).toEqual(ok(undefined));

    // Sanitized form is `___etc_passwd`. The file MUST be under tempHome.
    const resolved = packStateFile(evilId, 'k');
    expect(resolved.startsWith(tempHome)).toBe(true);
    expect(resolved).toContain('___etc_passwd');

    const read = await reg.call('read_state', { key: 'k', pack: evilId }, ctx);
    expect(read).toEqual(ok({ trapped: true }));
  });

  it('falls back to session-scoped state when no pack arg is supplied', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    await reg.call('write_state', { key: 'session-key', value: { mode: 'session' } }, ctx);

    // Session file exists.
    const sessionPath = sessionStateFile(ctx.sessionId, 'session-key');
    const raw = await readFile(sessionPath, 'utf8');
    expect(JSON.parse(raw)).toEqual({ mode: 'session' });

    // And the same key, when read WITH a pack, returns null (separate namespace).
    const packRead = await reg.call('read_state', { key: 'session-key', pack: 'some-pack' }, ctx);
    expect(packRead).toEqual(ok(null));
  });

  it('returns ok(null) for a missing pack-namespaced key', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const r = await reg.call('read_state', { key: 'absent', pack: 'pack-x' }, ctx);
    expect(r).toEqual(ok(null));
  });
});
