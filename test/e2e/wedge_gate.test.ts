/**
 * E2E wedge gate test — proof the loop-engine promotion gate FIRES on a
 * freshly created, evidence-less lesson.
 *
 * This is the canonical proof of the entire competitive moat per
 * `project_2026_05_12_strategic_pivot`: opensquid is the only system
 * that refuses to self-grade lesson promotion. If this test breaks, the
 * moat broke — that's a P0, NOT a "flaky test." Investigate immediately.
 *
 * Block-only by deliberate scope (spec T.6 line 967-969 + lessons.ts header):
 *   The engine's `PromotionConfig::default()` requires:
 *     - min_age = 24 hours
 *     - min_applied_count = 3 (accumulated via manifest.assemble side effect)
 *     - external_signal_sources non-empty (via lesson.capture_feedback)
 *     - causal_narrative present (auto-built only when evidence is supplied)
 *   None of those are satisfiable in unit-test timescales. That's the
 *   moat working as designed — NOT a bug, NOT something to bypass. T.8
 *   will file an engine follow-up to expose a PromotionConfig override
 *   for testing, but that's out of T.6 scope.
 *
 * Skip-if-no-binary discipline:
 *   The live engine binary lives at `~/projects/loop/engine/target/release/
 *   loop-engine` on local dev machines but is NOT built on CI (Rust cross-
 *   compile would dominate CI time + isn't required for the TS test
 *   matrix). `describe.skipIf(!hasEngineBinary())` skips the whole block
 *   cleanly when the binary is absent. Local runs assert the gate fires;
 *   CI runs verify the rest of the build doesn't regress.
 *
 * Hermeticity:
 *   - LOOP_HOME points at a fresh tmpdir per test run so engine state
 *     doesn't bleed into the user's real `~/.opensquid` memory store.
 *   - OPENSQUID_HOME also tmpdir-overridden so the daemon socket / pidfile
 *     don't collide with the user's existing engine daemon (if any).
 *   - Each test uses a Date.now()-suffixed description so concurrent runs
 *     can't collide on lesson IDs.
 *   - We do NOT delete created lessons — they accumulate inside the
 *     per-test tmpdir, which `afterAll` could remove but doesn't (so a
 *     failing test leaves evidence on disk for post-mortem). T.8 will
 *     audit whether this needs explicit cleanup; for T.6 the tmpdir
 *     isolation is enough.
 */

import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EngineClient, RpcError } from '../../src/engine/client.js';

// ---------------------------------------------------------------------------
// Binary discovery — mirror the live-test pattern (engine/client.live.test.ts).
// ---------------------------------------------------------------------------

const DEV_BINARY_PATH = join(
  process.env.HOME ?? '/tmp',
  'projects',
  'loop',
  'engine',
  'target',
  'release',
  'loop-engine',
);

