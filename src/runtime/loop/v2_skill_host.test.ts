/**
 * VS.1 proof — the v2 skill host makes `fullstack-flow`'s pause-guard ACTUALLY BLOCK.
 *
 * This is the e2e ≥v1 assertion for the pause gate: under the live v2 pack, a post-scope AskUserQuestion
 * is denied (exitCode 2) — the behaviour that was 100% dormant (skills never executed). At SCOPE it is
 * allowed (the interactive stage). Drives the REAL pack + real registry through `runV2SkillHost`.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRegistry } from '../bootstrap.js';
import { loadPackV2, type LoadedPackV2 } from '../../packs/loader_v2.js';
import type { FunctionRegistry } from '../../functions/registry.js';
import { sessionStateFile } from '../paths.js';
import type { Event } from '../types.js';

import { runV2SkillHost } from './v2_skill_host.js';

const HERE = fileURLToPath(import.meta.url);
const PACK_DIR = resolve(HERE, '../../../../packs/builtin/fullstack-flow');
const SID = 'v2-skill-host-sess';

let home: string;
let tasksDir: string;
let cart: LoadedPackV2;
let registry: FunctionRegistry;
const savedHome = process.env.OPENSQUID_HOME;
const savedTasks = process.env.OPENSQUID_HARNESS_TASKS_DIR;

async function setFsmState(state: string): Promise<void> {
  const f = sessionStateFile(SID, 'fsm-fullstack-flow');
  await mkdir(join(f, '..'), { recursive: true });
  await writeFile(f, JSON.stringify({ state, history: [] }), 'utf8');
}

const ask: Event = { kind: 'tool_call', tool: 'AskUserQuestion', args: {}, cwd: '/tmp' };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opensquid-vsh-home-'));
  tasksDir = await mkdtemp(join(tmpdir(), 'opensquid-vsh-tasks-'));
  process.env.OPENSQUID_HOME = home;
  process.env.OPENSQUID_HARNESS_TASKS_DIR = tasksDir;
  cart = await loadPackV2(PACK_DIR);
  registry = await buildRegistry();
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = savedHome;
  if (savedTasks === undefined) delete process.env.OPENSQUID_HARNESS_TASKS_DIR;
  else process.env.OPENSQUID_HARNESS_TASKS_DIR = savedTasks;
  await rm(home, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
});

describe('v2 skill host — pause-guard executes under fullstack-flow (T-v2-skill-host VS.1)', () => {
  it('BLOCKS a post-scope AskUserQuestion (the pause gate goes live)', async () => {
    await setFsmState('plan'); // past SCOPE → pause-guard fires
    const r = await runV2SkillHost([cart], ask, registry, SID);
    expect(r.exitCode).toBe(2);
  });

  it('ALLOWS an AskUserQuestion in the SCOPE stage (the interactive phase)', async () => {
    await setFsmState('scope');
    const r = await runV2SkillHost([cart], ask, registry, SID);
    expect(r.exitCode).toBe(0);
  });
});
