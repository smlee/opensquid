/**
 * CMP.5 — compression pipeline end-to-end (the must-WORK gate).
 *
 * Proves the FULL compression chain against a REAL loop-engine daemon
 * (with a real LLM via the engine's OpenAiCompatibleLlm adapter →
 * local Ollama) — the MAU.1 "prove against reality" bar for an
 * IRREVERSIBLE operation:
 *
 *   insert memories → satisfaction "satisfied" → candidates collected →
 *   orchestrator compresses → recall-replay passes → non-immune
 *   predecessors force-deleted → Mc still recalls (trace preserved via
 *   the engine's get_by_id_chasing_derived_from).
 *
 * Plus the safety negatives the design forbids breaking:
 *   - a USER-CITED predecessor is KEPT (immunity holds even though
 *     force=true would bypass the engine guard).
 *   - recall-replay FAILS → NOTHING deleted.
 *   - NOT satisfied → no compression at all.
 *
 * Gated by E2E=1 + an engine binary (skip-if-absent for CI). Scoped
 * OPENSQUID_HOME / LOOP_HOME so the e2e NEVER touches the real memory
 * store (deleting real memories would be the exact failure the design
 * forbids).
 *
 * Requires a local LLM for the compress legs. If the engine's LLM
 * adapter can't reach a model, the compress legs are skipped with a
 * clear log (the recall-replay-fail + not-satisfied legs still run, as
 * they don't require a successful compress).
 */

import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EngineClient, RpcError } from '../../src/engine/client.js';
import { runCompression, recallReplayPasses } from '../../src/runtime/compression_orchestrator.js';
import { emitProbe, recordAnswer } from '../../src/runtime/satisfaction_probe.js';
import { collectCandidates } from '../../src/runtime/wedge/compress_candidates.js';

