/**
 * CMP.1 — `memoryCompress` / `memoryRecomputeCitations` client bridge.
 *
 * Real-engine round-trip (the MAU.1 "prove against reality" bar). Gated
 * by E2E=1 + an engine binary (skip-if-absent for CI), same harness as
 * log_phase.test.ts.
 *
 * What this proves:
 *  - `memory.recompute_citations` round-trips fully against the live
 *    engine (no LLM needed — it walks lessons + repairs counters).
 *  - `memory.compress` is WIRED (reachable dispatch arm, not
 *    METHOD_NOT_FOUND). The engine crate ships no production LLM
 *    adapter, so a real `loop-engine` daemon has `llm: None` and the
 *    handler returns a structured "no LLM configured" error — this
 *    asserts the RPC exists + validates params, which is exactly
 *    CMP.1's "pure exposure" deliverable. The full compress→Mc path is
 *    exercised at the Rust dispatch layer (serve.rs unit tests) where a
 *    MockLlmClient is injectable.
 *  - `memoryGet` surfaces the CMP.1-added `consumed_by_user_lessons` +
 *    `derived_from` fields (CMP.4's per-predecessor immunity gate needs
 *    them).
 */

import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EngineClient, ENGINE_ERROR, RpcError } from './client.js';

const DEV_BINARY_PATH = join(
  process.env.HOME ?? '/tmp',
  'projects/loop/engine/target/release/loop-engine',
);
function isExecutable(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
const ENV_BIN = process.env.OPENSQUID_ENGINE_BIN?.trim();
const ENGINE_BIN = ENV_BIN !== undefined && ENV_BIN.length > 0 ? ENV_BIN : DEV_BINARY_PATH;
const SKIP_REAL = process.env.E2E !== '1' || !isExecutable(ENGINE_BIN);

describe.skipIf(SKIP_REAL)('CMP.1 memoryCompress / memoryRecomputeCitations (real engine)', () => {
  let engineHome: string;
  let engine: EngineClient | null = null;
  let prior: Record<string, string | undefined> = {};

  beforeEach(async () => {
    prior = {
      OPENSQUID_HOME: process.env.OPENSQUID_HOME,
      LOOP_HOME: process.env.LOOP_HOME,
      OPENSQUID_ENGINE_BIN: process.env.OPENSQUID_ENGINE_BIN,
    };
    engineHome = await mkdtemp(join(tmpdir(), 'opensquid-cmp1-engine-'));
    process.env.OPENSQUID_HOME = engineHome;
    process.env.LOOP_HOME = engineHome;
    process.env.OPENSQUID_ENGINE_BIN = ENGINE_BIN;
    engine = new EngineClient();
    await engine.ping();
  }, 30_000);

  afterEach(async () => {
    if (engine) await engine.close().catch(() => undefined);
    spawnSync('pkill', ['-f', engineHome], { stdio: 'ignore' });
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(engineHome, { recursive: true, force: true });
  });

  it('memoryRecomputeCitations round-trips fully (clean store → zero drift)', async () => {
    const stats = await engine!.memoryRecomputeCitations();
    expect(stats.counters_repaired).toBe(0);
    expect(stats.orphan_citations).toBe(0);
    expect(typeof stats.lessons_scanned).toBe('number');
    expect(typeof stats.memories_recomputed).toBe('number');
  });

  it('memoryCompress RPC is wired (reachable, not METHOD_NOT_FOUND)', async () => {
    // Seed two real memories so the window resolves past the empty guard.
    const m1 = await engine!.memoryCreate({ description: 'first', content: 'body one' });
    const m2 = await engine!.memoryCreate({ description: 'second', content: 'body two' });

    let caught: RpcError | null = null;
    try {
      await engine!.memoryCompress({ ids: [m1.id, m2.id] });
    } catch (e) {
      caught = e as RpcError;
    }
    // A real daemon has no LLM adapter → structured error, NOT a
    // missing-method error. Either outcome below proves the dispatch
    // arm exists; we only forbid METHOD_NOT_FOUND.
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(RpcError);
    expect(caught!.code).not.toBe(ENGINE_ERROR.METHOD_NOT_FOUND);
  });

  it('memoryCompress with empty ids → InvalidParams (validated server-side)', async () => {
    let caught: RpcError | null = null;
    try {
      await engine!.memoryCompress({ ids: [] });
    } catch (e) {
      caught = e as RpcError;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect(caught!.code).toBe(ENGINE_ERROR.INVALID_PARAMS);
  });

  it('memoryGet surfaces consumed_by_user_lessons + derived_from (CMP.1 additive fields)', async () => {
    const created = await engine!.memoryCreate({ description: 'raw', content: 'raw body' });
    const got = await engine!.memoryGet({ id: created.id });
    expect(got.consumed_by_user_lessons).toBe(0);
    expect(got.derived_from).toEqual([]);
  });
});
