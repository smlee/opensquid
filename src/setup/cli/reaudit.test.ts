/**
 * `opensquid gate reaudit` tests (T-deploy-commit-gate scope-4, design §2.4 + §4).
 *
 * Proves the lap-runnable CODE audit-on-diff produces the EXACT artifact the commit gate checks
 * (`{verdict, subjectHash: sha256(diff)}`), preserves the staleness anchor (anti-self-grading), and fails
 * every no-input class instead of writing a bogus pass. The model dispatch is stubbed via `ReauditDeps.runAudit`
 * so no real spawn happens.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWriteFile } from '../../runtime/atomic_write.js';
import { sha256Hex } from '../../runtime/durable/run_id.js';
import { sessionStateFile } from '../../runtime/paths.js';

import { buildCodeAuditPrompt, runReaudit, type ReauditDeps } from './reaudit.js';

const CACHE_KEY = 'fullstack-flow-code-audit-cache';
const DIFF = 'diff --git a/x.ts b/x.ts\n+const x = 1;\n';
const GUESS_FREE = 'VERDICT: GUESS_FREE\nAll hunks align to the scoped element.';

/** A fully-satisfied dep set with an in-memory write sink; each field overridable per test. */
function deps(
  over: Partial<ReauditDeps> = {},
  sink?: { key?: string; entry?: string },
): ReauditDeps {
  return {
    sid: () => Promise.resolve('sid-1'),
    pack: () => Promise.resolve('fullstack-flow'),
    evidence: () =>
      Promise.resolve({
        auditCacheKey: CACHE_KEY,
        requirePhaseLedger: true,
        requireSuiteGreen: false,
      }),
    diff: () => Promise.resolve(DIFF),
    rubric: () => Promise.resolve('# code rubric'),
    runAudit: () => Promise.resolve(GUESS_FREE),
    write: (_sid, key, entry) => {
      if (sink) {
        sink.key = key;
        sink.entry = entry;
      }
      return Promise.resolve();
    },
    ...over,
  };
}

describe('gate reaudit — the lap-runnable CODE audit-on-diff', () => {
  it('GUESS_FREE audit → writes {verdict, subjectHash: sha256(diff)} under the pack-declared cache key', async () => {
    const sink: { key?: string; entry?: string } = {};
    const res = await runReaudit('/repo', deps({}, sink));
    expect(res).toEqual({ ok: true, verdict: GUESS_FREE, guessFree: true, cacheKey: CACHE_KEY });
    expect(sink.key).toBe(CACHE_KEY);
    const parsed = JSON.parse(sink.entry!) as { verdict: string; subjectHash: string };
    expect(parsed.verdict).toBe(GUESS_FREE);
    // The staleness anchor the gate re-derives: subjectHash MUST equal sha256(git diff HEAD).
    expect(parsed.subjectHash).toBe(sha256Hex(DIFF));
  });

  it('the recorded subjectHash matches the CURRENT diff but NOT a since-changed one (anti-self-grading anchor)', async () => {
    const sink: { key?: string; entry?: string } = {};
    await runReaudit('/repo', deps({}, sink));
    const { subjectHash } = JSON.parse(sink.entry!) as { subjectHash: string };
    expect(subjectHash).toBe(sha256Hex(DIFF)); // certifies THIS diff
    expect(subjectHash).not.toBe(sha256Hex(`${DIFF}// changed\n`)); // a changed diff → stale → gate blocks
  });

  it('the audit prompt embeds the code rubric AND the diff (the single-standard producer)', () => {
    const prompt = buildCodeAuditPrompt('# THE-RUBRIC', DIFF);
    expect(prompt).toContain('# THE-RUBRIC');
    expect(prompt).toContain(DIFF);
    expect(prompt).toContain('GUESS-FREE CODE standard');
  });

  it('UNRESOLVED verdict → still written (a real verdict), but result.guessFree=false, exit non-zero', async () => {
    const sink: { key?: string; entry?: string } = {};
    const res = await runReaudit(
      '/repo',
      deps({ runAudit: () => Promise.resolve('VERDICT: UNRESOLVED\n- band-aid') }, sink),
    );
    expect(res).toEqual({
      ok: true,
      verdict: 'VERDICT: UNRESOLVED\n- band-aid',
      guessFree: false,
      cacheKey: CACHE_KEY,
    });
    expect(sink.entry).toBeDefined(); // an UNRESOLVED verdict is real → cached (the gate reads it and blocks)
  });

  it('audit returns NO VERDICT: line (unavailable) → NOT written, ok:false (retryable)', async () => {
    const sink: { key?: string; entry?: string } = {};
    const res = await runReaudit(
      '/repo',
      deps({ runAudit: () => Promise.resolve('the model timed out') }, sink),
    );
    expect(res.ok).toBe(false);
    expect(sink.entry).toBeUndefined(); // never pin an unavailable audit as a pass
  });

  it('dispatch throws → ok:false, nothing written', async () => {
    const sink: { key?: string; entry?: string } = {};
    const res = await runReaudit(
      '/repo',
      deps({ runAudit: () => Promise.reject(new Error('boom')) }, sink),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('boom');
    expect(sink.entry).toBeUndefined();
  });

  it('pack declares no commit_gate evidence (v1 coding-flow) → ok:false, no audit', async () => {
    const res = await runReaudit('/repo', deps({ evidence: () => Promise.resolve(null) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no commit_gate evidence');
  });

  it('no discipline pack → ok:false', async () => {
    const res = await runReaudit('/repo', deps({ pack: () => Promise.resolve(null) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no discipline pack');
  });

  it('no resolvable session → ok:false', async () => {
    const res = await runReaudit('/repo', deps({ sid: () => Promise.resolve(null) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no resolvable opensquid session');
  });

  it('no diff to audit → ok:false (nothing uncommitted / over-cap)', async () => {
    const res = await runReaudit('/repo', deps({ diff: () => Promise.resolve(null) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no diff to audit');
  });

  it('no readable CODE rubric → ok:false (fail-loud, never audit rubric-less)', async () => {
    const res = await runReaudit('/repo', deps({ rubric: () => Promise.resolve(null) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no readable CODE rubric');
  });

  describe('on-disk shape (default write to the real session-state file)', () => {
    let home: string;
    const saved = process.env.OPENSQUID_HOME;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'opensquid-reaudit-'));
      process.env.OPENSQUID_HOME = home;
    });
    afterEach(async () => {
      if (saved === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = saved;
      await rm(home, { recursive: true, force: true });
    });

    it('writes the {hash, verdict, subjectHash} entry the gate reads at sessionStateFile(sid, cacheKey)', async () => {
      // Exercise the REAL write path (atomicWriteFile → sessionStateFile), the same the default deps use.
      const res = await runReaudit(
        '/repo',
        deps({ write: (sid, key, entry) => atomicWriteFile(sessionStateFile(sid, key), entry) }),
      );
      expect(res.ok).toBe(true);
      const raw = await readFile(sessionStateFile('sid-1', CACHE_KEY), 'utf8');
      const parsed = JSON.parse(raw) as { hash: string; verdict: string; subjectHash: string };
      expect(parsed.verdict).toBe(GUESS_FREE);
      expect(parsed.subjectHash).toBe(sha256Hex(DIFF));
      expect(typeof parsed.hash).toBe('string');
    });
  });
});
