/** T-scope-worksheet — validate_worksheet primitive: content-level {valid,error?} result. */
import { describe, expect, it } from 'vitest';

import type { Event } from '../runtime/event.js';
import { FunctionRegistry } from './registry.js';
import type { EvalCtx } from './registry.js';
import { registerValidateWorksheetFunction } from './validate_worksheet.js';

const event: Event = { kind: 'tool_call', tool: 'Write', args: {}, cwd: '/x' };
const ctx: EvalCtx = { event, bindings: new Map(), sessionId: 'vw-test', packId: 'coding-flow' };

async function call(content: string): Promise<{ valid: boolean; error?: string }> {
  const reg = new FunctionRegistry();
  registerValidateWorksheetFunction(reg);
  const def = reg.get('validate_worksheet');
  if (def === undefined) throw new Error('not registered');
  const r = await def.execute({ content }, ctx);
  if (!r.ok) throw new Error('execute failed');
  return r.value as { valid: boolean; error?: string };
}

describe('validate_worksheet', () => {
  it('valid single content → { valid: true }', async () => {
    const md = '```yaml\nmode: single\nscopes:\n  - id: T-a\n    summary: s\norder: [T-a]\n```';
    expect(await call(md)).toEqual({ valid: true });
  });

  it('schema-invalid content → { valid: false, error }', async () => {
    const md = '```yaml\nmode: batch\nscopes:\n  - id: a\n    summary: s\norder: [a]\n```'; // batch needs >=2 + issue
    const r = await call(md);
    expect(r.valid).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('no fence → { valid: false }', async () => {
    expect((await call('# prose only')).valid).toBe(false);
  });
});
