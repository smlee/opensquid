/**
 * agent_bridge — pack_binding unit tests (WAB.6 + WAB-SUB.2 mode dispatch).
 *
 * Coverage matches spec §"Test fixtures":
 *   - pack with chat_agent.yaml + api alias → api runner + resolved model
 *     + tunables propagated, three built-ins by default
 *   - pack with chat_agent.yaml + subscription alias → subscription runner
 *     carrying cli + args; both modes are first-class (WAB-SUB.2)
 *   - pack with disable_builtins: ['recall'] → recall absent
 *   - pack with custom system_prompt path → prompt loaded from file
 *   - pack WITHOUT chat_agent.yaml → fallback defaults apply, alias
 *     resolved from `fast_chat` (when present) or throws on missing alias
 *   - alias missing from models.yaml → throws with "setup chat" hint
 *   - alias declared as api mode but model field missing → throws
 *   - alias declared as subscription mode but cli field missing → throws
 *   - alias declared as local/mcp mode → throws "mode not yet implemented"
 *   - opt-in skill name unknown → warn invoked, dispatcher still built
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelAliasConfig } from '../../models/types.js';
import type { RagBackend } from '../../rag/types.js';
import type { Pack } from '../../runtime/types.js';
import type { SecretResolver } from '../../secrets/types.js';

import { buildChatToolDispatcher } from './pack_binding.js';
import { SimpleToolDispatcher } from './tool_dispatcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyBackend(): RagBackend {
  return {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: () => Promise.resolve(),
    deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
  };
}

function basePack(overrides: Partial<Pack> = {}): Pack {
  const base: Pack = {
    name: 'test-pack',
    version: '0.1.0',
    scope: 'project',
    goal: 'WAB.6 binding test',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [],
  };
  return { ...base, ...overrides };
}

function apiAlias(model: string): ModelAliasConfig {
  return { mode: 'api', provider: 'anthropic', model, args: [] };
}

/** Test SecretResolver — returns a fake API key for any env: ANTHROPIC_API_KEY ref. */
function fakeSecrets(): SecretResolver {
  return {
    resolve: () => Promise.resolve('sk-test-fake-key'),
  };
}

