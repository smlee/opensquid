/**
 * Unit tests for the pure plan builders (T-FIX-FIRST-RUN-SETUP A slice).
 *
 * The orchestrator-seam coverage (probe-gated supply of `projectCard`) lives
 * in chat_actions.test.ts via the prompt-mock harness; THIS file pins the
 * pure layer: builder bytes + buildPlan's iff-supplied emission.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ChannelsConfig } from '../../channels/routing.js';
import type { ChatAgentConfig } from '../../packs/schemas/chat_agent.js';
import type { ModelAlias } from '../../packs/schemas/models.js';

import {
  buildActiveJson,
  buildChannelsSeedJson,
  buildPlan,
  buildProjectCardJson,
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
