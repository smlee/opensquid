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
let origCwd: string | undefined; // restored in afterEach
let projectDir: string | undefined; // the hermetic temp PROJECT scope, rm'd in afterEach
/** Point OPENSQUID_HOME at a fresh temp with the given active.json (the real loadActiveV2Cartridges + the
 *  FSM-state + registry all read OPENSQUID_HOME live). loadActivePacks's realPacksPromise is module-cached
 *  at import (the globalSetup home) so it is unaffected — the v2 side is what varies. */
async function setHome(activePacks: string[]): Promise<void> {
  home = await mkdtemp(join(tmpdir(), 'osq-s1-'));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'active.json'), JSON.stringify({ packs: activePacks }), 'utf8');
  process.env.OPENSQUID_HOME = home;
}
/** Establish a hermetic PROJECT scope: a temp dir carrying `.opensquid/active.json = { packs }`, chdir'd into so
 *  v2 discovery (loadActiveV2Cartridges → resolveProjectScopeRoot(cwd) → partitionActivePacks reads
 *  <scope>/active.json) finds the listed pack deterministically from packs/builtin — with ZERO reliance on
 *  whatever ambient `.opensquid/` sits above the real cwd (locally the repo's own → passes by accident; on CI
 *  none → fullstack-flow undefined). Restored + removed in afterEach. This INVERTS the ADDITIVE test's inline
 *  neutral chdir (:78-96): that one asserts NO pack by chdir'ing to a scope-LESS cwd; this asserts a pack ACTIVE
 *  by chdir'ing to a scope that LISTS it. OPENSQUID_HOME (setHome) is left untouched — it drives the HOME-scoped
 *  FSM-state / active-task / registry, NOT the v2 active-cartridge SET (bootstrap.ts:519-531). */
async function enterProjectScope(activePacks: string[]): Promise<void> {
  origCwd = process.cwd();
  projectDir = await mkdtemp(join(tmpdir(), 'osq-s1-proj-'));
  await mkdir(join(projectDir, '.opensquid'), { recursive: true });
  await writeFile(
    join(projectDir, '.opensquid', 'active.json'),
    JSON.stringify({ packs: activePacks }),
    'utf8',
  );
  process.chdir(projectDir);
}
beforeEach(() => {
  origHome = process.env.OPENSQUID_HOME;
});
afterEach(async () => {
  if (origHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = origHome;
  if (home) await rm(home, { recursive: true, force: true });
  if (origCwd !== undefined) {
    process.chdir(origCwd);
    origCwd = undefined;
  }
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
    // Hermeticity: loadActivePacksForDispatch resolves a v2 cartridge set from BOTH OPENSQUID_HOME and the
    // PROJECT scope walked up from process.cwd(). Running inside the opensquid repo (whose own active.json may
    // list a v2 pack like fullstack-flow) would leak that in — so run from a NEUTRAL cwd with no `.opensquid`
    // ancestor to genuinely assert "no v2 cartridge active".
    const prevCwd = process.cwd();
    const neutral = await mkdtemp(join(tmpdir(), 'osq-s1-neutral-'));
    process.chdir(neutral);
    try {
      await setHome([]);
      const dispatch = (await loadActivePacksForDispatch('sess-add')).filter(
        (p) => p.name !== 'project-context',
      );
      expect(dispatch).toEqual(await loadActivePacks('sess-add'));
    } finally {
      process.chdir(prevCwd);
      await rm(neutral, { recursive: true, force: true });
    }
  });

  it('appends the adapted v2 pack (with its skills) when fullstack-flow is active', async () => {
    await setHome(['fullstack-flow']);
    await enterProjectScope(['fullstack-flow']); // temp PROJECT scope so v2 discovery finds fullstack-flow
    const packs = await loadActivePacksForDispatch('sess-app');
    const fsf = packs.find((p) => p.name === 'fullstack-flow');
    expect(fsf, 'fullstack-flow adapted into the dispatch set').toBeDefined();
    expect(fsf!.skills.map((s) => s.name)).toContain('pause-guard');
  });
});

describe('live dispatch fires the v2 pack skills (S1 integration, real path)', () => {
  async function seedPostScope(sid: string): Promise<void> {
    await setHome(['fullstack-flow']);
    await enterProjectScope(['fullstack-flow']); // temp PROJECT scope so loadActivePacksForDispatch finds the pack
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
