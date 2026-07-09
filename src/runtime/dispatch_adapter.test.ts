/**
 * S1 (T-v2-dispatch-adapter) — the dispatcher adapter: a v2 cartridge's authored skills (T2.9 pause-guard,
 * T2.13 lenses) fire via the LIVE dispatch skill-walk when adapted into the Pack[] the hook bins dispatch over.
 *
 * Injection-clean by construction (T-dispatch-adapter-correct-tests, wg-b7ab125c1876): a test injects its
 * discovery root via the OPTIONAL `cwd` arg of loadActivePacksForDispatch(sid, dir) — the real
 * loadActiveV2Cartridges resolves the active v2 SET from `resolveProjectScopeRoot(dir)`, so a temp dir carrying
 * `.opensquid/active.json = { packs }` deterministically drives discovery with NO working-directory change. FSM
 * state / active-task isolate by the UNIQUE sessionId under the run-wide temp home dir (globalSetup), so NO
 * home-env mutation is needed either. A `verdict:block` → exit 2; a `verdict:surface` (the
 * lenses) → the warn buffer (stderr), NOT contextInjections (dispatch.ts:32-50, defaultPolicyForLevel:
 * block→block_tool/exit2, surface→warn/stderr).
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

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

const tempDirs: string[] = [];
/** A hermetic PROJECT scope: a temp dir carrying `.opensquid/active.json = { packs }`, RETURNED as a path
 *  (NOT chdir'd into). The discovery-root seam (loadActivePacksForDispatch(sid, dir)) reads it by injection —
 *  resolveProjectScopeRoot(dir) finds the `.opensquid/`, so v2 discovery loads the listed pack from
 *  packs/builtin with ZERO reliance on any ambient `.opensquid/` above the real cwd. */
async function makeProjectScope(activePacks: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'osq-s1-proj-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '.opensquid'), { recursive: true });
  await writeFile(
    join(dir, '.opensquid', 'active.json'),
    JSON.stringify({ packs: activePacks }),
    'utf8',
  );
  return dir;
}
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
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
    // A neutral temp root with NO `.opensquid/` ancestor → resolveProjectScopeRoot(neutral) === null →
    // partitionActivePacks short-circuits to { v2: [] }; loadProjectContextPack(neutral) === null. So the
    // dispatch set equals loadActivePacks (after filtering the cwd project-context pack) BY CONSTRUCTION —
    // no working-directory change, no home-env write.
    const neutral = await mkdtemp(join(tmpdir(), 'osq-s1-neutral-'));
    tempDirs.push(neutral);
    const dispatch = (await loadActivePacksForDispatch('sess-add', neutral)).filter(
      (p) => p.name !== 'project-context',
    );
    expect(dispatch).toEqual(await loadActivePacks('sess-add'));
  });

  it('appends the adapted v2 pack (with its skills) when fullstack-flow is active', async () => {
    const projectDir = await makeProjectScope(['fullstack-flow']); // inject the scope root — no chdir
    const packs = await loadActivePacksForDispatch('sess-app', projectDir);
    const fsf = packs.find((p) => p.name === 'fullstack-flow');
    expect(fsf, 'fullstack-flow adapted into the dispatch set').toBeDefined();
    expect(fsf!.skills.map((s) => s.name)).toContain('pause-guard');
  });
});

describe('live dispatch fires the v2 pack skills (S1 integration, real path)', () => {
  /** Seed a hermetic post-scope state: a temp PROJECT scope listing fullstack-flow (RETURNED as a path, injected
   *  via the seam) + the session's FSM state past `scope`. FSM state is keyed by the run-wide home dir + the
   *  UNIQUE sessionId (globalSetup's temp home) → isolated by construction; no per-test home override. */
  async function seedPostScope(sid: string): Promise<string> {
    const projectDir = await makeProjectScope(['fullstack-flow']);
    await clearActiveTask(sid); // null taskId → the shared key fsm-fullstack-flow (read_fsm_state reads it)
    await persistActorState(sid, 'fullstack-flow', 'code', NOW, null); // past `scope`
    return projectDir;
  }

  it('post-scope AskUserQuestion is BLOCKED by the pause-guard (exit 2)', async () => {
    // The pause-guard's `no-pause-past-scope` rule is automation-gated (is_automation_mode must be true for
    // the verdict to fire). OPENSQUID_AUTOMATION is a FEATURE-GATE, not the discovery defect — kept with its
    // try/finally toggle (out-of-universe for the no-working-dir-change / no-home-env end-state).
    process.env.OPENSQUID_AUTOMATION = '1';
    try {
      const sid = 'sess-disp-block';
      const projectDir = await seedPostScope(sid);
      const packs = await loadActivePacksForDispatch(sid, projectDir);
      const r = await dispatchEvent(toolCall('AskUserQuestion'), packs, await buildRegistry(), sid);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('Past SCOPE there are no pauses');
    } finally {
      delete process.env.OPENSQUID_AUTOMATION;
    }
  });

  it('a tool_call surfaces the engineering lenses (verdict:surface → stderr)', async () => {
    const sid = 'sess-disp-lens';
    const projectDir = await seedPostScope(sid);
    const packs = await loadActivePacksForDispatch(sid, projectDir);
    const r = await dispatchEvent(toolCall('Read'), packs, await buildRegistry(), sid);
    expect(r.exitCode).toBe(0); // a non-pause tool → not blocked
    expect(r.stderr.toLowerCase()).toContain('lens'); // the engineering lenses surfaced their guidance
  });
});
