/**
 * Unit tests for the pure plan builders (T-FIX-FIRST-RUN-SETUP A slice).
 *
 * The orchestrator-seam coverage (probe-gated supply of `projectCard`) lives
 * in chat_actions.test.ts via the prompt-mock harness; THIS file pins the
 * pure layer: builder bytes + buildPlan's iff-supplied emission.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChatAgentConfig } from '../../packs/schemas/chat_agent.js';
import type { ModelAlias } from '../../packs/schemas/models.js';

import { buildPlan, buildProjectCardJson, type PlanInput } from './chat_actions_writers.js';

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
