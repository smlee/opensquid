/**
 * discipline_status (F5) — the inspect surface. Seeds a sandboxed session (active pack + active task + FSM state)
 * and asserts the status reflects the live on-disk state: active task, FSM state, the real gate pass/fail set,
 * and the dormant case. This is the verification surface the audit (T-v2-audit) found missing.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { disciplineStatus, formatDisciplineStatus } from './discipline_status.js';
import { persistActorState } from '../fsm_state.js';
import { writeActiveTask } from '../session_state.js';

const PRIOR_HOME = process.env.OPENSQUID_HOME;
let home: string;
let neutralCwd: string;
let prevCwd: string;
const NOW = '2026-06-27T00:00:00.000Z';

async function activate(packs: string[]): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'active.json'), JSON.stringify({ packs }), 'utf8');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-status-'));
  process.env.OPENSQUID_HOME = home;
  neutralCwd = await mkdtemp(join(tmpdir(), 'osq-status-cwd-'));
  prevCwd = process.cwd();
  process.chdir(neutralCwd);
});
afterEach(async () => {
  process.chdir(prevCwd);
  await rm(home, { recursive: true, force: true });
  await rm(neutralCwd, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = PRIOR_HOME;
});

describe('disciplineStatus', () => {
  it('reports the active task, FSM state, and the real gate set for an active pack', async () => {
    await activate(['fullstack-flow']);
    const sid = 'sess-status-active';
    await writeActiveTask(sid, { id: 'T-x', subject: 'do the thing', started_at: NOW });
    await persistActorState(sid, 'fullstack-flow', 'plan', NOW, 'T-x');

    const s = await disciplineStatus(sid);
    expect(s.dormant).toBe(false);
    expect(s.activeTask).toEqual({ id: 'T-x', subject: 'do the thing' });
    const fsf = s.packs.find((p) => p.pack === 'fullstack-flow');
    expect(fsf?.fsmState).toBe('plan');
    // the real guard set is surfaced with pass/fail booleans
    const refs = fsf?.gates.map((g) => g.ref) ?? [];
    expect(refs).toContain('scope_ready');
    expect(refs).toContain('plan_ready');
    expect(refs).toContain('code_frontend_clean');
    for (const g of fsf?.gates ?? []) expect(typeof g.pass).toBe('boolean');
  });

  it('marks the discipline DORMANT when there is no active task', async () => {
    await activate(['fullstack-flow']);
    const s = await disciplineStatus('sess-status-dormant');
    expect(s.dormant).toBe(true);
    expect(s.activeTask).toBeNull();
  });

  it('reports no v2 packs when none are active', async () => {
    await activate([]);
    const s = await disciplineStatus('sess-status-nopacks');
    expect(s.packs).toEqual([]);
  });

  it('formats a human-readable block (state + a gate glyph)', async () => {
    await activate(['fullstack-flow']);
    const sid = 'sess-status-fmt';
    await writeActiveTask(sid, { id: 'T-f', subject: 'fmt', started_at: NOW });
    await persistActorState(sid, 'fullstack-flow', 'scope', NOW, 'T-f');
    const out = formatDisciplineStatus(await disciplineStatus(sid));
    expect(out).toMatch(/FSM state: scope/);
    expect(out).toMatch(/scope_ready/);
    expect(out).toMatch(/[✅⛔]/u);
  });
});
