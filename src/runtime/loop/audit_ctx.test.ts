/**
 * R-AUDIT-CTX proof (T-v2-track1-finish, T1.2). `buildGuardCtx` binds the THREE intent pieces a discipline
 * guard reads — guess/spec audit verdicts + the phase (current FSM state) — plus event/tool. FAIL-OPEN: absent
 * caches bind `undefined`, never throw (observe-never-breaks). Uses the vitest OPENSQUID_HOME temp tree.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Event } from '../event.js';
import { sessionStateFile } from '../paths.js';
import { buildGuardCtx } from './v2_supply.js';

const toolCall = (): Event => ({ kind: 'tool_call', tool: 'Write', args: {} }) as unknown as Event;

async function seedVerdict(sid: string, key: string, verdict: string): Promise<void> {
  const p = sessionStateFile(sid, key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ verdict }), 'utf8'); // the flat { verdict } shape (collect.ts:98)
}

describe('buildGuardCtx audit-backed bindings (R-AUDIT-CTX)', () => {
  it('binds verdict.guess + verdict.spec + phase + event/tool when the caches are present', async () => {
    const sid = 'audit-ctx-present';
    await seedVerdict(sid, 'coding-flow-guess-audit-cache', 'GUESS_FREE');
    await seedVerdict(sid, 'coding-flow-spec-audit-cache', 'SPEC_COMPLETE');
    const ctx = await buildGuardCtx(toolCall(), sid, 'scope');
    expect(ctx.get('verdict.guess')).toBe('GUESS_FREE');
    expect(ctx.get('verdict.spec')).toBe('SPEC_COMPLETE');
    expect(ctx.get('phase')).toBe('scope');
    expect(ctx.get('event')).toBe('tool_call');
    expect(ctx.get('tool')).toBe('Write');
  });

  it('FAIL-OPEN: absent caches → verdicts undefined, event/tool/phase still bound (observe-never-breaks)', async () => {
    const ctx = await buildGuardCtx(toolCall(), 'audit-ctx-absent-session', 'author');
    expect(ctx.get('verdict.guess')).toBeUndefined();
    expect(ctx.get('verdict.spec')).toBeUndefined();
    expect(ctx.get('phase')).toBe('author');
    expect(ctx.get('event')).toBe('tool_call');
    expect(ctx.get('tool')).toBe('Write');
  });
});
