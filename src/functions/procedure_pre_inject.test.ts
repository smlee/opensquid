/**
 * Tests for `procedure_pre_inject` (wg-7f6225238a27): injects the calling pack's operating
 * procedure (threaded `ctx.packProcedure`) at prompt_submit while the pack is ENGAGED — FSM
 * state ≠ initial, or no FSM at all. Null otherwise. Generic self-gate: NO hardcoded pack id.
 * Uses a temp OPENSQUID_HOME + advanceFsmState to drive the coding-flow FSM, and passes
 * packProcedure / packFsm directly via the EvalCtx (so this slice is isolated from PPW.2's
 * coding-flow procedure.md, which does not exist yet).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { advanceFsmState } from '../runtime/fsm_state.js';
import type { Fsm } from '../runtime/fsm.js';
import { ok } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';

import { loadPack } from '../packs/loader.js';
import { registerProcedurePreInject } from './procedure_pre_inject.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

const SID = 'ppi-test';
const TS = '2026-06-14T00:00:00.000Z';
const PROC = '# coding-flow operating procedure\n\nrecall + Read + Grep, then write once.\n';
const promptEvent: Event = { kind: 'prompt_submit', prompt: 'go' };

function reg(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerProcedurePreInject(r);
  return r;
}
function ctx(event: Event, opts?: { packProcedure?: string; packFsm?: Fsm }): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: SID,
    packId: 'coding-flow',
    ...(opts?.packProcedure !== undefined ? { packProcedure: opts.packProcedure } : {}),
    ...(opts?.packFsm !== undefined ? { packFsm: opts.packFsm } : {}),
  };
}

describe('procedure_pre_inject', () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-ppi-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('returns null on a non-prompt_submit event (even with a procedure present)', async () => {
    const r = await reg().call(
      'procedure_pre_inject',
      {},
      ctx({ kind: 'tool_call', tool: 'Write', args: {} }, { packProcedure: PROC }),
    );
    expect(r).toEqual(ok(null));
  });

  it('returns null when the pack ships no procedure (packProcedure undefined)', async () => {
    expect(await reg().call('procedure_pre_inject', {}, ctx(promptEvent))).toEqual(ok(null));
  });

  it('returns null when the FSM is at its initial state (idle / unstarted)', async () => {
    const pack = await loadPack(resolve('packs/builtin/coding-flow'));
    // No advance → no state file → readFsmStateRaw returns null (treated as not engaged).
    const r = await reg().call(
      'procedure_pre_inject',
      {},
      ctx(promptEvent, { packProcedure: PROC, packFsm: pack.fsm! }),
    );
    expect(r).toEqual(ok(null));
  });

  it('injects the procedure when the FSM is engaged (state ≠ initial)', async () => {
    const pack = await loadPack(resolve('packs/builtin/coding-flow'));
    await advanceFsmState(SID, 'coding-flow', pack.fsm!, 'scope_start', TS); // idle → scoping
    const r = await reg().call(
      'procedure_pre_inject',
      {},
      ctx(promptEvent, { packProcedure: PROC, packFsm: pack.fsm! }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ kind: 'inject_context' });
    const { content } = r.value as { content: string };
    expect(content).toContain(PROC);
    expect(content).toContain('coding-flow'); // the packId header
  });

  it('injects whenever loaded for a pack with NO FSM (engaged-by-loaded)', async () => {
    const r = await reg().call(
      'procedure_pre_inject',
      {},
      ctx(promptEvent, { packProcedure: PROC }), // no packFsm
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ kind: 'inject_context' });
    expect((r.value as { content: string }).content).toContain(PROC);
  });
});
