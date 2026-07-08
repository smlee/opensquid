/**
 * S1 (T-v2-dispatch-adapter) — the dispatcher adapter: a v2 cartridge's authored skills (T2.9 pause-guard,
 * T2.13 lenses) fire via the LIVE dispatch skill-walk when adapted into the Pack[] the hook bins dispatch over.
 *
 * Integration uses the REAL path (no mock of loadActiveV2Cartridges — it's called internally by
 * loadActivePacksForDispatch, which a module mock can't intercept): a temp OPENSQUID_HOME with
 * active.json = ["fullstack-flow"] makes the real loadActiveV2Cartridges load it from builtinRoot.
 * A `verdict:block` → exit 2; a `verdict:surface` (the lenses) → the warn buffer (stderr), NOT
 * contextInjections (dispatch.ts:32-50, defaultPolicyForLevel: block→block_tool/exit2, surface→warn/stderr).
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPackV2 } from '../packs/loader_v2.js';
import {
  buildRegistry,
  loadActivePacks,
  loadActivePacksForDispatch,
  v2PackToPack,
} from './bootstrap.js';
import type { Event } from './event.js';
import { dispatchEvent } from './hooks/dispatch.js';
import { persistActorState } from './fsm_state.js';
import { clearActiveTask } from './session_state.js';
import { Pack } from './types.js';

const FSF_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packs',
  'builtin',
  'fullstack-flow',
);
const NOW = '2026-06-26T00:00:00.000Z';
const toolCall = (tool: string): Event =>
  ({ kind: 'tool_call', tool, args: {} }) as unknown as Event;

let origHome: string | undefined;
let home: string;
let projectDir: string | undefined;
let prevCwd: string | undefined;
/**
 * Project-only pack resolution: loadActiveV2Cartridges reads the PROJECT `.opensquid/active.json`
 * (walked from cwd), not OPENSQUID_HOME. Point both a temp home (FSM/registry) and a temp project
 * with the listed packs, then chdir into the project so partitionActivePacks sees them.
 */
async function setHome(activePacks: string[]): Promise<void> {
  home = await mkdtemp(join(tmpdir(), 'osq-s1-'));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'active.json'), JSON.stringify({ packs: [] }), 'utf8');
  process.env.OPENSQUID_HOME = home;

  projectDir = await mkdtemp(join(tmpdir(), 'osq-s1-proj-'));
  const scope = join(projectDir, '.opensquid');
  await mkdir(scope, { recursive: true });
  await writeFile(join(scope, 'active.json'), JSON.stringify({ packs: activePacks }), 'utf8');
  prevCwd = process.cwd();
  process.chdir(projectDir);
}
beforeEach(() => {
  origHome = process.env.OPENSQUID_HOME;
});
afterEach(async () => {
  if (prevCwd !== undefined) {
    process.chdir(prevCwd);
    prevCwd = undefined;
  }
  if (origHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = origHome;
  if (home) await rm(home, { recursive: true, force: true });
  if (projectDir) {
    await rm(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  }
});

describe('v2PackToPack (S1 adapter)', () => {
  it('maps a LoadedPackV2 into a schema-valid Pack carrying its skills + fsm, no v1 gates', async () => {
    const loaded = await loadPackV2(FSF_DIR);
    const pack = v2PackToPack(loaded);
    expect(() => Pack.parse(pack)).not.toThrow();
    expect(pack.name).toBe('fullstack-flow');
    expect(pack.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['pause-guard', 'security']),
    );
    expect(pack.fsm).toBeDefined();
    expect(pack.guards ?? []).toEqual([]); // no v1 gates → no double-processing
  });
});

describe('loadActivePacksForDispatch (S1)', () => {
  it('is ADDITIVE — equals loadActivePacks (modulo the cwd project-context pack) when no v2 cartridge is active', async () => {
    // Hermeticity: loadActiveV2Cartridges is PROJECT-only (cwd walk). Running inside the opensquid repo
    // (whose own active.json may list fullstack-flow) would leak that in — so run from a NEUTRAL cwd with
    // no `.opensquid` ancestor. Do NOT call setHome (it chdirs into a project with .opensquid).
    const saved = process.cwd();
    const neutral = await mkdtemp(join(tmpdir(), 'osq-s1-neutral-'));
    const emptyHome = await mkdtemp(join(tmpdir(), 'osq-s1-empty-home-'));
    await writeFile(join(emptyHome, 'active.json'), JSON.stringify({ packs: [] }), 'utf8');
    const savedHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = emptyHome;
    process.chdir(neutral);
    try {
      const dispatch = (await loadActivePacksForDispatch('sess-add')).filter(
        (p) => p.name !== 'project-context',
      );
      expect(dispatch).toEqual(await loadActivePacks('sess-add'));
    } finally {
      process.chdir(saved);
      if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = savedHome;
      await rm(neutral, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('appends the adapted v2 pack (with its skills) when fullstack-flow is active', async () => {
    await setHome(['fullstack-flow']);
    const packs = await loadActivePacksForDispatch('sess-app');
    const fsf = packs.find((p) => p.name === 'fullstack-flow');
    expect(fsf, 'fullstack-flow adapted into the dispatch set').toBeDefined();
    expect(fsf!.skills.map((s) => s.name)).toContain('pause-guard');
  });
});

describe('live dispatch fires the v2 pack skills (S1 integration, real path)', () => {
  async function seedPostScope(sid: string): Promise<void> {
    await setHome(['fullstack-flow']);
    await clearActiveTask(sid); // null taskId → the shared key fsm-fullstack-flow (read_fsm_state reads it)
    await persistActorState(sid, 'fullstack-flow', 'code', NOW, null); // past `scope`
  }

  it('post-scope AskUserQuestion is BLOCKED by the pause-guard (exit 2)', async () => {
    // The pause-guard's `no-pause-past-scope` rule is automation-gated (is_automation_mode must be
    // true for the verdict to fire). Turn automation ON for this test so the block engages.
    process.env.OPENSQUID_AUTOMATION = '1';
    try {
      const sid = 'sess-disp-block';
      await seedPostScope(sid);
      const packs = await loadActivePacksForDispatch(sid);
      const r = await dispatchEvent(toolCall('AskUserQuestion'), packs, await buildRegistry(), sid);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('Past SCOPE there are no pauses');
    } finally {
      delete process.env.OPENSQUID_AUTOMATION;
    }
  });

  it('a tool_call surfaces the engineering lenses (verdict:surface → stderr)', async () => {
    const sid = 'sess-disp-lens';
    await seedPostScope(sid);
    const packs = await loadActivePacksForDispatch(sid);
    const r = await dispatchEvent(toolCall('Read'), packs, await buildRegistry(), sid);
    expect(r.exitCode).toBe(0); // a non-pause tool → not blocked
    expect(r.stderr.toLowerCase()).toContain('lens'); // the engineering lenses surfaced their guidance
  });
});
