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

// The primitive resolves the rubric by the ACTIVE pack (ctx.packId); default the test ctx to coding-flow.
const ctx = (packId = 'coding-flow'): EvalCtx => ({
  event: { kind: 'tool_call', tool: 'Write', args: {} },
  bindings: new Map<string, unknown>(),
  sessionId: 'test-session',
  packId,
});

describe('readRubricContent', () => {
  it('reads the real coding-flow scope + author fragments whole (explicit pack)', async () => {
    expect(await readRubricContent('scope', 'coding-flow')).toContain('NEVER-GUESS');
    expect(await readRubricContent('author', 'coding-flow')).toContain('11-FIELD');
  });

  it('resolves the rubric for an explicit pack (v2 fullstack-flow has all 4 stages)', async () => {
    // fullstack-flow ships scope|plan|author|code; coding-flow has only scope|author. Read its own 4.
    expect(await readRubricContent('scope', 'fullstack-flow')).toContain('SCOPE rubric');
    expect(await readRubricContent('plan', 'fullstack-flow')).toContain('PLAN rubric');
    expect(await readRubricContent('author', 'fullstack-flow')).toContain('AUTHOR');
    expect(await readRubricContent('code', 'fullstack-flow')).toContain('CODE rubric');
  });

  it('returns null when a stage is absent from a pack (coding-flow has no plan/code)', async () => {
    await expect(readRubricContent('plan', 'coding-flow')).resolves.toBeNull();
    await expect(readRubricContent('code', 'coding-flow')).resolves.toBeNull();
  });

  it('returns null (fail-loud, never throws) when the fragment is unreadable', async () => {
    // A name with no fragment file → real ENOENT → the catch returns null (the packaging-fault path).
    await expect(readRubricContent('__nonexistent__', 'coding-flow')).resolves.toBeNull();
  });
});

describe('read_rubric primitive', () => {
  it('returns ok(<fragment content>) resolved by the active pack (coding-flow)', async () => {
    const reg = new FunctionRegistry();
    registerReadRubric(reg);
    const res = await reg.call('read_rubric', { name: 'scope' }, ctx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain('NEVER-GUESS');
  });

  it('resolves the ACTIVE pack rubric (fullstack-flow → its own scope, not coding-flow)', async () => {
    const reg = new FunctionRegistry();
    registerReadRubric(reg);
    const res = await reg.call('read_rubric', { name: 'plan' }, ctx('fullstack-flow'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain('PLAN rubric');
  });

  it('delegates to readRubricContent (wraps its result in ok())', async () => {
    const reg = new FunctionRegistry();
    registerReadRubric(reg);
    expect(await reg.call('read_rubric', { name: 'scope' }, ctx())).toEqual(
      ok(await readRubricContent('scope', 'coding-flow')),
    );
  });

  // GENERIC RUNTIME — the arg is NOT a closed coding enum: the ACTIVE pack's own gate name resolves against its
  // own rubric dir. An arbitrary name is ACCEPTED (no arg rejection) and resolves to null when the pack ships no
  // such fragment — so a non-coding pack can name a gate outside scope/plan/author/code.
  it('accepts any rubric name (keys off the active pack, not a coding enum) → null when the fragment is absent', async () => {
    const reg = new FunctionRegistry();
    registerReadRubric(reg);
    const res = await reg.call('read_rubric', { name: 'triage' }, ctx('fullstack-flow'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeNull();
  });

  it('still rejects a non-string / empty name (.strict() shape holds)', async () => {
    const reg = new FunctionRegistry();
    registerReadRubric(reg);
    const res = await reg.call('read_rubric', { name: '' }, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('arg_invalid');
  });
});
