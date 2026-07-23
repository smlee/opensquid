/**
 * `opensquid gate reaudit` tests (T-deploy-commit-gate scope-4, design §2.4 + §4).
 *
 * Proves the lap-runnable CODE audit-on-diff produces the EXACT artifact the commit gate checks
 * (`{verdict, subjectHash: sha256(diff)}`), preserves the staleness anchor (anti-self-grading), and fails
 * every no-input class instead of writing a bogus pass. The model dispatch is stubbed via `ReauditDeps.runAudit`
 * so no real spawn happens.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatchCachedAudit } from '../../functions/cached_audit.js';
import { sha256Hex } from '../../runtime/durable/run_id.js';
import { readTaskAuditCache } from '../../runtime/loop/task_audit_cache.js';
import { readAuditTelemetryTail } from '../../runtime/loop/audit_telemetry.js';
import { recordSessionCwd } from '../../runtime/session_state.js';
import type { Pack } from '../../runtime/types.js';

import { materializePackAuditPolicy, runReaudit, type ReauditDeps } from './reaudit.js';

const CACHE_KEY = 'fullstack-flow-code-audit-cache';
const DIFF = 'diff --git a/x.ts b/x.ts\n+const x = 1;\n';
const GUESS_FREE = 'VERDICT: GUESS_FREE\nAll hunks align to the scoped element.';
const execFileP = promisify(execFile);

function packWithPrompts(
  prompts: readonly string[],
  criteria: Readonly<Record<number, readonly string[]>> = {},
): Pack {
  return {
    name: 'fullstack-flow',
    skills: [
      {
        rules: [
          {
            kind: 'track_check',
            process: [
              {
                call: 'cached_audit',
                args: {
                  cache_key: CACHE_KEY,
                  model: 'pack-reviewer',
                  timeout_ms: 123_456,
                  pass_verdict: 'GUESS_FREE',
                  fail_verdict: 'UNRESOLVED',
                  subject: '{{diff}}',
                  lenses: prompts.map((prompt, index) => ({
                    id: `lens-${String(index)}`,
                    prompt,
                    ...(criteria[index] === undefined ? {} : { criteria: criteria[index] }),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as Pack;
}

/** A fully-satisfied dep set; each field is overridable per test. */
function deps(over: Partial<ReauditDeps> = {}): ReauditDeps {
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
    policy: () =>
      Promise.resolve({
        cacheKey: CACHE_KEY,
        model: 'reasoning',
        timeoutMs: 600_000,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        subject: DIFF,
        lenses: [
          { id: 'before-code', prompt: 'before' },
          { id: 'after-code', prompt: 'after' },
          { id: 'architecture', prompt: 'architecture' },
          { id: 'rolling-author', prompt: 'rolling' },
        ],
      }),
    runAudit: () => Promise.resolve(GUESS_FREE),
    ...over,
  };
}