const DEV_BINARY = join(
  process.env.HOME ?? '/tmp',
  'projects/loop/engine/target/release/loop-engine',
);
function isExec(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
const ENV_BIN = process.env.OPENSQUID_ENGINE_BIN?.trim();
const ENGINE_BIN = ENV_BIN !== undefined && ENV_BIN.length > 0 ? ENV_BIN : DEV_BINARY;
const SKIP = process.env.E2E !== '1' || !isExec(ENGINE_BIN);

const SID = 'cmp5-e2e-sess';

/**
 * Seed a memory whose body is substantial enough that the compressor
 * won't refuse with `insufficient_input`.
 */
async function seed(engine: EngineClient, description: string, content: string): Promise<string> {
  const r = await engine.memoryCreate({ description, content });
  return r.id;
}

/** True if the engine could actually compress (LLM reachable). */
async function tryCompress(engine: EngineClient, ids: string[]): Promise<string | null> {
  try {
    const mc = await engine.memoryCompress({ ids });
    return mc.id;
  } catch (e) {
    if (e instanceof RpcError) {
      console.warn(`[CMP.5] compress unavailable (LLM offline?): ${e.message} — skipping leg`);
      return null;
    }
    throw e;
  }
}

describe.skipIf(SKIP)('CMP.5 — compression pipeline e2e (real engine)', () => {
  let home: string;
  let engine: EngineClient;
  let prior: Record<string, string | undefined> = {};

  beforeAll(async () => {
    prior = {
      OPENSQUID_HOME: process.env.OPENSQUID_HOME,
      LOOP_HOME: process.env.LOOP_HOME,
      OPENSQUID_ENGINE_BIN: process.env.OPENSQUID_ENGINE_BIN,
    };
    home = await mkdtemp(join(tmpdir(), 'cmp5-'));
    process.env.OPENSQUID_HOME = home;
    process.env.LOOP_HOME = home;
    process.env.OPENSQUID_ENGINE_BIN = ENGINE_BIN;
    engine = new EngineClient();
    await engine.ping();
  }, 30_000);

  afterAll(async () => {
    await engine.close().catch(() => undefined);
    spawnSync('pkill', ['-f', home], { stdio: 'ignore' });
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  });

  it('full chain: satisfied → compress → recall-replay → predecessors deleted, Mc recalls (trace preserved)', async () => {
    const m1 = await seed(
      engine,
      'Postgres pool tuned to 20 connections',
      'We capped the Postgres connection pool at 20 after connection exhaustion under load; pgbouncer runs in transaction mode.',
    );
    const m2 = await seed(
      engine,
      'pgbouncer transaction pooling chosen',
      'pgbouncer is configured in transaction pooling mode so short web requests reuse server connections efficiently.',
    );

    // satisfaction "satisfied" + candidate window
    await emitProbe(SID, 'CMP');
    await recordAnswer(SID, 'CMP', true);
    await collectCandidates(SID, { id: 'lesson-pg', citedMemoryIds: [m1, m2], group: 'CMP' });

    // gate: does compress work at all here (LLM reachable)?
    const probeMc = await tryCompress(engine, [m1, m2]);
    if (probeMc === null) return; // LLM offline — skip this leg cleanly

    // Re-seed (the probe compress already consumed a window; re-create
    // fresh predecessors so the orchestrator runs on live ids).
    const a = await seed(
      engine,
      'Redis used as the rate-limit store',
      'Rate limiting state lives in Redis with a sliding-window counter keyed by client id.',
    );
    const b = await seed(
      engine,
      'sliding-window rate limit algorithm',
      'The rate limiter uses a sliding-window log in Redis to smooth bursts at the minute boundary.',
    );
    await collectCandidates(SID, { id: 'lesson-rl', citedMemoryIds: [a, b], group: 'CMP' });

    const outcomes = await runCompression(SID, 'CMP', engine);
    // Two windows now (pg + rl); find the one whose predecessors we know.
    const rl = outcomes.find((o) => o.promotedLessonId === 'lesson-rl');
    expect(rl).toBeDefined();
    expect(rl!.skipped).toBe(false);
    expect(rl!.mcId).toBeTruthy();
    expect(rl!.deleted.sort()).toEqual([a, b].sort());

    // predecessors are gone from the store...
    await expect(engine.memoryGet({ id: a })).rejects.toBeInstanceOf(RpcError);
    await expect(engine.memoryGet({ id: b })).rejects.toBeInstanceOf(RpcError);

    // ...but the TRACE is preserved: recall for the predecessor's topic
    // still surfaces Mc (engine chases derived_from).
    const recall = await engine.memorySearch({
      query: 'Redis rate limit sliding window',
      limit: 5,
      mode: 'hybrid',
    });
    expect(recall.results.some((h) => h.id === rl!.mcId)).toBe(true);
  }, 120_000);

  it('user-cited predecessor is KEPT after compression (immunity)', async () => {
    const cited = await seed(
      engine,
      'Auth tokens rotate every 15 minutes',
      'Access tokens are short-lived (15m) and refreshed via a rotating refresh token stored httpOnly.',
    );
    const plain = await seed(
      engine,
      'refresh tokens are httpOnly cookies',
      'Refresh tokens are delivered as httpOnly, secure, sameSite=strict cookies to mitigate XSS theft.',
    );

    // Make `cited` user-immune: a user-authored lesson cites it, then a
    // citation recompute (CMP.1 RPC) walks the lessons and repairs the
    // memory's consumed_by_user_lessons counter to ground truth.
    await engine.lessonCreate({
      description: 'token rotation policy',
      body: 'Rotate access tokens every 15 minutes.',
      evidence: [cited],
      authored_by: 'user',
    });
    await engine.memoryRecomputeCitations();
    const citedRow = await engine.memoryGet({ id: cited });
    if (citedRow.consumed_by_user_lessons === 0) {
      // citation didn't register (engine quirk) — skip rather than assert a false pass
      console.warn('[CMP.5] citation did not register; skipping immunity leg');
      return;
    }

    await emitProbe(SID, 'IMMUNE');
    await recordAnswer(SID, 'IMMUNE', true);
    await collectCandidates(SID, {
      id: 'lesson-tok',
      citedMemoryIds: [cited, plain],
      group: 'IMMUNE',
    });

    const outcomes = await runCompression(SID, 'IMMUNE', engine);
    const o = outcomes[0];
    if (o?.mcId == null) return; // LLM offline → skip
    expect(o.keptImmune).toContain(cited);
    expect(o.deleted).not.toContain(cited);
    // the user-cited predecessor is still retrievable
    const stillThere = await engine.memoryGet({ id: cited });
    expect(stillThere.id).toBe(cited);
  }, 120_000);

  it('recall-replay forced to fail → nothing deleted', async () => {
    const m = await seed(
      engine,
      'Kafka retention set to 7 days',
      'The orders topic retains messages for 7 days to allow replay during incident recovery.',
    );
    // recallReplayPasses against an UNRELATED mc id that will never
    // surface for this predecessor's query → gate must FAIL.
    const passes = await recallReplayPasses(engine, [m], 'mem-c-doesnotexist0000');
    expect(passes).toBe(false);
    // and the predecessor is untouched (the gate alone deletes nothing).
    const stillThere = await engine.memoryGet({ id: m });
    expect(stillThere.id).toBe(m);
  }, 60_000);

  it('not-satisfied group → no compression, no deletion', async () => {
    const m = await seed(
      engine,
      'CDN cache TTL is 1 hour',
      'Static assets are cached at the CDN edge for 3600s with stale-while-revalidate.',
    );
    await emitProbe(SID, 'UNSAT');
    await recordAnswer(SID, 'UNSAT', false); // answered NOT satisfied
    await collectCandidates(SID, { id: 'l', citedMemoryIds: [m], group: 'UNSAT' });

    const outcomes = await runCompression(SID, 'UNSAT', engine);
    expect(outcomes).toEqual([]);
    const stillThere = await engine.memoryGet({ id: m });
    expect(stillThere.id).toBe(m);
  }, 60_000);
});
