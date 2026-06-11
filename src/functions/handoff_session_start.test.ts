/**
 * T-AUTO-HANDOFF — handoff_session_start: tier-3 lazy generation + one-shot
 * injection (the FU.3 dead-session pointer path).
 */

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Event } from '../runtime/types.js';
import { projectCurrentSessionPath, sessionStateFile } from '../runtime/paths.js';

import { HandoffSessionStart } from './handoff_session_start.js';
import type { EvalCtx } from './registry.js';

let home: string;
let cwd: string;
let priorHome: string | undefined;
const DEAD = 'dead-session-id-00000001';
const FRESH = 'fresh-session-id-0000001';
const UUID = '00000000-0000-0000-0000-00000000aaaa';

function ctx(): EvalCtx {
  const event: Event = { kind: 'session_start', source: 'startup', cwd };
  return { event, bindings: new Map(), sessionId: FRESH, packId: 'test' };
}

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-hss-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'opensquid-hss-cwd-'));
  process.env.OPENSQUID_HOME = home;
  // Project card → resolveProjectUuid resolves; FU.3 pointer → dead session.
  await mkdir(join(cwd, '.opensquid'), { recursive: true });
  await writeFile(
    join(cwd, '.opensquid', 'project.json'),
    JSON.stringify({ version: 1, id: 'p', uuid: UUID }),
    'utf8',
  );
  const ptr = projectCurrentSessionPath(UUID);
  await mkdir(join(ptr, '..'), { recursive: true });
  await writeFile(ptr, DEAD, 'utf8');
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe('handoff_session_start (tier 3)', () => {
  it('dead session with FSM state + no doc → GENERATES from disk, injects, stamps', async () => {
    const stateDir = join(home, 'sessions', DEAD, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      sessionStateFile(DEAD, 'fsm-coding-flow'),
      JSON.stringify({ state: 'researched', history: [{ state: 'researched', at: 't' }] }),
      'utf8',
    );

    const r = await HandoffSessionStart.execute({}, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toBeNull();
    expect(r.value?.kind).toBe('inject_context');
    expect(r.value?.content).toContain('AUTO-HANDOFF');
    // The doc was generated from the dead session's disk state.
    const injected = r.value?.content ?? '';
    const m = /([/].*handover-.*-auto\.md)/.exec(injected);
    expect(m).not.toBeNull();
    const doc = await readFile(m![1]!, 'utf8');
    expect(doc).toContain('researched');
    // Stamp prevents a second injection.
    const again = await HandoffSessionStart.execute({}, ctx());
    expect(again.ok && again.value === null).toBe(true);
  });

  it('no dead-session FSM state → stamps and injects nothing (no fabricated handoff)', async () => {
    const r = await HandoffSessionStart.execute({}, ctx());
    expect(r.ok && r.value === null).toBe(true);
  });

  it('dead session at BARE scoping (no task, no artifact) → no generation (AHO.4 junk class)', async () => {
    const stateDir = join(home, 'sessions', DEAD, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      sessionStateFile(DEAD, 'fsm-coding-flow'),
      JSON.stringify({ state: 'scoping', history: [{ state: 'scoping', at: 't' }] }),
      'utf8',
    );
    const r = await HandoffSessionStart.execute({}, ctx());
    expect(r.ok && r.value === null).toBe(true);
  });

  it('pointer names the FRESH session itself → no-op', async () => {
    await writeFile(projectCurrentSessionPath(UUID), FRESH, 'utf8');
    const r = await HandoffSessionStart.execute({}, ctx());
    expect(r.ok && r.value === null).toBe(true);
  });

  // SUB.3 + FXK.2 (0.5.403) — liveness gates GENERATION only, 10-min window.
  async function seedDeadFsm(): Promise<void> {
    const stateDir = join(home, 'sessions', DEAD, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      sessionStateFile(DEAD, 'fsm-coding-flow'),
      JSON.stringify({ state: 'researched', history: [{ state: 'researched', at: 't' }] }),
      'utf8',
    );
  }

  it('FXK.2: missing doc + fresh ledger → no generation, NO stamp (stampless skip)', async () => {
    await seedDeadFsm();
    // The liveness probe's signal: a tool-ledger written "just now".
    await writeFile(sessionStateFile(DEAD, 'tool-ledger'), '{"turn":[],"session":[]}', 'utf8');

    const r = await HandoffSessionStart.execute({}, ctx());
    expect(r.ok && r.value === null).toBe(true);
    // Stampless: a later session retries after the window lapses instead of
    // being pinned by the once-per-session stamp.
    expect(existsSync(sessionStateFile(FRESH, 'handoff-read'))).toBe(false);
  });

  it('FXK.2: QUICK GRACEFUL RESTART — current doc + fresh ledger → INJECTS + stamps (the regained case)', async () => {
    await seedDeadFsm();
    // First, generate the doc via the genuinely-dead path (backdated ledger)...
    const ledger = sessionStateFile(DEAD, 'tool-ledger');
    await writeFile(ledger, '{"turn":[],"session":[]}', 'utf8');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(ledger, old, old);
    const first = await HandoffSessionStart.execute({}, ctx());
    expect(first.ok && first.value?.kind === 'inject_context').toBe(true);
    // ...then simulate the quick restart: ledger fresh again, doc CURRENT
    // (docM >= fsmM), and a NEW fresh session (no stamp for it yet).
    await writeFile(ledger, '{"turn":[],"session":[]}', 'utf8');
    const ctx2 = ctx();
    (ctx2 as { sessionId: string }).sessionId = 'fresh-session-id-0000002';
    const r = await HandoffSessionStart.execute({}, ctx2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value?.kind).toBe('inject_context'); // was: suppressed for 30min
    expect(existsSync(sessionStateFile('fresh-session-id-0000002', 'handoff-read'))).toBe(true);
  });

  it('FXK.2: missing doc + ledger older than 10min (younger than 30) → GENERATES (the window change)', async () => {
    await seedDeadFsm();
    const ledger = sessionStateFile(DEAD, 'tool-ledger');
    await writeFile(ledger, '{"turn":[],"session":[]}', 'utf8');
    const old = new Date(Date.now() - 15 * 60 * 1000); // 15min: dead under 10min-window, live under 30
    await utimes(ledger, old, old);

    const r = await HandoffSessionStart.execute({}, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value?.kind).toBe('inject_context');
    expect(existsSync(sessionStateFile(FRESH, 'handoff-read'))).toBe(true);
  });

  it('FXK.2: STALE doc + fresh ledger → no regeneration, no injection, no stamp (live protection)', async () => {
    await seedDeadFsm();
    const ledger = sessionStateFile(DEAD, 'tool-ledger');
    // Generate a doc, then advance the FSM AFTER it (doc becomes stale)...
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await writeFile(ledger, '{"turn":[],"session":[]}', 'utf8');
    await utimes(ledger, old, old);
    const first = await HandoffSessionStart.execute({}, ctx());
    expect(first.ok && first.value?.kind === 'inject_context').toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    await writeFile(
      sessionStateFile(DEAD, 'fsm-coding-flow'),
      JSON.stringify({ state: 'spec_complete', history: [{ state: 'spec_complete', at: 't2' }] }),
      'utf8',
    );
    // ...and make the session look LIVE again.
    await writeFile(ledger, '{"turn":[],"session":[]}', 'utf8');
    const ctx2 = ctx();
    (ctx2 as { sessionId: string }).sessionId = 'fresh-session-id-0000003';
    const r = await HandoffSessionStart.execute({}, ctx2);
    expect(r.ok && r.value === null).toBe(true);
    expect(existsSync(sessionStateFile('fresh-session-id-0000003', 'handoff-read'))).toBe(false);
  });
});
