import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionStateFile } from '../runtime/paths.js';
import { appendTool, readSessionToolLedger } from '../runtime/session_state.js';
import type { Event } from '../runtime/event.js';

import { FunctionRegistry } from './registry.js';
import type { EvalCtx } from './registry.js';
import { registerResetScopeTrackStateFunction } from './reset_scope_track_state.js';

const SID = 'reset-test';
let home: string;
const savedHome = process.env.OPENSQUID_HOME;

async function seed(key: string, value: unknown): Promise<void> {
  const p = sessionStateFile(SID, key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(value));
}
async function readKey(key: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(sessionStateFile(SID, key), 'utf8'));
  } catch {
    return 'MISSING';
  }
}

const toolCall: Event = { kind: 'tool_call', tool: 'Bash', args: { command: 'x' }, cwd: '/x' };

async function callReset(): Promise<void> {
  const reg = new FunctionRegistry();
  registerResetScopeTrackStateFunction(reg);
  const def = reg.get('reset_scope_track_state');
  if (def === undefined) throw new Error('not registered');
  const ctx: EvalCtx = {
    event: toolCall,
    bindings: new Map(),
    sessionId: SID,
    packId: 'coding-flow',
  };
  const r = await def.execute({}, ctx);
  expect(r).toEqual({ ok: true, value: null });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opensquid-reset-'));
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe('reset_scope_track_state primitive', () => {
  it('clears the 3 per-track keys (read back as null) and leaves audit caches + track UNTOUCHED', async () => {
    await seed('coding-flow-pre-research-path', '/docs/research/T-old-pre-research.md');
    await seed('coding-flow-spec-path', '/docs/tasks/T-old.md');
    await seed('coding-flow-design', 'the old shipped design content');
    await seed('coding-flow-guess-audit-cache', { hash8: 'abc', verdict: 'GUESS_FREE' });
    await seed('coding-flow-spec-audit-cache', { hash8: 'def', verdict: 'SPEC_COMPLETE' });
    await seed('coding-flow-track', 'feature');

    await callReset();

    // the leak-prone set → null
    expect(await readKey('coding-flow-pre-research-path')).toBeNull();
    expect(await readKey('coding-flow-spec-path')).toBeNull();
    expect(await readKey('coding-flow-design')).toBeNull();
    // deliberately excluded → unchanged
    expect(await readKey('coding-flow-guess-audit-cache')).toEqual({
      hash8: 'abc',
      verdict: 'GUESS_FREE',
    });
    expect(await readKey('coding-flow-spec-audit-cache')).toEqual({
      hash8: 'def',
      verdict: 'SPEC_COMPLETE',
    });
    expect(await readKey('coding-flow-track')).toBe('feature');
  });

  it('is a no-op (no throw) when the keys are already absent', async () => {
    await callReset();
    expect(await readKey('coding-flow-pre-research-path')).toBeNull();
  });

  it('also zeroes the per-track research window sinceScope (wg-3e241144f441)', async () => {
    await appendTool(SID, 'Read');
    await appendTool(SID, 'mcp__opensquid__recall');
    expect((await readSessionToolLedger(SID, 'since_scope_start')).tools).toHaveLength(2);
    await callReset();
    expect((await readSessionToolLedger(SID, 'since_scope_start')).tools).toEqual([]);
    // session window is untouched (only the per-track window resets on re-arm)
    expect((await readSessionToolLedger(SID, 'session')).tools).toHaveLength(2);
  });
});
