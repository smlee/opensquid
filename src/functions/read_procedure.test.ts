/**
 * Tests for `read_procedure` / `readProcedureContent` — the per-stage, on-demand procedure reader. Runs
 * against the REAL shipped fullstack-flow procedure files (no fs mock) so the happy + ENOENT (null) paths are
 * exercised faithfully.
 */
import { describe, expect, it } from 'vitest';

import { readProcedureContent, registerReadProcedure } from './read_procedure.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

const ctx = (packId = 'fullstack-flow'): EvalCtx => ({
  event: { kind: 'tool_call', tool: 'Write', args: {} },
  bindings: new Map<string, unknown>(),
  sessionId: 'test-session',
  packId,
});

describe('readProcedureContent', () => {
  it('reads each of the 5 fullstack-flow stage procedures whole', async () => {
    for (const stage of ['scope', 'plan', 'author', 'code', 'deploy'] as const) {
      const body = await readProcedureContent(stage, 'fullstack-flow');
      expect(body, `procedure/${stage}.md`).toContain(stage.toUpperCase());
    }
  });

  it('returns null for a state with no procedure file (terminal/decision/unknown)', async () => {
    await expect(readProcedureContent('done', 'fullstack-flow')).resolves.toBeNull();
    await expect(readProcedureContent('accept', 'fullstack-flow')).resolves.toBeNull();
    await expect(readProcedureContent('__nope__')).resolves.toBeNull();
  });
});

describe('read_procedure primitive', () => {
  it('resolves the stage procedure by the active pack (ctx.packId)', async () => {
    const reg = new FunctionRegistry();
    registerReadProcedure(reg);
    const res = await reg.call('read_procedure', { stage: 'code' }, ctx('fullstack-flow'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain('CODE');
  });

  it('rejects an unknown stage (.strict() enum)', async () => {
    const reg = new FunctionRegistry();
    registerReadProcedure(reg);
    const res = await reg.call('read_procedure', { stage: 'ship' }, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('arg_invalid');
  });
});
