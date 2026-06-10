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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelAliasConfig } from '../models/types.js';
import type { Event } from '../runtime/types.js';
import { sessionLogFile } from '../runtime/paths.js';

import { registerCachedAuditFunction } from './cached_audit.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

let tmpRoot: string;
let tempHome: string;
let priorInline: string | undefined;
let priorHome: string | undefined;

beforeEach(async () => {
  priorInline = process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  priorHome = process.env.OPENSQUID_HOME;
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-cached-audit-'));
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cached-audit-home-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorInline === undefined) delete process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  else process.env.OPENSQUID_MODELS_CONFIG_INLINE = priorInline;
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
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
});

// T-AUDIT-SPAWN-FIX: the spawn ledger — one JSONL line per resolution, so spawn
// rate / latency / timeout share are COUNTED (wg-bc291cb0cef4 mandate item 1).
describe('cached_audit spawn ledger', () => {
  async function readLedger(sessionId: string): Promise<Record<string, unknown>[]> {
    const raw = await readFile(sessionLogFile(sessionId, 'audit-spawn-ledger'), 'utf8');
    return raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('stamps verdict (spawn) then hit (no spawn) with the six fields', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('VERDICT: GUESS_FREE'));
    const reg = freshRegistry();
    await reg.call('cached_audit', { cache_key: 'kl', model: 'reasoning', prompt: PROMPT }, ctx);
    await reg.call('cached_audit', { cache_key: 'kl', model: 'reasoning', prompt: PROMPT }, ctx);

    const lines = await readLedger(ctx.sessionId);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ cache_key: 'kl', model: 'reasoning', outcome: 'verdict' });
    expect(lines[1]).toMatchObject({ cache_key: 'kl', outcome: 'hit', duration_ms: 0 });
    expect((lines[0]!.hash8 as string).length).toBe(8);
    expect(lines[0]!.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(typeof lines[0]!.at).toBe('string');
  });

  it('stamps no_verdict on a verdict-less output', async () => {
    const ctx = createTestCtx();
    installAlias('reasoning', await writeFakeEchoCli('no verdict here'));
    const reg = freshRegistry();
    await reg.call('cached_audit', { cache_key: 'kl', model: 'reasoning', prompt: PROMPT }, ctx);
    const lines = await readLedger(ctx.sessionId);
    expect(lines.at(-1)).toMatchObject({ outcome: 'no_verdict' });
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
    expect(lines.at(-1)).toMatchObject({ outcome: 'timeout' });
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
    expect(lines.at(-1)).toMatchObject({ outcome: 'error' });
  });
});
