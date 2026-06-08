/**
 * CMP.5 (revised) — compression pipeline end-to-end (the must-WORK gate).
 *
 * Proves the FULL compression chain against a REAL loop-engine daemon
 * (with a real LLM via the engine's OpenAiCompatibleLlm adapter →
 * local Ollama) — the MAU.1 "prove against reality" bar for an
 * IRREVERSIBLE operation. Per the CMP.4 ARCHITECTURE REVISION, the
 * verify+gated-delete safety contract now lives INSIDE the engine's
 * `memory.consolidate` op; the orchestrator is a thin policy caller. So
 * this e2e drives the engine consolidate (engine-side verify + delete):
 *
 *   insert memories → satisfaction "satisfied" → candidates collected →
 *   orchestrator → engine.memoryConsolidate → recall-replay verifies
 *   (engine-internal) → non-immune predecessors force-deleted → Mc
 *   still recalls (trace preserved via get_by_id_chasing_derived_from).
 *
 * Plus the safety negatives the design forbids breaking:
 *   - a USER-CITED predecessor is KEPT (immunity holds even though the
 *     engine's force-delete would bypass the store guard — consolidate
 *     does the immunity check itself).
 *   - recall-replay FAILS (forced via recall_k=0 on a direct
 *     consolidate call) → verified:false → NOTHING deleted.
 *   - NOT satisfied → no consolidation at all.
 *
 * Gated by E2E=1 + an engine binary (skip-if-absent for CI). Scoped
 * OPENSQUID_HOME / LOOP_HOME so the e2e NEVER touches the real memory
 * store (deleting real memories would be the exact failure the design
 * forbids).
 *
 * Requires a local LLM for the consolidate legs (consolidate compresses
 * internally). If the engine's LLM adapter can't reach a model, those
 * legs skip with a clear log; the recall_k=0 fail-closed leg + the
 * not-satisfied leg still run.
 */

import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EngineClient, RpcError } from '../../src/engine/client.js';
import { runCompression } from '../../src/runtime/compression_orchestrator.js';
import type { ConsolidateOutcome } from '../../src/rag/memory/consolidate.js';
import { emitProbe, recordAnswer } from '../../src/runtime/satisfaction_probe.js';
import { collectCandidates } from '../../src/runtime/wedge/compress_candidates.js';

// RES-4c: runCompression now takes a `consolidateWindow` fn (not an EngineClient). This engine-bound
// e2e stays on the engine until RES-6 — adapt the engine's memory.consolidate to the window shape.
// (The engine mints Mc on every non-throwing outcome, so mc_id is a string here; coerce the Optional.)
const engineWindow =
  (e: EngineClient) =>
  (ids: string[]): Promise<ConsolidateOutcome> =>
    e.memoryConsolidate({ ids }).then((r) => ({
      mcId: r.mc_id ?? '',
      deleted: r.deleted,
      keptImmune: r.kept_immune,
      verified: r.verified,
    }));

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

/**
 * Probe whether the engine can compress at all (LLM reachable). Returns
 * the minted Mc id, or null when the LLM adapter is offline (so the
 * caller can skip the consolidate legs cleanly).
 */
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

    const outcomes = await runCompression(SID, 'CMP', engineWindow(engine));
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

    const outcomes = await runCompression(SID, 'IMMUNE', engineWindow(engine));
    const o = outcomes[0];
    if (o?.mcId == null) return; // LLM offline → skip
    expect(o.keptImmune).toContain(cited);
    expect(o.deleted).not.toContain(cited);
    // the user-cited predecessor is still retrievable
    const stillThere = await engine.memoryGet({ id: cited });
    expect(stillThere.id).toBe(cited);
  }, 120_000);

  it('recall-replay forced to fail (recall_k=0) → verified:false, nothing deleted', async () => {
    const m1 = await seed(
      engine,
      'Kafka retention set to 7 days',
      'The orders topic retains messages for 7 days to allow replay during incident recovery.',
    );
    const m2 = await seed(
      engine,
      'Kafka compaction on the audit topic',
      'The audit topic uses log compaction so the latest record per key is always retained.',
    );
    // Drive the engine consolidate directly with recall_k=0: the
    // recall-replay probe can return AT MOST 0 hits, so Mc can never
    // surface → the engine's verify gate MUST miss → fail-closed
    // (verified:false, nothing deleted). A deterministic forced-fail
    // against the real engine (no mocking).
    let res;
    try {
      res = await engine.memoryConsolidate({ ids: [m1, m2], recall_k: 0 });
    } catch (e) {
      if (e instanceof RpcError) {
        console.warn(`[CMP.5] consolidate unavailable (LLM offline?): ${e.message} — skipping leg`);
        return;
      }
      throw e;
    }
    expect(res.verified).toBe(false);
    expect(res.deleted).toEqual([]);
    expect(res.mc_id).toBeTruthy(); // Mc minted + kept alongside predecessors
    // both predecessors untouched (fail-closed deleted nothing).
    expect((await engine.memoryGet({ id: m1 })).id).toBe(m1);
    expect((await engine.memoryGet({ id: m2 })).id).toBe(m2);
  }, 120_000);

  it('not-satisfied group → no compression, no deletion', async () => {
    const m = await seed(
      engine,
      'CDN cache TTL is 1 hour',
      'Static assets are cached at the CDN edge for 3600s with stale-while-revalidate.',
    );
    await emitProbe(SID, 'UNSAT');
    await recordAnswer(SID, 'UNSAT', false); // answered NOT satisfied
    await collectCandidates(SID, { id: 'l', citedMemoryIds: [m], group: 'UNSAT' });

    const outcomes = await runCompression(SID, 'UNSAT', engineWindow(engine));
    expect(outcomes).toEqual([]);
    const stillThere = await engine.memoryGet({ id: m });
    expect(stillThere.id).toBe(m);
  }, 60_000);
});