describe('gate reaudit — the lap-runnable CODE audit-on-diff', () => {
  it('passes exact session, pack, cache, and diff identity to the one canonical cached-audit owner', async () => {
    let seen: Parameters<ReauditDeps['runAudit']>[0] | undefined;
    const res = await runReaudit(
      '/repo',
      deps({
        runAudit: (dispatch) => {
          seen = dispatch;
          return Promise.resolve(GUESS_FREE);
        },
      }),
    );
    expect(res).toEqual({ ok: true, verdict: GUESS_FREE, guessFree: true, cacheKey: CACHE_KEY });
    expect(seen).toMatchObject({
      model: 'reasoning',
      sessionId: 'sid-1',
      packId: 'fullstack-flow',
      cacheKey: CACHE_KEY,
      subject: DIFF,
      timeoutMs: 600_000,
    });
  });

  it('matches success to the active pass token, never a hard-coded token that may be the failure policy', async () => {
    const inverted = {
      ...(await deps().policy('sid-1', 'fullstack-flow', CACHE_KEY, '# code rubric', DIFF))!,
      passVerdict: 'UNRESOLVED',
      failVerdict: 'GUESS_FREE',
    };
    expect(
      await runReaudit(
        '/repo',
        deps({
          policy: () => Promise.resolve(inverted),
          runAudit: () => Promise.resolve('VERDICT: GUESS_FREE\n- failed'),
        }),
      ),
    ).toMatchObject({ ok: true, guessFree: false });
    expect(
      await runReaudit(
        '/repo',
        deps({
          policy: () => Promise.resolve(inverted),
          runAudit: () => Promise.resolve('VERDICT: UNRESOLVED\n- passed'),
        }),
      ),
    ).toMatchObject({ ok: true, guessFree: true });
  });

  it('passes the current diff bytes, so a since-changed artifact has a distinct freshness identity', async () => {
    let seen = '';
    await runReaudit(
      '/repo',
      deps({
        runAudit: (dispatch) => {
          seen = dispatch.subject;
          return Promise.resolve(GUESS_FREE);
        },
      }),
    );
    expect(sha256Hex(seen)).toBe(sha256Hex(DIFF));
    expect(sha256Hex(seen)).not.toBe(sha256Hex(`${DIFF}// changed\n`));
  });

  it('materializes CODE lenses from pack policy without a core-owned prompt copy', () => {
    const policy = materializePackAuditPolicy(
      [packWithPrompts(['R={{rubric}} D={{diff}}', 'D={{diff}} R={{rubric}}'])],
      'fullstack-flow',
      CACHE_KEY,
      '# THE-RUBRIC',
      DIFF,
    );
    expect(policy).toMatchObject({
      cacheKey: CACHE_KEY,
      model: 'pack-reviewer',
      timeoutMs: 123_456,
      passVerdict: 'GUESS_FREE',
      failVerdict: 'UNRESOLVED',
    });
    expect(policy?.lenses.map((lens) => lens.id)).toEqual(['lens-0', 'lens-1']);
    for (const lens of policy?.lenses ?? []) {
      expect(lens.prompt).toContain('# THE-RUBRIC');
      expect(lens.prompt).toContain(DIFF);
      expect(lens.prompt).not.toContain('{{');
    }
  });

  it('interpolates authored placeholders once without interpreting artifact bytes recursively', () => {
    const policy = materializePackAuditPolicy(
      [packWithPrompts(['R={{rubric}} D={{diff}}', 'D={{diff}} R={{rubric}}'])],
      'fullstack-flow',
      CACHE_KEY,
      '# literal rubric token {{diff}}',
      'diff contains {{rubric}} literally',
    );
    expect(policy).not.toBeNull();
    expect(policy?.lenses[0]?.prompt).toContain('# literal rubric token {{diff}}');
    expect(policy?.lenses[0]?.prompt).toContain('diff contains {{rubric}} literally');

    const manyShortDiffs = `{{rubric}}${'{{diff}}'.repeat(20_000)}`;
    expect(
      materializePackAuditPolicy(
        [packWithPrompts([manyShortDiffs, manyShortDiffs])],
        'fullstack-flow',
        CACHE_KEY,
        'r'.repeat(200_000),
        'x',
      ),
    ).not.toBeNull();
  });

  it('rejects lenses that omit required evidence or retain unresolved placeholders', () => {
    expect(
      materializePackAuditPolicy(
        [packWithPrompts(['R={{rubric}}', 'R={{rubric}} D={{diff}}'])],
        'fullstack-flow',
        CACHE_KEY,
        '# rubric',
        DIFF,
      ),
    ).toBeNull();
    expect(
      materializePackAuditPolicy(
        [packWithPrompts(['R={{rubric}} D={{diff}} {{}}', 'R={{rubric}} D={{diff}}'])],
        'fullstack-flow',
        CACHE_KEY,
        '# rubric',
        DIFF,
      ),
    ).toBeNull();
    expect(
      materializePackAuditPolicy(
        [packWithPrompts(['R={{rubric}} D={{diff}} X={{unknown}}', 'R={{rubric}} D={{diff}}'])],
        'fullstack-flow',
        CACHE_KEY,
        '# rubric',
        DIFF,
      ),
    ).toBeNull();
    expect(
      materializePackAuditPolicy(
        [
          packWithPrompts(['R={{rubric}} D={{diff}}', 'R={{rubric}} D={{diff}}'], {
            0: ['criterion {{unknown}}'],
          }),
        ],
        'fullstack-flow',
        CACHE_KEY,
        '# rubric',
        DIFF,
      ),
    ).toBeNull();
    expect(
      materializePackAuditPolicy(
        [packWithPrompts(['R={{rubric}} D={{diff}}', 'R={{rubric}} D={{diff}}'])],
        'fullstack-flow',
        CACHE_KEY,
        '# rubric',
        `${DIFF}+const template = '{{artifact-owned}}';\n`,
      ),
    ).not.toBeNull();
    expect(
      materializePackAuditPolicy(
        [packWithPrompts(['R={{rubric}} D={{diff}}', 'R={{rubric}} D={{diff}}'])],
        'fullstack-flow',
        CACHE_KEY,
        '# rubric',
        'x'.repeat(300_001),
      ),
    ).toBeNull();
    expect(
      materializePackAuditPolicy(
        [
          packWithPrompts(['R={{rubric}} D={{diff}}', 'R={{rubric}} D={{diff}}'], {
            0: ['criterion {{diff}}'],
          }),
        ],
        'fullstack-flow',
        CACHE_KEY,
        '# rubric',
        'x'.repeat(4_097),
      ),
    ).toBeNull();
  });

  it('dispatches all four lenses with the ten-minute reviewer bound', async () => {
    let seen: Parameters<ReauditDeps['runAudit']>[0] | undefined;
    const res = await runReaudit(
      '/repo',
      deps({
        runAudit: (dispatch) => {
          seen = dispatch;
          return Promise.resolve(GUESS_FREE);
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(seen?.lenses).toHaveLength(4);
    expect(seen).toMatchObject({
      model: 'reasoning',
      timeoutMs: 600_000,
      passVerdict: 'GUESS_FREE',
      failVerdict: 'UNRESOLVED',
    });
  });

  it('UNRESOLVED verdict → result.guessFree=false so the CLI exits non-zero', async () => {
    const res = await runReaudit(
      '/repo',
      deps({ runAudit: () => Promise.resolve('VERDICT: UNRESOLVED\n- band-aid') }),
    );
    expect(res).toEqual({
      ok: true,
      verdict: 'VERDICT: UNRESOLVED\n- band-aid',
      guessFree: false,
      cacheKey: CACHE_KEY,
    });
  });

  it('audit returns NO VERDICT: line (unavailable) → ok:false (retryable)', async () => {
    const res = await runReaudit(
      '/repo',
      deps({ runAudit: () => Promise.resolve('the model timed out') }),
    );
    expect(res.ok).toBe(false);
  });

  it('dispatch throws → ok:false', async () => {
    const res = await runReaudit(
      '/repo',
      deps({ runAudit: () => Promise.reject(new Error('boom')) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('boom');
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

  it('pack without valid parallel audit lenses fails loud before dispatch', async () => {
    const res = await runReaudit('/repo', deps({ policy: () => Promise.resolve(null) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no valid parallel CODE audit lenses');
  });

  describe('canonical cached-audit ownership', () => {
    let home: string;
    let priorInline: string | undefined;
    let priorProject: string | undefined;
    let priorItem: string | undefined;
    const saved = process.env.OPENSQUID_HOME;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'opensquid-reaudit-'));
      process.env.OPENSQUID_HOME = home;
      priorInline = process.env.OPENSQUID_MODELS_CONFIG_INLINE;
      priorProject = process.env.OPENSQUID_PROJECT_ROOT;
      priorItem = process.env.OPENSQUID_ITEM_ID;
      process.env.OPENSQUID_PROJECT_ROOT = home;
      process.env.OPENSQUID_ITEM_ID = 'wg-a1b2c3d4e5f6';
      await mkdir(join(home, '.opensquid'));
      const fake = join(home, 'fake-reviewer.js');
      await writeFile(
        fake,
        `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('VERDICT: GUESS_FREE'));`,
        'utf8',
      );
      process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify({
        reasoning: { mode: 'subscription', impl: 'cli', cli: process.execPath, args: [fake] },
      });
    });
    afterEach(async () => {
      if (saved === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = saved;
      if (priorInline === undefined) delete process.env.OPENSQUID_MODELS_CONFIG_INLINE;
      else process.env.OPENSQUID_MODELS_CONFIG_INLINE = priorInline;
      if (priorProject === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
      else process.env.OPENSQUID_PROJECT_ROOT = priorProject;
      if (priorItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = priorItem;
      await rm(home, { recursive: true, force: true });
    });

    it('uses the live primitive to write the exact cache entry and per-lens ledger', async () => {
      const res = await runReaudit(
        '/repo',
        deps({
          runAudit: async (dispatch) => {
            const result = await dispatchCachedAudit(
              {
                cache_key: dispatch.cacheKey,
                model: dispatch.model,
                lenses: dispatch.lenses,
                ...(dispatch.timeoutMs === undefined ? {} : { timeout_ms: dispatch.timeoutMs }),
                pass_verdict: dispatch.passVerdict,
                fail_verdict: dispatch.failVerdict,
                subject: dispatch.subject,
              },
              {
                event: { kind: 'stop', assistantText: '' },
                bindings: new Map(),
                sessionId: dispatch.sessionId,
                packId: dispatch.packId,
              },
            );
            if (!result.ok) throw new Error(result.error.message);
            return String(result.value);
          },
        }),
      );
      expect(res.ok).toBe(true);
      const parsed = (await readTaskAuditCache('sid-1', CACHE_KEY))!;
      expect(parsed.verdict).toBeUndefined();
      expect(parsed.complete).toBe(true);
      expect(parsed.lenses).toHaveLength(4);
      expect(parsed.passVerdict).toBe('GUESS_FREE');
      expect(parsed.failVerdict).toBe('UNRESOLVED');
      expect(parsed.subjectHash).toBe(sha256Hex(DIFF));
      expect(typeof parsed.hash).toBe('string');
      expect(await readAuditTelemetryTail('sid-1', 10)).toHaveLength(4);
    });

    it('runs the default gate action path from project/session discovery to the canonical owner', async () => {
      const project = await mkdtemp(join(tmpdir(), 'opensquid-reaudit-project-'));
      const priorProject = process.env.OPENSQUID_PROJECT_ROOT;
      const priorSession = process.env.OPENSQUID_SESSION_ID;
      const priorItem = process.env.OPENSQUID_ITEM_ID;
      try {
        await execFileP('git', ['init'], { cwd: project });
        await execFileP('git', ['config', 'user.email', 'test@example.invalid'], { cwd: project });
        await execFileP('git', ['config', 'user.name', 'Test'], { cwd: project });
        await writeFile(join(project, 'x.ts'), 'export const x = 1;\n', 'utf8');
        await execFileP('git', ['add', 'x.ts'], { cwd: project });
        await execFileP('git', ['commit', '-m', 'test: seed'], { cwd: project });
        await writeFile(join(project, 'x.ts'), 'export const x = 2;\n', 'utf8');
        await mkdir(join(project, '.opensquid'));
        await writeFile(
          join(project, '.opensquid', 'active.json'),
          JSON.stringify({ packs: ['fullstack-flow', 'default-discipline'] }),
          'utf8',
        );
        process.env.OPENSQUID_PROJECT_ROOT = project;
        process.env.OPENSQUID_SESSION_ID = 'reaudit-live-path';
        process.env.OPENSQUID_ITEM_ID = 'wg-a1b2c3d4e5f6';
        await recordSessionCwd('reaudit-live-path', project);

        const result = await runReaudit(project);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.verdict).toMatch(/^VERDICT: GUESS_FREE/);
        const entry = await readTaskAuditCache(
          'reaudit-live-path',
          'fullstack-flow-code-audit-cache',
        );
        expect(entry?.complete).toBe(true);
        expect(entry?.lenses).toHaveLength(4);
      } finally {
        if (priorProject === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
        else process.env.OPENSQUID_PROJECT_ROOT = priorProject;
        if (priorSession === undefined) delete process.env.OPENSQUID_SESSION_ID;
        else process.env.OPENSQUID_SESSION_ID = priorSession;
        if (priorItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
        else process.env.OPENSQUID_ITEM_ID = priorItem;
        await rm(project, { recursive: true, force: true });
      }
    });
  });
});
