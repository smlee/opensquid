/**
 * H7a — the `> v1` equivalence proof (e2e). Drives the REAL `runV2Cartridges` with the REAL
 * `fullstack-flow` pack active IN A TEST HARNESS, proving the v2 backend gates strictly add to v1:
 *
 *   1. post-scope AskUserQuestion (tool_call) → BLOCKED (pause-guard-tool, bound on `code`)
 *   2. post-scope stop event → BLOCKED (pause-guard-stop, bound on `code`)
 *   3. author/code tool_call → the engineering lenses SURFACE (verdict level:surface → injections)
 *   4. v1 identity: with NO v2 pack active, `runV2Cartridges` returns the ZERO decision (additive guarantee)
 *
 * Test-harness ONLY — it NEVER touches the live `.opensquid/active.json` (that flip is H7b, user-gated):
 *   - the active v2 cartridge set is controlled by mocking `bootstrap.loadActiveV2Cartridges` (the same seam
 *     `v2_supply.test.ts` uses), so no on-disk active.json is read;
 *   - `OPENSQUID_HOME` is pointed at a temp dir for the duration so every session-state write (FSM seed,
 *     persisted state) lands in the temp tree, never the real `~/.opensquid`.
 *
 * Spec: loop/docs/tasks/T-v2-backend-pack-correction.md (H7a).
 */
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPackV2, type LoadedPackV2 } from '../../packs/loader_v2.js';
import { persistActorState } from '../fsm_state.js';
import { clearActiveTask } from '../session_state.js';
import type { Event } from '../event.js';

// Mock the cartridge loader so each test controls the active v2 set (mirrors v2_supply.test.ts).
vi.mock('../bootstrap.js', () => ({
  loadActiveV2Cartridges: vi.fn(),
  buildRegistry: vi.fn(),
}));
import { loadActiveV2Cartridges, buildRegistry } from '../bootstrap.js';
import { runV2Cartridges } from './v2_supply.js';
import { FunctionRegistry } from '../../functions/registry.js';
import { registerVerdictFunctions } from '../../functions/verdict.js';
import { registerEventFunctions } from '../../functions/event.js';

const mockLoad = vi.mocked(loadActiveV2Cartridges);
const mockBuildRegistry = vi.mocked(buildRegistry);

// The REAL fullstack-flow pack dir, resolved relative to this file (src/runtime/loop/ → packs/builtin/...).
const FULLSTACK_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packs',
  'builtin',
  'fullstack-flow',
);

const NOW = '2026-06-26T00:00:00.000Z';
const PACK = 'fullstack-flow';

/** A `tool_call` event for `tool` (the SURFACED kind on the pre-tool-use path). */
const toolCall = (tool: string): Event =>
  ({ kind: 'tool_call', tool, args: {} }) as unknown as Event;

/**
 * The REAL registry the host needs: `verdict` (block/surface/warn/pass) + `tool_name` (the event family the
 * pause-guard binds via `as: tool`). These are the only — pure, zero-LLM — primitives the fullstack-flow
 * backend skills (pause-guards + the 10 lenses) call. We register them onto a real FunctionRegistry rather
 * than `await`ing the production `buildRegistry()` so the e2e does NO RAG/wedge backend I/O (the production
 * `buildRegistry` opens libsql DBs under the home dir); the spec's mocked `buildRegistry` returns exactly
 * this registry, so call sites read `await buildRegistry()` verbatim.
 */
function buildBackendRegistry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerVerdictFunctions(r);
  registerEventFunctions(r); // provides `tool_name` (+ tool_args/cwd) — the pause-guard-tool binding
  return r;
}

let homeBackup: string | undefined;
let tmpHome: string;
let fullstackPack: LoadedPackV2;

beforeAll(async () => {
  // Isolate all session-state writes (FSM seed + persisted state) to a temp home — never the real ~/.opensquid.
  homeBackup = process.env.OPENSQUID_HOME;
  tmpHome = await mkdtemp(join(tmpdir(), 'fsf-e2e-home-'));
  process.env.OPENSQUID_HOME = tmpHome;
  // Load the REAL pack ONCE (with its skills/ — the 12 dirs: 2 pause-guards + 10 lenses).
  fullstackPack = await loadPackV2(FULLSTACK_DIR);
});

afterAll(async () => {
  if (homeBackup === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = homeBackup;
  await rm(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  mockLoad.mockReset();
  mockBuildRegistry.mockReset();
  mockBuildRegistry.mockResolvedValue(buildBackendRegistry());
});

/**
 * Seed the cartridge's FSM at `code` under the SAME key the host reads. The host resolves the per-task key via
 * `readActiveTaskId(sid)`; with NO active task that returns null → the session-level key `fsm-<pack>` (taskId
 * null). So we `clearActiveTask` + `persistActorState(..., taskId=null)` to rest the actor at `code`, and the
 * host then binds `code`'s skills (the 2 pause-guards + 10 lenses) on every event.
 */
async function seedAtCode(sid: string): Promise<void> {
  await clearActiveTask(sid);
  await persistActorState(sid, PACK, 'code', NOW, null);
}

describe('fullstack-flow e2e — the > v1 equivalence proof (H7a)', () => {
  it('1. post-scope AskUserQuestion (tool_call) is BLOCKED (pause-guard-tool, bound on code)', async () => {
    const sid = 'fsf-e2e-askuserquestion';
    mockLoad.mockResolvedValue([fullstackPack]);
    await seedAtCode(sid);
    const r = await runV2Cartridges(sid, toolCall('AskUserQuestion'), NOW, await buildRegistry());
    expect(r.exitCode).toBe(2);
    expect(r.messages.some((m) => m.includes('Past SCOPE'))).toBe(true);
  });

  it('2. post-scope stop event is BLOCKED (pause-guard-stop, bound on code)', async () => {
    const sid = 'fsf-e2e-stop';
    mockLoad.mockResolvedValue([fullstackPack]);
    await seedAtCode(sid);
    const r = await runV2Cartridges(sid, { kind: 'stop' } as Event, NOW, await buildRegistry());
    expect(r.exitCode).toBe(2);
    expect(r.messages.some((m) => m.includes('Past SCOPE'))).toBe(true);
  });

  it('3. author/code surfaces the engineering lenses on a tool_call (verdict:surface → injections)', async () => {
    const sid = 'fsf-e2e-lenses';
    mockLoad.mockResolvedValue([fullstackPack]);
    await seedAtCode(sid);
    // A non-pause tool_call (Read) → the pause-guard does NOT block; the bound lenses surface their guidance.
    const r = await runV2Cartridges(sid, toolCall('Read'), NOW, await buildRegistry());
    expect(r.exitCode).toBe(0);
    expect(r.injections.length).toBeGreaterThan(0);
  });

  it('4. v1 identity: NO v2 pack active → the ZERO decision (additive guarantee)', async () => {
    mockLoad.mockResolvedValue([]); // fullstack-flow absent → v1 untouched
    const r = await runV2Cartridges(
      'fsf-e2e-v1',
      toolCall('AskUserQuestion'),
      NOW,
      await buildRegistry(),
    );
    expect(r).toEqual({ exitCode: 0, messages: [], injections: [], boundSkills: [] });
  });
});
