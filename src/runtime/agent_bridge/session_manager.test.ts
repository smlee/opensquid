/**
 * agent_bridge — SessionManager unit tests (WAB.3, 0.5.95).
 *
 * Fixtures aligned with WAB.3 spec test plan:
 *   - getOrCreate twice for same key → returns same instance (cache hit)
 *   - 129 distinct keys → 1st evicted (LRU cap honored)
 *   - idle TTL elapsed → entry evicted, dispose fires with reason 'idle'
 *   - appendTurn after eviction → no-op (no crash)
 *   - appendTurn rolls back state mutation on persistence failure
 *   - shutdown emits onEvict('shutdown') for each live session
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionPersistence } from './session_persistence.js';
import {
  AGENT_CACHE_IDLE_TTL_MS,
  AGENT_CACHE_MAX_SIZE,
  type EvictionReason,
  SessionManager,
} from './session_manager.js';
import type { ChatHistoryEntry, SessionKey, SessionState } from './types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'wab3-sm-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makePersistence(): SessionPersistence {
  return new SessionPersistence({ root: tmpRoot });
}

function keyFor(n: number): SessionKey {
  return { platform: 'telegram', chatId: String(n) };
}

function userEntry(text: string): ChatHistoryEntry {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
  };
}

describe('SessionManager constants', () => {
  it('matches Hermes-derived caps', () => {
    // Hermes gateway/run.py:55-65 — verified during WAB.3 pre-research.
    expect(AGENT_CACHE_MAX_SIZE).toBe(128);
    expect(AGENT_CACHE_IDLE_TTL_MS).toBe(3_600_000);
  });
});

describe('SessionManager.getOrCreate', () => {
  it('returns the same instance for repeat lookups of the same key', async () => {
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
    });
    const a = await sm.getOrCreate(keyFor(1), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    const b = await sm.getOrCreate(keyFor(1), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    expect(a).toBe(b);
    sm.shutdown();
  });

  it('hydrates history from persisted JSONL', async () => {
    const persistence = makePersistence();
    const sm = new SessionManager({
      persistence,
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
    });
    const key = keyFor(2);
    // Pre-seed persisted history by writing then evicting.
    const seeded = await sm.getOrCreate(key, '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    seeded.turnInFlight = false;
    await sm.appendTurn(key, [userEntry('persisted-message')]);
    sm.shutdown();

    const sm2 = new SessionManager({
      persistence,
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
    });
    const rehydrated = await sm2.getOrCreate(key, '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    expect(rehydrated.history).toHaveLength(1);
    const firstBlock = rehydrated.history[0]?.content[0];
    expect((firstBlock as { text: string }).text).toBe('persisted-message');
    sm2.shutdown();
  });

  it('stamps defaultPackId + defaultModelAlias on new sessions', async () => {
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'pack-xyz',
      defaultModelAlias: 'claude-haiku-4-5',
    });
    const s = await sm.getOrCreate(keyFor(3), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    expect(s.packId).toBe('pack-xyz');
    expect(s.modelAlias).toBe('claude-haiku-4-5');
    sm.shutdown();
  });
});

describe('SessionManager LRU cap', () => {
  it('evicts the least-recently-used session beyond the cap', async () => {
    const evictions: { slug: string; reason: EvictionReason }[] = [];
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
      maxSessions: 4, // smaller cap for fast test; same eviction logic
      onEvict: (state, reason) =>
        evictions.push({ slug: `${state.key.platform}:${state.key.chatId}`, reason }),
    });
    // Insert 4 sessions — none evicted yet.
    for (let i = 0; i < 4; i++) {
      await sm.getOrCreate(keyFor(i), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    }
    expect(evictions).toHaveLength(0);
    // 5th insert pushes session 0 out (LRU).
    await sm.getOrCreate(keyFor(4), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toEqual({ slug: 'telegram:0', reason: 'lru' });
    sm.shutdown();
  });
});

describe('SessionManager idle TTL eviction', () => {
  it('evicts entries past the idle TTL with reason=idle', async () => {
    // Real timers + short TTL: lru-cache's `ttlAutopurge` schedules a real
    // setTimeout internally; fake-timer interaction with lru-cache's
    // performance.now() polling is brittle, so we use a 50ms TTL + a 120ms
    // real wait. The test still finishes well under 1s.
    const evictions: { reason: EvictionReason }[] = [];
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
      idleTtlMs: 50,
      onEvict: (_state, reason) => evictions.push({ reason }),
    });
    await sm.getOrCreate(keyFor(1), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(evictions).toHaveLength(1);
    expect(evictions[0]?.reason).toBe('idle');
    sm.shutdown();
  });
});

describe('SessionManager.appendTurn', () => {
  it('no-ops cleanly when the session has been evicted between turn start and completion', async () => {
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
      maxSessions: 1,
    });
    const k1 = keyFor(1);
    const k2 = keyFor(2);
    await sm.getOrCreate(k1, '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    // Insert k2 — evicts k1.
    await sm.getOrCreate(k2, '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    // appendTurn against evicted k1 must NOT throw.
    await expect(sm.appendTurn(k1, [userEntry('lost')])).resolves.toBeUndefined();
    sm.shutdown();
  });

  it('persists THEN mutates state — failed persistence leaves history untouched', async () => {
    // Spy persistence: appendEntries always throws; loadHistory returns [].
    const persistence = {
      loadHistory: vi.fn().mockResolvedValue([]),
      appendEntries: vi.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as SessionPersistence;
    const sm = new SessionManager({
      persistence,
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
    });
    const k = keyFor(1);
    const state = await sm.getOrCreate(k, '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    state.turnInFlight = true;
    await expect(sm.appendTurn(k, [userEntry('x')])).rejects.toThrow(/disk full/);
    const after = sm.peek(k);
    // History stayed empty (no rollback needed because state was never
    // mutated); turnInFlight unchanged so the caller can decide to retry.
    expect(after?.history).toEqual([]);
    expect(after?.turnInFlight).toBe(true);
    sm.shutdown();
  });

  it('clears turnInFlight after a successful append', async () => {
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
    });
    const k = keyFor(1);
    const state = await sm.getOrCreate(k, '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    state.turnInFlight = true;
    await sm.appendTurn(k, [userEntry('done')]);
    expect(sm.peek(k)?.turnInFlight).toBe(false);
    expect(sm.peek(k)?.history).toHaveLength(1);
    sm.shutdown();
  });
});

describe('SessionManager.beginTurn', () => {
  it('marks the session as turn-in-flight without crashing on unknown key', async () => {
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
    });
    const k = keyFor(1);
    await sm.getOrCreate(k, '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    sm.beginTurn(k);
    expect(sm.peek(k)?.turnInFlight).toBe(true);
    // Unknown key path is a silent no-op.
    sm.beginTurn(keyFor(999));
    sm.shutdown();
  });
});

describe('SessionManager.shutdown', () => {
  it('emits onEvict("shutdown") for each remaining session, then clears', async () => {
    const seen: { chatId: string; reason: EvictionReason }[] = [];
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
      onEvict: (state: SessionState, reason) => seen.push({ chatId: state.key.chatId, reason }),
    });
    await sm.getOrCreate(keyFor(1), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    await sm.getOrCreate(keyFor(2), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    sm.shutdown();
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.reason === 'shutdown')).toBe(true);
    expect(sm.size).toBe(0);
  });

  it('is idempotent', async () => {
    const sm = new SessionManager({
      persistence: makePersistence(),
      defaultPackId: 'default',
      defaultModelAlias: 'fast_chat',
    });
    await sm.getOrCreate(keyFor(1), '0742f358-c0fd-4690-ae9d-da8f4102ab4a');
    sm.shutdown();
    expect(() => sm.shutdown()).not.toThrow();
  });
});
