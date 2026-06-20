/**
 * Tests for `read_rubric` / `readRubricContent` (TR.A, wg-2d1d8698f563). Runs against the REAL shipped
 * fragments (packs/builtin/coding-flow/rubric/{scope,author}.md — the pack owns its gate) — no fs mock — so the happy + real-ENOENT (fail-loud null) paths
 * are exercised faithfully. (The over-cap branch is a trivial `length > MAX_RUBRIC ? null` guard; the
 * shipped-from-the-tarball resolve is covered by the TR.A cold-install check.)
 */

import { describe, expect, it } from 'vitest';

import { ok } from '../runtime/result.js';

import { readRubricContent, registerReadRubric } from './read_rubric.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

const ctx = (): EvalCtx => ({
  event: { kind: 'tool_call', tool: 'Write', args: {} },
  bindings: new Map<string, unknown>(),
  sessionId: 'test-session',
  packId: 'test-pack',
});

describe('readRubricContent', () => {
  it('reads the real scope + author fragments whole', async () => {
    expect(await readRubricContent('scope')).toContain('NEVER-GUESS');
    expect(await readRubricContent('author')).toContain('11-FIELD');
  });

  it('returns null (fail-loud, never throws) when the fragment is unreadable', async () => {
    // A name with no fragment file → real ENOENT → the catch returns null (the packaging-fault path).
    await expect(readRubricContent('__nonexistent__' as 'scope')).resolves.toBeNull();
  });
});

describe('read_rubric primitive', () => {
  it('returns ok(<fragment content>) for a valid name', async () => {
    const reg = new FunctionRegistry();
    registerReadRubric(reg);
    const res = await reg.call('read_rubric', { name: 'scope' }, ctx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain('NEVER-GUESS');
  });

  it('delegates to readRubricContent (wraps its result in ok())', async () => {
    const reg = new FunctionRegistry();
    registerReadRubric(reg);
    expect(await reg.call('read_rubric', { name: 'scope' }, ctx())).toEqual(
      ok(await readRubricContent('scope')),
    );
  });

  it('rejects an unknown name (.strict() enum)', async () => {
    const reg = new FunctionRegistry();
    registerReadRubric(reg);
    const res = await reg.call('read_rubric', { name: 'bogus' }, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('arg_invalid');
  });
});
