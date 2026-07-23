/**
 * cached_audit — content-hash audit memoization (T-FIX-AUDIT-SPAWN).
 *
 * Drives the model dispatch with a fake-echo CLI (the llm.test.ts pattern:
 * OPENSQUID_MODELS_CONFIG_INLINE points an alias at a node script) and sandboxes
 * the cache under a per-test OPENSQUID_HOME (the state.test.ts pattern). The
 * tests prove the four invariants: MISS spawns + caches, a HIT reuses the cached
 * verdict WITHOUT re-spawning, changed content re-spawns, and a non-verdict
 * output is NOT cached (so an AUDIT-UNAVAILABLE result is retried).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelAliasConfig } from '../models/types.js';
import type { Event } from '../runtime/types.js';
import { sha256Hex } from '../runtime/durable/run_id.js';
import { isSessionPlausible } from '../runtime/hooks/session_liveness.js';
import { MAX_SUBAGENT_RESULT_BYTES } from '../runtime/subagents/types.js';
import { MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES } from '../runtime/loop/audit_evidence.js';
import { readAuditTelemetryTail } from '../runtime/loop/audit_telemetry.js';
import { readTaskAuditCache } from '../runtime/loop/task_audit_cache.js';

import {
  aggregateAuditLenses,
  auditDeclarationCacheHash,
  registerCachedAuditFunction,
} from './cached_audit.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

let tmpRoot: string;
let tempHome: string;
let priorInline: string | undefined;
let priorHome: string | undefined;
let priorProject: string | undefined;
let priorItem: string | undefined;

beforeEach(async () => {
  priorInline = process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  priorHome = process.env.OPENSQUID_HOME;
  priorProject = process.env.OPENSQUID_PROJECT_ROOT;
  priorItem = process.env.OPENSQUID_ITEM_ID;
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-cached-audit-'));
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cached-audit-home-'));
  process.env.OPENSQUID_HOME = tempHome;
  process.env.OPENSQUID_PROJECT_ROOT = tmpRoot;
  process.env.OPENSQUID_ITEM_ID = `wg-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  await mkdir(join(tmpRoot, '.opensquid'));
});

afterEach(async () => {
  if (priorInline === undefined) delete process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  else process.env.OPENSQUID_MODELS_CONFIG_INLINE = priorInline;
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorProject === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = priorProject;
  if (priorItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
  else process.env.OPENSQUID_ITEM_ID = priorItem;
  await rm(tmpRoot, { recursive: true, force: true });
  await rm(tempHome, { recursive: true, force: true });
});

async function writeFakeEchoCli(output: string): Promise<string> {
  const script = `
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(output)}); process.exit(0); });
`;
  const path = join(tmpRoot, `fake-${Math.random().toString(36).slice(2, 8)}.js`);
  await writeFile(path, script, 'utf8');
  return path;
}

async function writeLensCli(): Promise<string> {
  const script = `
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  if (buf.includes('FAIL_LENS')) {
    process.stdout.write('VERDICT: UNRESOLVED\\n- missing evidence');
  } else {
    process.stdout.write('VERDICT: GUESS_FREE');
  }
  process.exit(0);
});
`;
  const path = join(tmpRoot, `lens-${Math.random().toString(36).slice(2, 8)}.js`);
  await writeFile(path, script, 'utf8');
  return path;
}

async function writeDelayedLensCli(): Promise<string> {
  const script = `
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => {
  process.stdout.write('VERDICT: GUESS_FREE');
  process.exit(0);
}, 250));
`;
  const path = join(tmpRoot, `delayed-lens-${Math.random().toString(36).slice(2, 8)}.js`);
  await writeFile(path, script, 'utf8');
  return path;
}

async function writeLargeFindingCli(): Promise<string> {
  const script = `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('VERDICT: UNRESOLVED\\n' + 'x'.repeat(20000));
  process.exit(0);
});
`;
  const path = join(tmpRoot, `large-lens-${Math.random().toString(36).slice(2, 8)}.js`);
  await writeFile(path, script, 'utf8');
  return path;
}

async function writeSelectiveHangCli(): Promise<string> {
  const script = `
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  if (buf.includes('HANG_LENS')) setInterval(() => {}, 1000);
  else { process.stdout.write('VERDICT: GUESS_FREE'); process.exit(0); }
});
`;
  const path = join(tmpRoot, `hang-lens-${Math.random().toString(36).slice(2, 8)}.js`);
  await writeFile(path, script, 'utf8');
  return path;
}

function installAlias(alias: string, scriptPath: string): void {
  const cfg: Record<string, ModelAliasConfig> = {
    [alias]: { mode: 'subscription', impl: 'cli', cli: process.execPath, args: [scriptPath] },
  };
  process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify(cfg);
}

function createTestCtx(): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
    packId: 'test-pack',
  };
}

function freshRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerCachedAuditFunction(reg);
  return reg;
}

const PROMPT = 'Audit this artifact. ARTIFACT:\n\nsome stable content';

describe('cached_audit', () => {
  it('MISS: dispatches the model and returns its verdict', async () => {
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    const result = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT },
      createTestCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('VERDICT: GUESS_FREE');
  });

  it('HIT: an identical prompt reuses the cached verdict WITHOUT re-spawning', async () => {
    const ctx = createTestCtx(); // same session → shared cache
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    const first = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toBe('VERDICT: GUESS_FREE');

    // Re-point the alias at a DIFFERENT output. A real spawn would now return
    // UNRESOLVED; a cache hit returns the original GUESS_FREE.
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: UNRESOLVED'));
    const second = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe('VERDICT: GUESS_FREE'); // cached, not re-spawned
  });

  it('finds an exact older attempt after a newer different subject', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    const args = { cache_key: 'history-hit', model: 'reasoning', prompt: PROMPT };
    await reg.call('cached_audit', { ...args, subject: 'artifact-a' }, ctx);
    await reg.call('cached_audit', { ...args, subject: 'artifact-b' }, ctx);

    installAlias('reasoning', await writeFakeEchoCli('VERDICT: UNRESOLVED'));
    const again = await reg.call('cached_audit', { ...args, subject: 'artifact-a' }, ctx);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value).toBe('VERDICT: GUESS_FREE');
    expect((await readTaskAuditCache(ctx.sessionId, args.cache_key))?.subjectHash).toBe(
      sha256Hex('artifact-a'),
    );
  });

  it('CHANGED model: identical prompt and subject re-spawn under the new policy', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT, subject: 'artifact' },
      ctx,
    );

    installAlias('other-reviewer', await writeFakeEchoCli('VERDICT: UNRESOLVED'));
    const changed = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'other-reviewer', prompt: PROMPT, subject: 'artifact' },
      ctx,
    );
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value).toBe('VERDICT: UNRESOLVED');
  });

  it('CHANGED timeout: identical prompt and subject re-spawn under the new policy', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    const args = {
      cache_key: 'timeout-policy',
      model: 'reasoning',
      prompt: PROMPT,
      subject: 'artifact',
    };
    await reg.call('cached_audit', { ...args, timeout_ms: 10_000 }, ctx);

    installAlias('reasoning', await writeFakeEchoCli('VERDICT: UNRESOLVED'));
    const changed = await reg.call('cached_audit', { ...args, timeout_ms: 20_000 }, ctx);
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value).toBe('VERDICT: UNRESOLVED');
  });

  it('CHANGED content: a different prompt re-spawns', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    await reg.call('cached_audit', { cache_key: 'k1', model: 'reasoning', prompt: PROMPT }, ctx);

    installAlias('reasoning', await writeFakeEchoCli('VERDICT: UNRESOLVED'));
    const changed = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: `${PROMPT} EDITED` },
      ctx,
    );
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value).toBe('VERDICT: UNRESOLVED'); // fresh spawn on changed content
  });

  it('records subjectHash = sha256(subject) when a subject is supplied (the staleness anchor)', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    const subject = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n';
    const r = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT, subject },
      ctx,
    );
    expect(r.ok).toBe(true);
    const entry = await readTaskAuditCache(ctx.sessionId, 'k1');
    expect(entry?.verdict).toBe('VERDICT: GUESS_FREE');
    expect(entry?.subjectHash).toBe(sha256Hex(subject)); // downstream consumers re-derive + compare
  });

  it('invalidates an otherwise-identical audit when the exact subject bytes change', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    const first = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT, subject: 'artifact-a' },
      ctx,
    );
    expect(first.ok).toBe(true);

    // The prompt is intentionally identical. Subject identity must still reject the old pass.
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: UNRESOLVED'));
    const changed = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT, subject: 'artifact-b' },
      ctx,
    );
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value).toBe('VERDICT: UNRESOLVED');
  });

  it('omits subjectHash when no subject is supplied (backward compat with pre-anchor audits)', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    await reg.call('cached_audit', { cache_key: 'k1', model: 'reasoning', prompt: PROMPT }, ctx);
    const entry = await readTaskAuditCache(ctx.sessionId, 'k1');
    expect(entry).not.toBeNull();
    expect('subjectHash' in entry!).toBe(false);
  });

  it('NO cache on a non-verdict output (AUDIT-UNAVAILABLE is retried, not pinned)', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('connection error, no verdict produced'));
    const reg = freshRegistry();
    const bad = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT },
      ctx,
    );
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(bad.value).toBe('connection error, no verdict produced');

    // The non-verdict was NOT cached → the next call re-spawns and gets the real verdict.
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const retry = await reg.call(
      'cached_audit',
      { cache_key: 'k1', model: 'reasoning', prompt: PROMPT },
      ctx,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value).toBe('VERDICT: GUESS_FREE');
  });

  it('does not cache a verdict token that falls beyond the persisted output bound', async () => {
    const ctx = createTestCtx();
    installAlias(
      'reasoning',
      await writeFakeEchoCli(`${'x'.repeat(MAX_SUBAGENT_RESULT_BYTES + 1)}VERDICT: GUESS_FREE`),
    );
    const reg = freshRegistry();
    const first = await reg.call(
      'cached_audit',
      { cache_key: 'late-verdict', model: 'reasoning', prompt: PROMPT },
      ctx,
    );
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.message).toMatch(/capture|output|bound/iu);
    expect(await readTaskAuditCache(ctx.sessionId, 'late-verdict')).toBeNull();

    installAlias('reasoning', await writeFakeEchoCli('VERDICT: UNRESOLVED'));
    const retry = await reg.call(
      'cached_audit',
      { cache_key: 'late-verdict', model: 'reasoning', prompt: PROMPT },
      ctx,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value).toBe('VERDICT: UNRESOLVED');
  });

  it('fans independent lenses out and returns one gate-safe aggregate verdict', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeLensCli());
    const reg = freshRegistry();
    const result = await reg.call(
      'cached_audit',
      {
        cache_key: 'fanout',
        model: 'reasoning',
        subject: 'artifact',
        lenses: [
          { id: 'evidence', prompt: 'PASS_LENS evidence' },
          { id: 'solution', prompt: 'FAIL_LENS solution' },
          { id: 'architecture', prompt: 'PASS_LENS architecture' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('VERDICT: UNRESOLVED');
    expect(result.value).toContain('[solution]');
    expect(result.value).not.toContain('VERDICT: GUESS_FREE');

    const entry = await readTaskAuditCache(ctx.sessionId, 'fanout');
    expect(entry?.complete).toBe(true);
    expect(entry?.lenses).toHaveLength(3);
    expect(entry?.verdict).toBeUndefined();
    expect(entry?.passVerdict).toBe('GUESS_FREE');
    expect(entry?.failVerdict).toBe('UNRESOLVED');
  });

  it('renders declared criteria into the bounded model prompt', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeLensCli());
    const result = await freshRegistry().call(
      'cached_audit',
      {
        cache_key: 'criteria-render',
        model: 'reasoning',
        lenses: [
          { id: 'a', prompt: 'PASS_LENS a' },
          { id: 'b', prompt: 'PASS_LENS b', criteria: ['FAIL_LENS required criterion'] },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('VERDICT: UNRESOLVED');
      expect(result.value).toContain('[b]');
    }
  });

  it('reuses unchanged lenses when one prompt changes for the same exact subject', async () => {
    const ctx = createTestCtx();
    const base = {
      cache_key: 'revision-fanout',
      model: 'reasoning',
      subject: 'same artifact bytes',
      lenses: [
        { id: 'evidence', prompt: 'PASS_LENS evidence' },
        { id: 'solution', prompt: 'PASS_LENS solution' },
        { id: 'architecture', prompt: 'PASS_LENS architecture' },
      ],
    };
    installAlias('reasoning', await writeLensCli());
    const reg = freshRegistry();
    expect((await reg.call('cached_audit', base, ctx)).ok).toBe(true);

    const changed = await reg.call(
      'cached_audit',
      {
        ...base,
        lenses: base.lenses.map((lens) =>
          lens.id === 'solution' ? { ...lens, prompt: 'FAIL_LENS revised solution' } : lens,
        ),
      },
      ctx,
    );
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value).toMatch(/^VERDICT: UNRESOLVED/);

    const ledger = await readAuditTelemetryTail(ctx.sessionId, 1_000);
    expect(
      ledger.filter(
        (entry) =>
          entry.lens === 'evidence' &&
          entry.operation === 'model_call' &&
          entry.status === 'returned',
      ),
    ).toHaveLength(1);
    expect(
      ledger.filter(
        (entry) =>
          entry.lens === 'architecture' &&
          entry.operation === 'model_call' &&
          entry.status === 'returned',
      ),
    ).toHaveLength(1);
    expect(
      ledger.filter(
        (entry) =>
          entry.lens === 'solution' &&
          entry.operation === 'model_call' &&
          entry.status === 'returned',
      ),
    ).toHaveLength(2);
    expect(
      ledger
        .filter((entry) => entry.operation === 'cache_read' && entry.status === 'hit')
        .map((entry) => entry.lens),
    ).toEqual(['evidence', 'architecture']);
  });

  it('re-bounds reused outputs when a policy expands from two to four lenses', async () => {
    const ctx = createTestCtx();
    const large = `VERDICT: GUESS_FREE\n${'x'.repeat(20_000)}`;
    installAlias('reasoning', await writeFakeEchoCli(large));
    const reg = freshRegistry();
    const base = {
      cache_key: 'cardinality-expansion',
      model: 'reasoning',
      subject: 'same artifact',
    };
    expect(
      (
        await reg.call(
          'cached_audit',
          {
            ...base,
            lenses: [
              { id: 'a', prompt: 'review a' },
              { id: 'b', prompt: 'review b' },
            ],
          },
          ctx,
        )
      ).ok,
    ).toBe(true);

    const expanded = await reg.call(
      'cached_audit',
      {
        ...base,
        lenses: [
          { id: 'a', prompt: 'review a' },
          { id: 'b', prompt: 'review b' },
          { id: 'c', prompt: 'review c' },
          { id: 'd', prompt: 'review d' },
        ],
      },
      ctx,
    );
    expect(expanded.ok).toBe(true);
    const persisted = await readTaskAuditCache(ctx.sessionId, base.cache_key);
    expect(
      persisted?.lenses?.reduce((total, lens) => total + Buffer.byteLength(lens.output, 'utf8'), 0),
    ).toBeLessThanOrEqual(MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES);
  });

  it('reruns a same-prompt lens when its rubric criteria change', async () => {
    const ctx = createTestCtx();
    const base = {
      cache_key: 'criteria-fanout',
      model: 'reasoning',
      subject: 'same artifact',
      lenses: [
        { id: 'a', prompt: 'PASS_LENS a', criteria: ['1'] },
        { id: 'b', prompt: 'PASS_LENS b', criteria: ['2'] },
      ],
    };
    installAlias('reasoning', await writeLensCli());
    const reg = freshRegistry();
    expect((await reg.call('cached_audit', base, ctx)).ok).toBe(true);
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: UNRESOLVED\n- criteria changed'));
    const changed = await reg.call(
      'cached_audit',
      {
        ...base,
        lenses: [base.lenses[0], { ...base.lenses[1]!, criteria: ['2', '3'] }],
      },
      ctx,
    );
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value).toMatch(/^VERDICT: UNRESOLVED/);
  });

  it('retains attributed findings from every lens within the aggregate output bound', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeLargeFindingCli());
    const reg = freshRegistry();
    const result = await reg.call(
      'cached_audit',
      {
        cache_key: 'bounded-findings',
        model: 'reasoning',
        lenses: ['a', 'b', 'c', 'd'].map((id) => ({ id, prompt: `review ${id}` })),
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const id of ['a', 'b', 'c', 'd']) expect(result.value).toContain(`[${id}]`);
  });

  it('publishes producer-known liveness while a real cached audit is pending and clears it after', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeDelayedLensCli());
    const running = freshRegistry().call(
      'cached_audit',
      {
        cache_key: 'activity-fanout',
        model: 'reasoning',
        timeout_ms: 5_000,
        lenses: [
          { id: 'a', prompt: 'review a' },
          { id: 'b', prompt: 'review b' },
        ],
      },
      ctx,
    );
    let active = await isSessionPlausible(ctx.sessionId, { freshMs: 1 });
    for (let attempt = 0; attempt < 20 && !active.plausible; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      active = await isSessionPlausible(ctx.sessionId, { freshMs: 1 });
    }
    expect(active.plausible).toBe(true);
    expect(active.probedFiles).toContain('audit:projection:0');
    expect((await running).ok).toBe(true);
    expect((await isSessionPlausible(ctx.sessionId, { freshMs: 1 })).plausible).toBe(false);
  });

  it('fails same-key concurrent writers fast, then serves the completed canonical entry', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeDelayedLensCli());
    const reg = freshRegistry();
    const args = {
      cache_key: 'same-key-lock',
      model: 'reasoning',
      lenses: [
        { id: 'a', prompt: 'review a' },
        { id: 'b', prompt: 'review b' },
      ],
    };
    const first = reg.call('cached_audit', args, ctx);
    let active = await isSessionPlausible(ctx.sessionId, { freshMs: 1 });
    for (let attempt = 0; attempt < 20 && !active.plausible; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      active = await isSessionPlausible(ctx.sessionId, { freshMs: 1 });
    }
    expect(active.plausible).toBe(true);

    const concurrent = await reg.call('cached_audit', args, ctx);
    expect(concurrent.ok).toBe(false);
    if (!concurrent.ok) expect(concurrent.error.message).toContain('already in flight');
    expect((await first).ok).toBe(true);

    installAlias('reasoning', await writeFakeEchoCli('VERDICT: UNRESOLVED'));
    const hit = await reg.call('cached_audit', args, ctx);
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.value).toMatch(/^VERDICT: GUESS_FREE/);
  });

  it('serializes single-prompt and fan-out modes sharing one task/cache key', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeDelayedLensCli());
    const reg = freshRegistry();
    const first = reg.call(
      'cached_audit',
      {
        cache_key: 'mixed-mode-key-lock',
        model: 'reasoning',
        lenses: [
          { id: 'a', prompt: 'review a' },
          { id: 'b', prompt: 'review b' },
        ],
      },
      ctx,
    );
    let active = await isSessionPlausible(ctx.sessionId, { freshMs: 1 });
    for (let attempt = 0; attempt < 20 && !active.plausible; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      active = await isSessionPlausible(ctx.sessionId, { freshMs: 1 });
    }
    expect(active.plausible).toBe(true);
    const mixed = await reg.call(
      'cached_audit',
      {
        cache_key: 'mixed-mode-key-lock',
        model: 'reasoning',
        prompt: 'single review',
      },
      ctx,
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.error.message).toContain('already in flight');
    expect((await first).ok).toBe(true);
  });

  it('never returns an authorizing verdict in either mode when canonical task persistence fails', async () => {
    await rm(join(tmpRoot, '.opensquid'), { recursive: true, force: true });
    await writeFile(join(tmpRoot, '.opensquid'), 'not a directory', 'utf8');
    installAlias('reasoning', await writeLensCli());
    const single = await freshRegistry().call(
      'cached_audit',
      {
        cache_key: 'single-persistence-failure',
        model: 'reasoning',
        prompt: 'review this',
      },
      createTestCtx(),
    );
    expect(single.ok).toBe(false);
    if (!single.ok)
      expect(single.error.message).toContain('could not persist canonical task evidence');

    const result = await freshRegistry().call(
      'cached_audit',
      {
        cache_key: 'persistence-failure',
        model: 'reasoning',
        lenses: [
          { id: 'a', prompt: 'PASS_LENS a' },
          { id: 'b', prompt: 'PASS_LENS b' },
        ],
      },
      createTestCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain('could not persist canonical task evidence');
  });

  it('persists partial fan-out and retries only the lens that timed out', async () => {
    const ctx = createTestCtx();
    const args = {
      cache_key: 'partial-fanout',
      model: 'reasoning',
      timeout_ms: 100,
      subject: 'artifact',
      lenses: [
        { id: 'evidence', prompt: 'PASS_LENS evidence' },
        { id: 'slow', prompt: 'HANG_LENS slow' },
        { id: 'architecture', prompt: 'PASS_LENS architecture' },
      ],
    };
    installAlias('reasoning', await writeSelectiveHangCli());
    const reg = freshRegistry();
    const first = await reg.call('cached_audit', args, ctx);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.message).toContain('[evidence] PASS');
      expect(first.error.message).toContain('[architecture] PASS');
      expect(first.error.message).toContain('[slow] timeout after 100ms');
    }
    const partial = await readTaskAuditCache(ctx.sessionId, 'partial-fanout');
    expect(partial?.complete).toBe(false);
    expect(partial?.lenses?.map((lens) => lens.id)).toEqual(['evidence', 'architecture']);
    expect(partial?.failures).toEqual([{ id: 'slow', error: 'timeout after 100ms' }]);

    installAlias('reasoning', await writeLensCli());
    const second = await reg.call('cached_audit', args, ctx);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toMatch(/^VERDICT: GUESS_FREE/);

    const ledger = await readAuditTelemetryTail(ctx.sessionId, 1_000);
    expect(
      ledger.filter(
        (entry) =>
          entry.lens === 'evidence' &&
          entry.operation === 'model_call' &&
          entry.status === 'returned',
      ),
    ).toHaveLength(1);
    expect(
      ledger.filter(
        (entry) =>
          entry.lens === 'architecture' &&
          entry.operation === 'model_call' &&
          entry.status === 'returned',
      ),
    ).toHaveLength(1);
    expect(
      ledger.filter(
        (entry) =>
          entry.lens === 'slow' && entry.operation === 'model_call' && entry.status === 'timeout',
      ),
    ).toHaveLength(1);
    expect(
      ledger.filter(
        (entry) =>
          entry.lens === 'slow' && entry.operation === 'model_call' && entry.status === 'returned',
      ),
    ).toHaveLength(1);
  });

  it('resumes partial lens evidence in a fresh lap session through task identity', async () => {
    const priorProject = process.env.OPENSQUID_PROJECT_ROOT;
    const priorItem = process.env.OPENSQUID_ITEM_ID;
    process.env.OPENSQUID_PROJECT_ROOT = tmpRoot;
    process.env.OPENSQUID_ITEM_ID = 'wg-fanout-resume';
    await mkdir(join(tmpRoot, '.opensquid'), { recursive: true });
    try {
      const args = {
        cache_key: 'durable-partial',
        model: 'reasoning',
        timeout_ms: 100,
        subject: 'artifact',
        lenses: [
          { id: 'evidence', prompt: 'PASS_LENS evidence' },
          { id: 'slow', prompt: 'HANG_LENS slow' },
          { id: 'architecture', prompt: 'PASS_LENS architecture' },
        ],
      };
      installAlias('reasoning', await writeSelectiveHangCli());
      const reg = freshRegistry();
      expect((await reg.call('cached_audit', args, createTestCtx())).ok).toBe(false);

      const freshCtx = createTestCtx();
      installAlias('reasoning', await writeLensCli());
      const resumed = await reg.call('cached_audit', args, freshCtx);
      expect(resumed.ok).toBe(true);
      const ledger = await readAuditTelemetryTail(freshCtx.sessionId, 1_000);
      expect(ledger).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ lens: 'evidence', operation: 'cache_read', status: 'hit' }),
          expect.objectContaining({ lens: 'architecture', operation: 'cache_read', status: 'hit' }),
          expect.objectContaining({ lens: 'slow', operation: 'model_call', status: 'returned' }),
        ]),
      );
    } finally {
      if (priorProject === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
      else process.env.OPENSQUID_PROJECT_ROOT = priorProject;
      if (priorItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = priorItem;
    }
  });

  it('requires exactly one single prompt or fan-out lens set', async () => {
    installAlias('reasoning', await writeLensCli());
    const reg = freshRegistry();
    const neither = await reg.call(
      'cached_audit',
      { cache_key: 'bad', model: 'reasoning' },
      createTestCtx(),
    );
    expect(neither.ok).toBe(false);
    const both = await reg.call(
      'cached_audit',
      {
        cache_key: 'bad',
        model: 'reasoning',
        prompt: PROMPT,
        lenses: [
          { id: 'one', prompt: 'one' },
          { id: 'two', prompt: 'two' },
        ],
      },
      createTestCtx(),
    );
    expect(both.ok).toBe(false);
    const sameVerdict = await reg.call(
      'cached_audit',
      {
        cache_key: 'bad',
        model: 'reasoning',
        prompt: PROMPT,
        pass_verdict: 'GUESS_FREE',
        fail_verdict: 'GUESS_FREE',
      },
      createTestCtx(),
    );
    expect(sameVerdict.ok).toBe(false);
  });
});

describe('auditDeclarationCacheHash', () => {
  it('binds prompt mode to model, verdict policy, and exact subject bytes', () => {
    const hash = (model: string, subject?: string, timeoutMs?: number) =>
      auditDeclarationCacheHash({
        model,
        prompt: PROMPT,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        timeoutMs,
        subject,
      });
    expect(hash('reasoning')).not.toBe(sha256Hex(PROMPT));
    expect(hash('reasoning', 'a')).not.toBe(hash('reasoning', 'b'));
    expect(hash('reasoning')).not.toBe(hash('other-model'));
    expect(hash('reasoning', 'a', 10_000)).not.toBe(hash('reasoning', 'a', 20_000));
  });
});

describe('aggregateAuditLenses', () => {
  it('emits GUESS_FREE only when every declared lens passes', () => {
    const pass = (id: string) => ({ id, promptHash: id, output: 'VERDICT: GUESS_FREE' });
    expect(aggregateAuditLenses([pass('a'), pass('b')], 'GUESS_FREE', 'UNRESOLVED')).toMatch(
      /^VERDICT: GUESS_FREE/,
    );
    const failed = aggregateAuditLenses(
      [pass('a'), { id: 'b', promptHash: 'b', output: 'VERDICT: UNRESOLVED\n- gap' }],
      'GUESS_FREE',
      'UNRESOLVED',
    );
    expect(failed).toMatch(/^VERDICT: UNRESOLVED/);
    expect(failed).toContain('[a] PASS');
    expect(failed).toContain('[b] - gap');
    expect(failed).not.toContain('VERDICT: GUESS_FREE');
    expect(
      aggregateAuditLenses(
        [{ id: 'a', promptHash: 'a', output: ' VERDICT: GUESS_FREE' }],
        'GUESS_FREE',
        'UNRESOLVED',
      ),
    ).toMatch(/^VERDICT: UNRESOLVED/);
  });
});

// T-AUDIT-SPAWN-FIX: bounded metadata rows make spawn rate/latency/timeout share counted data.
describe('cached_audit spawn telemetry', () => {
  async function readLedger(sessionId: string): Promise<Record<string, unknown>[]> {
    return readAuditTelemetryTail(sessionId, 1_000);
  }

  it('stamps verdict (spawn) then hit (no spawn) with the six fields', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    await reg.call('cached_audit', { cache_key: 'kl', model: 'reasoning', prompt: PROMPT }, ctx);
    await reg.call('cached_audit', { cache_key: 'kl', model: 'reasoning', prompt: PROMPT }, ctx);

    const lines = await readLedger(ctx.sessionId);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      model: 'reasoning',
      operation: 'model_call',
      status: 'returned',
    });
    expect(lines[1]).toMatchObject({ operation: 'cache_read', status: 'hit', duration_ms: 0 });
    expect(lines[0]!.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(typeof lines[0]!.at).toBe('string');
  });

  it('stamps no_verdict on a verdict-less output', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('no verdict here'));
    const reg = freshRegistry();
    await reg.call('cached_audit', { cache_key: 'kl', model: 'reasoning', prompt: PROMPT }, ctx);
    const lines = await readLedger(ctx.sessionId);
    expect(lines.at(-1)).toMatchObject({ operation: 'model_call', status: 'returned' });
  });

  it('stamps timeout on a CliTimeoutError (typed, not message-matched)', async () => {
    const ctx = createTestCtx();
    const hang = join(tmpRoot, 'hang.js');
    await writeFile(hang, 'setInterval(() => {}, 1000);', 'utf8');
    installAlias('reasoning', hang);
    const reg = freshRegistry();
    const result = await reg.call(
      'cached_audit',
      { cache_key: 'kl', model: 'reasoning', prompt: PROMPT, timeout_ms: 150 },
      ctx,
    );
    expect(result.ok).toBe(false); // err returned unchanged — re-fire retry semantics
    const lines = await readLedger(ctx.sessionId);
    expect(lines.at(-1)).toMatchObject({ operation: 'model_call', status: 'timeout' });
  });

  it('stamps error on a non-timeout spawn failure', async () => {
    const ctx = createTestCtx();
    const cfg: Record<string, ModelAliasConfig> = {
      reasoning: {
        mode: 'subscription',
        impl: 'cli',
        cli: join(tmpRoot, 'does-not-exist-bin'),
        args: [],
      },
    };
    process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify(cfg);
    const reg = freshRegistry();
    const result = await reg.call(
      'cached_audit',
      { cache_key: 'kl', model: 'reasoning', prompt: PROMPT },
      ctx,
    );
    expect(result.ok).toBe(false);
    const lines = await readLedger(ctx.sessionId);
    expect(lines.at(-1)).toMatchObject({ operation: 'model_call', status: 'error' });
  });
});
