/**
 * Tests for RTC.5 primitives (wg-3d175ec06767): `set_request_type` (writes the refined
 * request-type verdict, preserving prompt_hash/at) + `current_prompt` (exposes the prompt for
 * interpolation into the llm_classify refinement).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerEventFunctions } from './event.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';
import { registerSetRequestType } from './set_request_type.js';
import { ok } from '../runtime/result.js';
import { readRequestType, writeRequestType } from '../runtime/session_state.js';
import type { Event } from '../runtime/types.js';

const SID = 'srt-test';

function reg(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerSetRequestType(r);
  registerEventFunctions(r);
  return r;
}
function ctx(event: Event): EvalCtx {
  return { event, bindings: new Map<string, unknown>(), sessionId: SID, packId: 'coding-flow' };
}

describe('set_request_type + current_prompt', () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-srt-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('set_request_type refines a low-confidence record (preserving prompt_hash/at)', async () => {
    await writeRequestType(SID, {
      type: 'research',
      confidence: 'low',
      source: 'deterministic',
      prompt_hash: 'h1',
      at: '2026-06-14T00:00:00.000Z',
    });
    await reg().call(
      'set_request_type',
      { type: 'work' },
      ctx({ kind: 'prompt_submit', prompt: 'x' }),
    );
    expect(await readRequestType(SID)).toEqual({
      type: 'work',
      confidence: 'high',
      source: 'llm',
      prompt_hash: 'h1',
      at: '2026-06-14T00:00:00.000Z',
    });
  });

  it('set_request_type is a no-op when no record exists', async () => {
    const r = await reg().call(
      'set_request_type',
      { type: 'work' },
      ctx({ kind: 'prompt_submit', prompt: 'x' }),
    );
    expect(r).toEqual(ok(null));
    expect(await readRequestType(SID)).toBeNull();
  });

  it('current_prompt returns the prompt on prompt_submit, null otherwise', async () => {
    const onPrompt = await reg().call(
      'current_prompt',
      {},
      ctx({ kind: 'prompt_submit', prompt: 'hello' }),
    );
    expect(onPrompt).toEqual(ok('hello'));
    const onTool = await reg().call(
      'current_prompt',
      {},
      ctx({ kind: 'tool_call', tool: 'Write', args: {} }),
    );
    expect(onTool).toEqual(ok(null));
  });
});
