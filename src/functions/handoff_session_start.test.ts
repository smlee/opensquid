/**
 * T-AUTO-HANDOFF — handoff_session_start: tier-3 lazy generation + one-shot
 * injection (the FU.3 dead-session pointer path).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('pointer names the FRESH session itself → no-op', async () => {
    await writeFile(projectCurrentSessionPath(UUID), FRESH, 'utf8');
    const r = await HandoffSessionStart.execute({}, ctx());
    expect(r.ok && r.value === null).toBe(true);
  });
});
