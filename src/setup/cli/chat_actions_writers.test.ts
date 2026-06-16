/**
 * Unit tests for the pure plan builders (T-FIX-FIRST-RUN-SETUP A slice).
 *
 * The orchestrator-seam coverage (probe-gated supply of `projectCard`) lives
 * in chat_actions.test.ts via the prompt-mock harness; THIS file pins the
 * pure layer: builder bytes + buildPlan's iff-supplied emission.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelsConfig } from '../../channels/routing.js';
import type { ChatAgentConfig } from '../../packs/schemas/chat_agent.js';
import type { ModelAlias } from '../../packs/schemas/models.js';

import {
  buildActiveJson,
  buildChannelsSeedJson,
  buildPlan,
  buildProjectCardJson,
  readActivePackNames,
  removeFromActiveJson,
  type PlanInput,
} from './chat_actions_writers.js';

const fastChatAlias: ModelAlias = {
  description: '',
  mode: 'api',
  model: 'claude-haiku-4-5-20251001',
  args: [],
};

const chatAgent: ChatAgentConfig = {
  default_model: 'fast_chat',
  skills: [],
  disable_builtins: [],
  max_tool_iterations: 8,
  max_tokens: 1024,
};

const baseInput: PlanInput = {
  homeDir: '/tmp/frs-a-home',
  envPath: '/tmp/frs-a-home/.env',
  modelsState: {
    present: false,
    path: '/tmp/frs-a-home/models.yaml',
    aliases: [],
    hasFastChat: false,
  },
  fastChatAlias,
  apiKey: null,
  storeKey: false,
  packId: 'starter',
  packRoot: '/tmp/frs-a-home/packs/starter',
  chatAgent,
  createPackManifest: false,
};

describe('buildProjectCardJson', () => {
  it('is deterministic and byte-exact (pure — uuid is an input)', () => {
    expect(buildProjectCardJson('my-proj', 'u-u-i-d')).toBe(
      '{\n  "version": 1,\n  "id": "my-proj",\n  "uuid": "u-u-i-d"\n}\n',
    );
  });
});

describe('buildPlan — projectCard emission', () => {
  it('emits the card action iff projectCard is supplied', () => {
    const withCard = buildPlan({
      ...baseInput,
      projectCard: { path: join('/x', '.opensquid', 'project.json'), id: 'x', uuid: 'u' },
    });
    const cardActions = withCard.actions.filter((a) => a.path.endsWith('project.json'));
    expect(cardActions).toHaveLength(1);
    expect(cardActions[0]?.kind).toBe('create_or_replace');
    expect(buildPlan(baseInput).actions.some((a) => a.path.endsWith('project.json'))).toBe(false);
  });
});

describe('buildActiveJson (FRS.B — the one merge owner)', () => {
  it('fresh: serializes a single-pack list', () => {
    expect(buildActiveJson([], 'coding-flow')).toBe('{\n  "packs": [\n    "coding-flow"\n  ]\n}\n');
  });
  it('merge preserves existing entries', () => {
    const parsed = JSON.parse(buildActiveJson(['a', 'b'], 'c')) as { packs: string[] };
    expect(parsed.packs).toEqual(['a', 'b', 'c']);
  });
  it('dedupes on re-activation (stable content)', () => {
    expect(buildActiveJson(['coding-flow'], 'coding-flow')).toBe(
      buildActiveJson([], 'coding-flow'),
    );
  });
});

describe('buildPlan — activatePack emission (FRS.B)', () => {
  it('emits the active.json action iff activatePack is supplied', () => {
    const withIt = buildPlan({
      ...baseInput,
      activatePack: { path: '/h/active.json', existing: ['x'], packId: 'y' },
    });
    const acts = withIt.actions.filter((a) => a.path.endsWith('active.json'));
    expect(acts).toHaveLength(1);
    expect(acts[0]?.kind).toBe('create_or_replace');
    expect(buildPlan(baseInput).actions.some((a) => a.path.endsWith('active.json'))).toBe(false);
  });
});

describe('buildChannelsSeedJson (FRS.C)', () => {
  it('emits a schema-valid v1 config the real loader accepts', () => {
    const parsed = ChannelsConfig.safeParse(JSON.parse(buildChannelsSeedJson('loop', '/x/loop')));
    expect(parsed.success).toBe(true);
  });
  it('reserved "general" id is schema-rejected; the -project suffix passes (the guard exists for a reason)', () => {
    expect(
      ChannelsConfig.safeParse(JSON.parse(buildChannelsSeedJson('general', '/x'))).success,
    ).toBe(false);
    expect(
      ChannelsConfig.safeParse(JSON.parse(buildChannelsSeedJson('general-project', '/x'))).success,
    ).toBe(true);
  });
});

describe('buildPlan — channelsSeed emission (FRS.C)', () => {
  it('emits the channels.json action iff channelsSeed is supplied', () => {
    const withIt = buildPlan({
      ...baseInput,
      channelsSeed: { path: '/h/channels.json', umbrellaId: 'p', memberPath: '/x/p' },
    });
    expect(withIt.actions.filter((a) => a.path.endsWith('channels.json'))).toHaveLength(1);
    expect(buildPlan(baseInput).actions.some((a) => a.path.endsWith('channels.json'))).toBe(false);
  });
});

describe('removeFromActiveJson (PT.1 — reciprocal of buildActiveJson)', () => {
  it('removes the named pack, preserving the rest in order', () => {
    expect(JSON.parse(removeFromActiveJson(['a', 'b', 'c'], 'b')) as { packs: string[] }).toEqual({
      packs: ['a', 'c'],
    });
  });
  it('is a no-op (minus nothing) when the name is absent', () => {
    expect(removeFromActiveJson(['a', 'b'], 'z')).toBe(buildActiveJsonList(['a', 'b']));
  });
  it('round-trips with buildActiveJson (add then remove → original set)', () => {
    const added = JSON.parse(buildActiveJson(['a'], 'b')) as { packs: string[] };
    expect(JSON.parse(removeFromActiveJson(added.packs, 'b')) as { packs: string[] }).toEqual({
      packs: ['a'],
    });
  });
});

// local helper mirroring removeFromActiveJson's serializer for the no-op assertion.
function buildActiveJsonList(packs: string[]): string {
  return `${JSON.stringify({ packs }, null, 2)}\n`;
}

describe('readActivePackNames (PT.1 — tolerant scope read)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-active-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] when active.json is absent (ENOENT)', async () => {
    await expect(readActivePackNames(dir)).resolves.toEqual([]);
  });
  it('returns the pack names from a valid file', async () => {
    await writeFile(join(dir, 'active.json'), JSON.stringify({ packs: ['x', 'y'] }));
    await expect(readActivePackNames(dir)).resolves.toEqual(['x', 'y']);
  });
  it('returns [] when packs is missing / not an array', async () => {
    await writeFile(join(dir, 'active.json'), JSON.stringify({ notPacks: 1 }));
    await expect(readActivePackNames(dir)).resolves.toEqual([]);
  });
  it('THROWS (no silent []) on a garbled JSON file, citing the path', async () => {
    await writeFile(join(dir, 'active.json'), '{ this is not json');
    await expect(readActivePackNames(dir)).rejects.toThrow(/active\.json/);
  });
  it('creates a fresh scope dir on demand (mkdir parent then read)', async () => {
    const nested = join(dir, 'sub', '.opensquid');
    await mkdir(nested, { recursive: true });
    await expect(readActivePackNames(nested)).resolves.toEqual([]);
  });
});