const HAIKU = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildChatToolDispatcher', () => {
  let packRoot: string;

  beforeEach(async () => {
    packRoot = await mkdtemp(join(tmpdir(), 'opensquid-pack-binding-'));
  });
  afterEach(async () => {
    await rm(packRoot, { recursive: true, force: true });
  });

  it('returns dispatcher + api runner + tunables for a pack with chat_agent.yaml (api mode)', async () => {
    const pack = basePack({
      chatAgent: {
        default_model: 'fast_chat',
        skills: [],
        disable_builtins: [],
        max_tool_iterations: 12,
        max_tokens: 2048,
      },
    });
    const result = await buildChatToolDispatcher({
      pack,
      packRoot,
      modelsConfig: { fast_chat: apiAlias(HAIKU) },
      ragBackend: emptyBackend(),
      secrets: fakeSecrets(),
    });

    expect(result.resolvedModel).toBe(HAIKU);
    expect(result.runner).toEqual({ mode: 'api', model: HAIKU });
    expect(result.tunables).toEqual({ maxToolIterations: 12, maxTokens: 2048 });
    expect(result.dispatcher.list().map((s) => s.name)).toEqual([
      'chat_send',
      'recall',
      'store_lesson',
    ]);
    expect(result.systemPrompt).toMatch(/chat-agent embedded/);
  });

  it('returns subscription runner when alias is mode=subscription + impl=cli', async () => {
    const pack = basePack({
      chatAgent: {
        default_model: 'subby',
        skills: [],
        disable_builtins: [],
        max_tool_iterations: 8,
        max_tokens: 1024,
      },
    });
    const result = await buildChatToolDispatcher({
      pack,
      packRoot,
      modelsConfig: {
        subby: {
          mode: 'subscription',
          impl: 'cli',
          cli: 'claude',
          args: ['--print', '--model', 'sonnet'],
        },
      },
      ragBackend: emptyBackend(),
    });

    expect(result.runner).toEqual({
      mode: 'subscription',
      cli: 'claude',
      args: ['--print', '--model', 'sonnet'],
    });
    // resolvedModel is the human-readable label (cli name in subscription mode).
    expect(result.resolvedModel).toBe('claude');
    // Built-in tools still attached — subscription mode wires the same
    // dispatcher; claude reaches them via the MCP config injected at
    // daemon-start time (see daemon.test).
    expect(result.dispatcher.list().length).toBe(3);
  });

  it('defaults subscription args to [] when models.yaml omits it', async () => {
    const pack = basePack({
      chatAgent: {
        default_model: 'subby',
        skills: [],
        disable_builtins: [],
        max_tool_iterations: 8,
        max_tokens: 1024,
      },
    });
    const result = await buildChatToolDispatcher({
      pack,
      packRoot,
      modelsConfig: {
        subby: { mode: 'subscription', impl: 'cli', cli: 'claude' },
      },
      ragBackend: emptyBackend(),
    });
    expect(result.runner).toMatchObject({ mode: 'subscription', cli: 'claude', args: [] });
  });

  it('filters built-ins via disable_builtins', async () => {
    const pack = basePack({
      chatAgent: {
        default_model: 'fast_chat',
        skills: [],
        disable_builtins: ['recall'],
        max_tool_iterations: 8,
        max_tokens: 1024,
      },
    });
    const { dispatcher } = await buildChatToolDispatcher({
      pack,
      packRoot,
      modelsConfig: { fast_chat: apiAlias(HAIKU) },
      ragBackend: emptyBackend(),
      secrets: fakeSecrets(),
    });
    expect(dispatcher.list().map((s) => s.name)).toEqual(['chat_send', 'store_lesson']);
  });

  it('loads a pack-relative system_prompt file when declared', async () => {
    await writeFile(join(packRoot, 'prompt.md'), 'You are a tester.\n', 'utf8');
    const pack = basePack({
      chatAgent: {
        default_model: 'fast_chat',
        system_prompt: 'prompt.md',
        skills: [],
        disable_builtins: [],
        max_tool_iterations: 8,
        max_tokens: 1024,
      },
    });
    const { systemPrompt } = await buildChatToolDispatcher({
      pack,
      packRoot,
      modelsConfig: { fast_chat: apiAlias(HAIKU) },
      ragBackend: emptyBackend(),
      secrets: fakeSecrets(),
    });
    expect(systemPrompt).toBe('You are a tester.');
  });

  it('falls back to defaults when pack ships no chat_agent.yaml (chatAgent undefined)', async () => {
    const pack = basePack();
    const result = await buildChatToolDispatcher({
      pack,
      packRoot,
      modelsConfig: { fast_chat: apiAlias(HAIKU) },
      ragBackend: emptyBackend(),
      secrets: fakeSecrets(),
    });
    expect(result.resolvedModel).toBe(HAIKU);
    expect(result.tunables.maxToolIterations).toBe(8);
    expect(result.tunables.maxTokens).toBe(1024);
    expect(result.dispatcher.list().length).toBe(3);
  });

  it('throws with "setup chat" hint when alias missing from models.yaml', async () => {
    const pack = basePack();
    await expect(
      buildChatToolDispatcher({
        pack,
        packRoot,
        modelsConfig: {},
        ragBackend: emptyBackend(),
      }),
    ).rejects.toThrow(/alias 'fast_chat' which is not declared.*opensquid setup chat/s);
  });

  it('throws when alias is subscription mode but cli field missing', async () => {
    const pack = basePack({
      chatAgent: {
        default_model: 'subby',
        skills: [],
        disable_builtins: [],
        max_tool_iterations: 8,
        max_tokens: 1024,
      },
    });
    await expect(
      buildChatToolDispatcher({
        pack,
        packRoot,
        modelsConfig: { subby: { mode: 'subscription', impl: 'cli', args: [] } },
        ragBackend: emptyBackend(),
      }),
    ).rejects.toThrow(/mode=subscription.*`cli` field is missing/s);
  });

  it('throws when alias is api mode but model field missing', async () => {
    const pack = basePack();
    await expect(
      buildChatToolDispatcher({
        pack,
        packRoot,
        modelsConfig: { fast_chat: { mode: 'api', provider: 'anthropic', args: [] } },
        ragBackend: emptyBackend(),
      }),
    ).rejects.toThrow(/`model` field is missing/);
  });

  it('throws when alias mode is not yet implemented (local)', async () => {
    const pack = basePack({
      chatAgent: {
        default_model: 'localy',
        skills: [],
        disable_builtins: [],
        max_tool_iterations: 8,
        max_tokens: 1024,
      },
    });
    await expect(
      buildChatToolDispatcher({
        pack,
        packRoot,
        modelsConfig: { localy: { mode: 'local', endpoint: 'http://x' } },
        ragBackend: emptyBackend(),
      }),
    ).rejects.toThrow(/mode='local'.*not yet implemented.*opensquid setup chat/s);
  });

  it('warns and skips unknown opt-in skill names but still returns the dispatcher', async () => {
    const onWarn = vi.fn();
    const pack = basePack({
      chatAgent: {
        default_model: 'fast_chat',
        skills: ['subagent_call', 'mystery_skill'],
        disable_builtins: [],
        max_tool_iterations: 8,
        max_tokens: 1024,
      },
    });
    const { dispatcher } = await buildChatToolDispatcher({
      pack,
      packRoot,
      modelsConfig: { fast_chat: apiAlias(HAIKU) },
      ragBackend: emptyBackend(),
      onWarn,
      secrets: fakeSecrets(),
    });
    expect(dispatcher).toBeInstanceOf(SimpleToolDispatcher);
    expect(dispatcher.list().length).toBe(3); // built-ins still present
    expect(onWarn).toHaveBeenCalledTimes(2);
    expect(onWarn.mock.calls[0]?.[0]).toMatch(/unknown opt-in skill name 'subagent_call'/);
    expect(onWarn.mock.calls[1]?.[0]).toMatch(/unknown opt-in skill name 'mystery_skill'/);
  });

  it('full opt-out via disable_builtins=[chat_send, recall, store_lesson] yields an empty dispatcher', async () => {
    const pack = basePack({
      chatAgent: {
        default_model: 'fast_chat',
        skills: [],
        disable_builtins: ['chat_send', 'recall', 'store_lesson'],
        max_tool_iterations: 8,
        max_tokens: 1024,
      },
    });
    const { dispatcher } = await buildChatToolDispatcher({
      pack,
      packRoot,
      modelsConfig: { fast_chat: apiAlias(HAIKU) },
      ragBackend: emptyBackend(),
      secrets: fakeSecrets(),
    });
    expect(dispatcher.list().length).toBe(0);
  });
});
