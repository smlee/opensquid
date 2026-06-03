/**
 * Unit tests for the auto-start chain state machine (T-ASC, ASC.1).
 *
 * Coverage:
 *   - round-trip (transition → read → readStage)
 *   - same-stage idempotency (no double-history-entry, no extra write)
 *   - history append-only invariant across multi-step transition chains
 *   - enrichment-field accumulation across transitions
 *   - enrichment NOT applied on same-stage re-call (L4 contract)
 *   - no-throw read posture on absent / malformed / shape-invalid files
 *   - clearChainState removes the file; ENOENT swallowed on absent
 *
 * Every test isolates OPENSQUID_HOME via mkdtemp per ASG.1 / T-ASC L11.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHAIN_STAGES,
  clearChainState,
  readChainStage,
  readChainState,
  transitionChainStage,
} from './chain_state.js';
import { sessionStateFile } from './paths.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-chain-state-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('chain_state CHAIN_STAGES tuple', () => {
  it('enumerates exactly 7 stages in pipeline order', () => {
    expect(CHAIN_STAGES).toEqual([
      'idle',
      'scoping',
      'researched',
      'spec_authored',
      'tasks_loaded',
      'phases_in_flight',
      'phases_complete',
    ]);
  });
});

describe('chain_state — read defaults', () => {
  it('readChainState returns null on absent file', async () => {
    expect(await readChainState('s')).toBeNull();
  });

  it('readChainStage returns "idle" on absent file', async () => {
    expect(await readChainStage('s')).toBe('idle');
  });

  it('readChainState returns null on malformed JSON (no throw)', async () => {
    const path = sessionStateFile('s', 'chain-state');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not valid json', 'utf8');
    expect(await readChainState('s')).toBeNull();
    expect(await readChainStage('s')).toBe('idle');
  });

  it('readChainState returns null when required fields are missing', async () => {
    const path = sessionStateFile('s', 'chain-state');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ stage: 'scoping' }), 'utf8');
    expect(await readChainState('s')).toBeNull();
  });

  it('readChainState returns null when stage is not a known CHAIN_STAGES member', async () => {
    const path = sessionStateFile('s', 'chain-state');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        stage: 'nonsense',
        started_at: '2026-05-28T00:00:00.000Z',
        last_transition_at: '2026-05-28T00:00:00.000Z',
        history: [],
      }),
      'utf8',
    );
    expect(await readChainState('s')).toBeNull();
  });
});

describe('chain_state — single transition round-trip', () => {
  it('writes a new state then reads it back with one history entry', async () => {
    await transitionChainStage('s', 'scoping');
    const state = await readChainState('s');
    expect(state).not.toBeNull();
    expect(state?.stage).toBe('scoping');
    expect(state?.history).toHaveLength(1);
    expect(state?.history[0]?.stage).toBe('scoping');
    expect(state?.started_at).toBeDefined();
    expect(state?.last_transition_at).toBeDefined();
  });

  it('readChainStage returns the persisted stage after a transition', async () => {
    await transitionChainStage('s', 'researched');
    expect(await readChainStage('s')).toBe('researched');
  });
});

describe('chain_state — same-stage idempotency (L4)', () => {
  it('second transition to the same stage is a no-op (history stays at 1 entry)', async () => {
    await transitionChainStage('s', 'scoping');
    const firstReadAt = (await readChainState('s'))?.last_transition_at;
    // Force the clock to tick at least one millisecond so a NON-idempotent
    // implementation would visibly bump last_transition_at.
    await new Promise<void>((r) => setTimeout(r, 5));
    await transitionChainStage('s', 'scoping');
    const second = await readChainState('s');
    expect(second?.history).toHaveLength(1);
    expect(second?.last_transition_at).toBe(firstReadAt);
  });

  it('idempotent same-stage call does NOT update enrichment (L4 contract)', async () => {
    await transitionChainStage('s', 'researched', { pre_research_path: '/abs/p1.md' });
    await transitionChainStage('s', 'researched', { pre_research_path: '/abs/p2.md' });
    const state = await readChainState('s');
    // Same-stage second call is a no-op — the first enrichment persists.
    expect(state?.pre_research_path).toBe('/abs/p1.md');
    expect(state?.history).toHaveLength(1);
  });
});

describe('chain_state — multi-step transition chain (append-only history)', () => {
  it('three sequential distinct-stage transitions append three history entries in order', async () => {
    await transitionChainStage('s', 'scoping');
    await transitionChainStage('s', 'researched', { pre_research_path: '/abs/p.md' });
    await transitionChainStage('s', 'spec_authored', { spec_path: '/abs/T-x.md' });
    const state = await readChainState('s');
    expect(state?.stage).toBe('spec_authored');
    expect(state?.history.map((h) => h.stage)).toEqual(['scoping', 'researched', 'spec_authored']);
  });

  it('enrichment fields accumulate across transitions even when not re-supplied', async () => {
    await transitionChainStage('s', 'researched', { pre_research_path: '/abs/p.md' });
    await transitionChainStage('s', 'spec_authored', { spec_path: '/abs/T-x.md' });
    await transitionChainStage('s', 'tasks_loaded', { task_ids: ['t1', 't2'] });
    const state = await readChainState('s');
    expect(state?.pre_research_path).toBe('/abs/p.md');
    expect(state?.spec_path).toBe('/abs/T-x.md');
    expect(state?.task_ids).toEqual(['t1', 't2']);
  });
});

describe('chain_state — A4 forward-only legality', () => {
  it('allows forward transitions + forward jumps (idle → researched, skipping scoping)', async () => {
    await transitionChainStage('a4-fwd', 'researched', { pre_research_path: '/abs/p.md' });
    expect((await readChainState('a4-fwd'))?.stage).toBe('researched');
    await transitionChainStage('a4-fwd', 'spec_authored', { spec_path: '/abs/T.md' });
    expect((await readChainState('a4-fwd'))?.stage).toBe('spec_authored');
  });

  it('REJECTS a backward transition (no-op; the gate cannot be quietly rewound)', async () => {
    await transitionChainStage('a4-back', 'spec_authored', { spec_path: '/abs/T.md' });
    // researched < spec_authored in CHAIN_STAGES → illegal backward → ignored
    await transitionChainStage('a4-back', 'researched');
    expect((await readChainState('a4-back'))?.stage).toBe('spec_authored');
    // an attempt to regress to scoping from a later stage is also rejected
    await transitionChainStage('a4-back', 'scoping');
    expect((await readChainState('a4-back'))?.stage).toBe('spec_authored');
  });
});

describe('chain_state — clearChainState', () => {
  it('removes the persisted file', async () => {
    await transitionChainStage('s', 'scoping');
    expect(await readChainState('s')).not.toBeNull();
    await clearChainState('s');
    expect(await readChainState('s')).toBeNull();
  });

  it('is a no-op on absent file (ENOENT swallowed, no throw)', async () => {
    await expect(clearChainState('absent-session')).resolves.toBeUndefined();
  });
});

describe('chain_state — file shape stability', () => {
  it('persists the state as deterministic pretty-printed JSON under sessions/<id>/state/chain-state.json', async () => {
    await transitionChainStage('s', 'scoping');
    const path = sessionStateFile('s', 'chain-state');
    const raw = await readFile(path, 'utf8');
    // Pretty-printed (2-space) so a manual inspection in dev tools is readable.
    expect(raw).toMatch(/^\{\n {2}"stage": "scoping",\n/);
    // History array is present.
    const parsed = JSON.parse(raw) as { history: unknown[] };
    expect(Array.isArray(parsed.history)).toBe(true);
  });
});

// Smoke: every stage in CHAIN_STAGES is reachable from a fresh state via one
// transition. Belt-and-suspenders against an accidental enum-vs-tuple drift
// between CHAIN_STAGES and the ChainStage type.
describe('chain_state — reach every stage', () => {
  for (const stage of CHAIN_STAGES) {
    it(`transitions cleanly to '${stage}'`, async () => {
      await transitionChainStage(`sess-${stage}`, stage);
      expect(await readChainStage(`sess-${stage}`)).toBe(stage);
    });
  }
});

describe('chain_state — atomic write (FC.1)', () => {
  it('never leaves a torn/empty state file under overlapping transitions', async () => {
    const sid = 'sess-race';
    // Overlapping transitions to different real stages. With tmp+rename publish
    // a reader always sees a fully-written file holding one real stage — never
    // an empty/partial JSON (the ACTRACE failure the atomic write closes).
    await Promise.all(CHAIN_STAGES.map((s) => transitionChainStage(sid, s)));
    const parsed = JSON.parse(await readFile(sessionStateFile(sid, 'chain-state'), 'utf8')) as {
      stage: string;
    };
    expect(CHAIN_STAGES).toContain(parsed.stage as (typeof CHAIN_STAGES)[number]);
    expect(CHAIN_STAGES).toContain(await readChainStage(sid));
  });

  it('leaves no stray .tmp file behind after a transition', async () => {
    const sid = 'sess-tmp';
    await transitionChainStage(sid, 'researched');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dirname(sessionStateFile(sid, 'chain-state')));
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
  });
});
