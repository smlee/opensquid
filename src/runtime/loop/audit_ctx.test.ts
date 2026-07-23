/**
 * R-AUDIT-CTX proof (T-v2-track1-finish, T1.2). `buildGuardCtx` binds the THREE intent pieces a discipline
 * guard reads — guess/spec audit verdicts + the phase (current FSM state) — plus event/tool. FAIL-OPEN: absent
 * caches bind `undefined`, never throw (observe-never-breaks). Uses the vitest OPENSQUID_HOME temp tree.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Event } from '../event.js';
import { sessionStateFile } from '../paths.js';
import { readAuditVerdict } from './guard_context.js';
import { writeTaskAuditCache } from './task_audit_cache.js';
import { buildGuardCtx } from './v2_supply.js';

const toolCall = (): Event => ({ kind: 'tool_call', tool: 'Write', args: {} }) as unknown as Event;
let projectRoot: string;
let priorProjectRoot: string | undefined;

beforeAll(async () => {
  priorProjectRoot = process.env.OPENSQUID_PROJECT_ROOT;
  projectRoot = await mkdtemp(join(tmpdir(), 'opensquid-audit-ctx-'));
  await mkdir(join(projectRoot, '.opensquid'));
  process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
});

afterAll(async () => {
  if (priorProjectRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = priorProjectRoot;
  await rm(projectRoot, { recursive: true, force: true });
});

async function seedVerdict(sid: string, key: string, verdict: string): Promise<void> {
  await writeTaskAuditCache(sid, key, { hash: 'e'.repeat(64), verdict });
}

describe('buildGuardCtx audit-backed bindings (R-AUDIT-CTX)', () => {
  it('binds verdict.guess + verdict.spec + phase + event/tool when the caches are present', async () => {
    const sid = 'audit-ctx-present';
    const previous = process.env.OPENSQUID_ITEM_ID;
    process.env.OPENSQUID_ITEM_ID = 'wg-audit-ctx-present';
    try {
      await seedVerdict(sid, 'coding-flow-guess-audit-cache', 'GUESS_FREE');
      await seedVerdict(sid, 'coding-flow-spec-audit-cache', 'SPEC_COMPLETE');
      const ctx = await buildGuardCtx(toolCall(), sid, 'scope');
      expect(ctx.get('verdict.guess')).toBe('GUESS_FREE');
      expect(ctx.get('verdict.spec')).toBe('SPEC_COMPLETE');
      expect(ctx.get('phase')).toBe('scope');
      expect(ctx.get('event')).toBe('tool_call');
      expect(ctx.get('tool')).toBe('Write');
    } finally {
      if (previous === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = previous;
    }
  });

  it('never lets a historical session cache shadow canonical task evidence', async () => {
    const previous = process.env.OPENSQUID_ITEM_ID;
    process.env.OPENSQUID_ITEM_ID = 'wg-audit-ctx-authority';
    const sid = 'audit-ctx-authority';
    const local = sessionStateFile(sid, 'authority-cache');
    try {
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, JSON.stringify({ verdict: 'VERDICT: GUESS_FREE' }), 'utf8');
      await seedVerdict(sid, 'authority-cache', 'VERDICT: UNRESOLVED');
      await expect(readAuditVerdict(sid, 'authority-cache')).resolves.toBe('VERDICT: UNRESOLVED');
    } finally {
      if (previous === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = previous;
    }
  });

  it('derives a durable fan-out verdict from canonical lenses without a persisted aggregate', async () => {
    const previous = process.env.OPENSQUID_ITEM_ID;
    process.env.OPENSQUID_ITEM_ID = 'wg-audit-ctx-fanout';
    try {
      await writeTaskAuditCache('audit-ctx-fanout', 'fanout-cache', {
        hash: 'f'.repeat(64),
        complete: true,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [
          { id: 'a', promptHash: 'a'.repeat(64), output: 'VERDICT: GUESS_FREE' },
          { id: 'b', promptHash: 'b'.repeat(64), output: 'VERDICT: GUESS_FREE' },
        ],
      });
      await expect(readAuditVerdict('audit-ctx-fanout', 'fanout-cache')).resolves.toMatch(
        /^VERDICT: GUESS_FREE/,
      );
    } finally {
      if (previous === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = previous;
    }
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