function isExecutable(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function locateBinary(): string | null {
  const fromEnv = process.env.OPENSQUID_ENGINE_BIN?.trim();
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  if (isExecutable(DEV_BINARY_PATH)) return DEV_BINARY_PATH;
  return null;
}

function hasEngineBinary(): boolean {
  // Env var alone counts even if not yet executable — caller may set it for
  // a binary the test will spawn from a non-standard path. The literal dev
  // path needs to actually exist + be executable.
  return Boolean(process.env.OPENSQUID_ENGINE_BIN) || existsSync(DEV_BINARY_PATH);
}

// ---------------------------------------------------------------------------
// E2E block test — the moat firing.
// ---------------------------------------------------------------------------

describe.skipIf(!hasEngineBinary())('wedge gate fires (block-only E2E)', () => {
  let tmpHome: string;
  let tmpOpensquid: string;
  let priorBin: string | undefined;
  let priorLoopHome: string | undefined;
  let priorOpensquidHome: string | undefined;

  beforeAll(() => {
    const binary = locateBinary();
    tmpHome = mkdtempSync(join(tmpdir(), 'opensquid-wedge-loop-'));
    tmpOpensquid = mkdtempSync(join(tmpdir(), 'opensquid-wedge-os-'));
    priorBin = process.env.OPENSQUID_ENGINE_BIN;
    priorLoopHome = process.env.LOOP_HOME;
    priorOpensquidHome = process.env.OPENSQUID_HOME;
    if (binary) process.env.OPENSQUID_ENGINE_BIN = binary;
    process.env.LOOP_HOME = tmpHome;
    process.env.OPENSQUID_HOME = tmpOpensquid;
  });

  afterAll(() => {
    if (priorBin === undefined) delete process.env.OPENSQUID_ENGINE_BIN;
    else process.env.OPENSQUID_ENGINE_BIN = priorBin;
    if (priorLoopHome === undefined) delete process.env.LOOP_HOME;
    else process.env.LOOP_HOME = priorLoopHome;
    if (priorOpensquidHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorOpensquidHome;
  });

  it('blocks promotion when freshly created with no evidence and no applied_count', async () => {
    const client = new EngineClient();
    let createdId: string | undefined;
    try {
      const { id } = await client.lessonCreate({
        description: `E2E gate test ${Date.now()}`,
        body: 'This lesson should be blocked by the wedge gate.',
        // No evidence (so no causal_narrative is auto-built — see
        // engine/src/serve.rs:982-1000 build_narrative).
        // No authored_by (engine defaults to Llm, gate-eligible).
        // No pack_id / seed_as_promoted (skip path is pack-only).
      });
      createdId = id;

      let blocked = false;
      let reasons: string[] = [];
      try {
        await client.lessonPromote({ id });
      } catch (e: unknown) {
        // T.1.E: engine PromotionBlocked is JSON-RPC code -32000.
        if (e instanceof RpcError && e.code === -32000) {
          blocked = true;
          reasons = (e.data as { reasons?: string[] } | undefined)?.reasons ?? [];
        } else {
          throw e; // unexpected error type
        }
      }

      expect(
        blocked,
        `Expected wedge gate to block promotion of fresh lesson ${createdId}; ` +
          `got no error or wrong error code`,
      ).toBe(true);

      // T.1.F: BlockReason::Display renders kebab-case. Expected blocks for
      // a fresh, evidence-less, applied_count=0, external_signal_sources=[]
      // lesson are (any one or more):
      //   - missing-external-signal-sources
      //   - missing-causal-narrative (no evidence → no narrative)
      //   - insufficient-applied-count: observed=0 < required=3
      //   - time-floor: age=Ns < required=86400s
      expect(
        reasons,
        `Expected non-empty block reasons from engine; got: ${JSON.stringify(reasons)}`,
      ).not.toHaveLength(0);

      const expected = [
        'missing-external-signal-sources',
        'missing-causal-narrative',
        'insufficient-applied-count',
        'time-floor',
      ];
      const matched = reasons.some((r) => expected.some((e) => r.includes(e)));
      expect(
        matched,
        `Block reasons should include at least one of [${expected.join(', ')}]; ` +
          `got: ${reasons.join(' | ')}`,
      ).toBe(true);

      // Surface the actual reasons in test output so post-mortem doesn't
      // require re-running with verbose flags. Stderr (not stdout) so it
      // doesn't interleave with vitest's JSON reporter on CI — matches the
      // rest of the codebase's test-diagnostic convention.
      process.stderr.write(
        `[wedge-gate-e2e] block reasons for ${createdId}: ${JSON.stringify(reasons)}\n`,
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  it('block reasons are kebab-case Display strings (regression guard for T.1.F)', async () => {
    const client = new EngineClient();
    try {
      const { id } = await client.lessonCreate({
        description: `Kebab format check ${Date.now()}`,
        body: 'verify Display output format is kebab-case',
      });

      let reasons: string[] = [];
      try {
        await client.lessonPromote({ id });
      } catch (e: unknown) {
        if (e instanceof RpcError && e.code === -32000) {
          reasons = (e.data as { reasons?: string[] } | undefined)?.reasons ?? [];
        } else {
          throw e;
        }
      }

      // T.1.F: every BlockReason::Display string must match:
      //   - starts lowercase letter
      //   - lowercase + digits + hyphens
      //   - optional ': <data>' suffix for variants with inline data
      // The SemVer-surface property means changes here are breaking — if
      // this regex starts failing, do NOT loosen it. Either engine drifted
      // (open a T.8 follow-up + update gate.rs back to spec) or a new
      // variant has a different format (audit the variant + lock the format).
      const kebab = /^[a-z][a-z0-9-]*(-[a-z0-9]+)*(: .+)?$/;
      for (const r of reasons) {
        expect(
          r,
          `Block reason "${r}" should be kebab-case (lowercase + hyphens, optional ': data' suffix)`,
        ).toMatch(kebab);
      }
      // Independent assertion: we got at least one reason (otherwise the
      // for-loop above is a no-op and the test passes vacuously).
      expect(reasons.length, 'expected at least one block reason to validate').toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 30_000);
});
