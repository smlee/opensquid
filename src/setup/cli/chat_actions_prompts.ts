/**
 * Prompt sub-flows for WIZ.3 — extracted from `chat_actions.ts` to stay
 * under the file-size budget.
 *
 * Each exported function maps to one WIZ.1 storyboard step that has more
 * than a single prompt:
 *   - runIdempotencyBranch (i) — keep / replace / test_only / cancel.
 *   - runModelAliasPrompts (c) — model + mode + masked key + key-storage dest.
 *   - runPackPrompts       (d) — pack selection + chat_agent.yaml authoring.
 *
 * Discipline: every `isCancel()` is checked. Every prompt that takes user
 * text input has a Zod-ish validator (we validate via clack's `validate:`
 * callback rather than re-parsing through Zod, because the callback returns
 * a string error message clack renders inline; Zod's error shape would need
 * an adapter layer).
 *
 * Imports from: @clack/prompts, node:path, ../../packs/schemas/chat_agent,
 *   ../../packs/schemas/models, ./chat_state.
 * Imported by: src/setup/cli/chat_actions.ts.
 */

import { join } from 'node:path';

import { cancel, confirm, isCancel, note, password, select, text } from '@clack/prompts';

import { ChatAgentSchema, type ChatAgentConfig } from '../../packs/schemas/chat_agent.js';
import type { ModelAlias } from '../../packs/schemas/models.js';

import type { ModelsState, PacksState, SecretsState } from './chat_state.js';

const ANTHROPIC_MODEL_REGEX = /^claude-[a-z0-9-]+$/;
const ALIAS_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const PACK_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// (i) Idempotency prompt — returns the chosen branch label.
// ---------------------------------------------------------------------------

export type IdempotentChoice = 'keep' | 'replace' | 'test_only' | 'cancel';

export async function runIdempotencyBranch(models: ModelsState): Promise<IdempotentChoice> {
  if (models.fastChatMode === 'subscription') {
    note(
      [
        'Your existing fast_chat uses subscription mode.',
        'WAB v1 requires api mode; pick Replace to switch (your subscription config is backed up)',
        "or Keep to leave it (chat agent won't start until subscription-mode follow-up ships).",
      ].join('\n'),
      'Warning',
    );
  } else if (models.fastChatMode !== 'api') {
    note(
      `Non-api mode (${String(models.fastChatMode)}) unsupported in v1; pick Replace to switch.`,
      'Warning',
    );
  }
  const choice = await select({
    message: 'Existing fast_chat alias detected. What would you like to do?',
    options: [
      { value: 'keep', label: 'Keep — exit without changes' },
      { value: 'replace', label: 'Replace — overwrite fast_chat (existing file backed up)' },
      { value: 'test_only', label: 'Test only — verify the existing config works (no writes)' },
    ],
    initialValue: 'keep',
  });
  if (isCancel(choice)) return 'cancel';
  return choice as IdempotentChoice;
}

// ---------------------------------------------------------------------------
// (c) Model alias setup
// ---------------------------------------------------------------------------

export interface AliasResult {
  alias: ModelAlias;
  apiKey: string | null;
  storeKey: boolean;
}

const KNOWN_MODELS: { value: string; label: string }[] = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fast + cheap, ~$1/M input' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — more capable, ~$3/M input' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7 — most capable, ~$15/M input' },
  { value: '__other__', label: 'Other — type a model identifier' },
];

export async function runModelAliasPrompts(secrets: SecretsState): Promise<AliasResult | null> {
  const modelChoice = await select({
    message: 'Which Anthropic model should fast_chat use?',
    options: KNOWN_MODELS,
    initialValue: 'claude-haiku-4-5-20251001',
  });
  if (isCancel(modelChoice)) return null;
  let model: string;
  if (modelChoice === '__other__') {
    const custom = await text({
      message: 'Model identifier (e.g. claude-haiku-4-5-20251001)',
      validate: (v) =>
        ANTHROPIC_MODEL_REGEX.test(v) ? undefined : 'Must look like claude-<family>-<version>',
    });
    if (isCancel(custom)) return null;
    model = custom;
  } else {
    model = modelChoice;
  }

  const mode = await select({
    message: 'Connection mode',
    options: [
      { value: 'api', label: 'API mode — direct Anthropic API key (REQUIRED for v1)' },
      {
        value: 'subscription',
        label: 'Subscription mode — NOT SUPPORTED IN v1 (will hard-block)',
      },
    ],
    initialValue: 'api',
  });
  if (isCancel(mode)) return null;
  if (mode === 'subscription') {
    cancel(
      'Subscription mode is not supported in v1. Re-run with API mode, or wait for the subscription-mode follow-up.',
    );
    return null;
  }

  const keyInput = await password({
    message: secrets.anthropicKeyPresent
      ? `Anthropic API key (existing key detected at ${secrets.envPath} — press Enter to skip)`
      : 'Anthropic API key (input will be masked)',
    mask: '*',
    validate: (v) => {
      if (v.length === 0) return undefined;
      if (/\s/.test(v)) return 'API keys cannot contain whitespace. Did you paste a newline?';
      if (!v.startsWith('sk-ant-')) return 'Anthropic API keys start with sk-ant-.';
      return undefined;
    },
  });
  if (isCancel(keyInput)) return null;
  const apiKey = keyInput.length > 0 ? keyInput : null;

  let storeKey = false;
  if (apiKey !== null) {
    const dest = await select({
      message: 'Where should the key be stored?',
      options: [
        { value: 'env', label: '~/.loop/.env (default — chmod 600, opensquid secrets backend)' },
        { value: 'skip', label: "Skip — I'll set ANTHROPIC_API_KEY manually in my shell rc" },
      ],
      initialValue: 'env',
    });
    if (isCancel(dest)) return null;
    if (dest === 'skip') {
      const reconfirm = await confirm({
        message:
          'You entered a key but chose not to persist it. The key will be lost when this wizard exits. Continue?',
        initialValue: false,
      });
      if (isCancel(reconfirm) || reconfirm !== true) return null;
      storeKey = false;
    } else {
      storeKey = true;
    }
  }

  const alias: ModelAlias = {
    description: 'Daily-driver chat agent (configured via setup wizard)',
    mode: 'api',
    args: [],
    model,
    provider: 'anthropic',
  };
  return { alias, apiKey, storeKey };
}

// ---------------------------------------------------------------------------
// (d) Pack + chat_agent.yaml setup
// ---------------------------------------------------------------------------

export interface PackResult {
  packId: string;
  packRoot: string;
  chatAgent: ChatAgentConfig;
  createPackManifest: boolean;
  customPromptPath?: string;
  customPromptBody?: string;
}

export async function runPackPrompts(
  packs: PacksState,
  homeDir: string,
): Promise<PackResult | null> {
  const packMeta = await pickPack(packs, homeDir);
  if (packMeta === null) return null;
  const { packId, packRoot, createPackManifest } = packMeta;

  const defaultModel = await pickDefaultModel();
  if (defaultModel === null) return null;

  const promptMeta = await pickSystemPrompt();
  if (promptMeta === null) return null;

  const skills = await pickSkills();
  if (skills === null) return null;

  const tunables = await pickTunables();
  if (tunables === null) return null;

  const chatAgentInput: Record<string, unknown> = {
    default_model: defaultModel,
    skills,
    disable_builtins: [],
    max_tool_iterations: tunables.maxToolIterations,
    max_tokens: tunables.maxTokens,
  };
  if (promptMeta.systemPrompt !== undefined) chatAgentInput.system_prompt = promptMeta.systemPrompt;
  const parsed = ChatAgentSchema.safeParse(chatAgentInput);
  if (!parsed.success) {
    cancel(`Internal schema error building chat_agent config: ${parsed.error.message}`);
    return null;
  }

  const result: PackResult = { packId, packRoot, chatAgent: parsed.data, createPackManifest };
  if (promptMeta.customPath !== undefined) result.customPromptPath = promptMeta.customPath;
  if (promptMeta.customBody !== undefined) result.customPromptBody = promptMeta.customBody;
  return result;
}

interface PackMeta {
  packId: string;
  packRoot: string;
  createPackManifest: boolean;
}

async function pickPack(packs: PacksState, homeDir: string): Promise<PackMeta | null> {
  if (packs.packs.length === 0) {
    const proceed = await select({
      message: `No packs found at ${packs.path}. Create a minimal starter pack?`,
      options: [
        { value: 'create', label: 'Yes — create starter pack' },
        { value: 'abort', label: "No — abort (I'll set up packs manually first)" },
      ],
      initialValue: 'create',
    });
    if (isCancel(proceed) || proceed === 'abort') return null;
    const nameInput = await text({
      message: 'Starter pack name',
      initialValue: 'chat-agent-default',
      validate: (v) => (PACK_NAME_REGEX.test(v) ? undefined : 'Name must be lower-kebab-case'),
    });
    if (isCancel(nameInput)) return null;
    return {
      packId: nameInput,
      packRoot: join(homeDir, 'packs', nameInput),
      createPackManifest: true,
    };
  }
  const options = packs.packs.map((p) => ({
    value: p.name,
    label: `${p.name}${p.hasChatAgent ? ' [has chat_agent.yaml]' : ''}  (${p.root})`,
  }));
  options.push({ value: '__new__', label: 'Create a new minimal pack' });
  const choice = await select({
    message: 'Which pack should host the chat_agent.yaml side-file?',
    options,
    initialValue: options[0]?.value ?? '__new__',
  });
  if (isCancel(choice)) return null;
  if (choice === '__new__') {
    const nameInput = await text({
      message: 'New pack name',
      initialValue: 'chat-agent-default',
      validate: (v) => (PACK_NAME_REGEX.test(v) ? undefined : 'Name must be lower-kebab-case'),
    });
    if (isCancel(nameInput)) return null;
    return {
      packId: nameInput,
      packRoot: join(homeDir, 'packs', nameInput),
      createPackManifest: true,
    };
  }
  const found = packs.packs.find((p) => p.name === choice);
  return {
    packId: choice,
    packRoot: found?.root ?? join(homeDir, 'packs', choice),
    createPackManifest: false,
  };
}

async function pickDefaultModel(): Promise<string | null> {
  const aliasChoice = await select({
    message: 'Which model alias should be the default for this chat agent?',
    options: [
      { value: 'fast_chat', label: 'fast_chat (recommended — the alias you just declared)' },
      { value: '__other__', label: 'Other — type an alias name' },
    ],
    initialValue: 'fast_chat',
  });
  if (isCancel(aliasChoice)) return null;
  if (aliasChoice === '__other__') {
    const custom = await text({
      message: 'Alias name (from your models.yaml)',
      validate: (v) => (ALIAS_NAME_REGEX.test(v) ? undefined : 'Alias must be lower_snake_case'),
    });
    if (isCancel(custom)) return null;
    return custom;
  }
  return aliasChoice;
}

interface PromptMeta {
  systemPrompt?: string;
  customPath?: string;
  customBody?: string;
}

async function pickSystemPrompt(): Promise<PromptMeta | null> {
  const promptChoice = await select({
    message: 'System prompt for the chat agent',
    options: [
      { value: 'default', label: 'Use built-in default' },
      { value: 'custom', label: 'Write a custom prompt (saved to prompts/chat.md)' },
      { value: 'existing', label: 'Reference an existing file in the pack' },
    ],
    initialValue: 'default',
  });
  if (isCancel(promptChoice)) return null;
  if (promptChoice === 'custom') {
    // NOTE: @clack/prompts text() is single-line in 0.7.x — no multiline.
    // Users wanting paragraph-long prompts pick "existing" and hand-author.
    const promptText = await text({
      message: 'System prompt body (single-line; edit prompts/chat.md after the wizard for more)',
      initialValue:
        'You are a chat agent for the project. Reply concisely. Use chat_send to deliver your final reply.',
    });
    if (isCancel(promptText)) return null;
    return {
      systemPrompt: 'prompts/chat.md',
      customPath: 'prompts/chat.md',
      customBody: promptText,
    };
  }
  if (promptChoice === 'existing') {
    const pathInput = await text({
      message: 'Path relative to pack root',
      validate: (v) => (v.endsWith('.md') ? undefined : 'Path should end in .md'),
    });
    if (isCancel(pathInput)) return null;
    return { systemPrompt: pathInput };
  }
  return {};
}

async function pickSkills(): Promise<string[] | null> {
  const skillsChoice = await select({
    message:
      'Opt-in skills beyond built-ins (chat_send, recall, store_lesson are always available)',
    options: [
      { value: 'none', label: 'None (default)' },
      { value: 'subagent_call', label: 'subagent_call — spawn subagents for complex sub-tasks' },
      { value: 'llm_classify', label: 'llm_classify — call a configured LLM for classification' },
      { value: 'both', label: 'subagent_call + llm_classify' },
    ],
    initialValue: 'none',
  });
  if (isCancel(skillsChoice)) return null;
  if (skillsChoice === 'none') return [];
  if (skillsChoice === 'both') return ['subagent_call', 'llm_classify'];
  return [skillsChoice];
}

interface Tunables {
  maxToolIterations: number;
  maxTokens: number;
}

async function pickTunables(): Promise<Tunables | null> {
  const choice = await select({
    message: 'Override max_tool_iterations or max_tokens?',
    options: [
      { value: 'no', label: 'No — use defaults (max_tool_iterations=8, max_tokens=1024)' },
      { value: 'yes', label: 'Yes — let me set custom values' },
    ],
    initialValue: 'no',
  });
  if (isCancel(choice)) return null;
  if (choice === 'no') return { maxToolIterations: 8, maxTokens: 1024 };
  const iterations = await text({
    message: 'max_tool_iterations (1-32)',
    initialValue: '8',
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= 32 ? undefined : 'Must be an integer 1-32';
    },
  });
  if (isCancel(iterations)) return null;
  const tokens = await text({
    message: 'max_tokens (64-8192)',
    initialValue: '1024',
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n >= 64 && n <= 8192 ? undefined : 'Must be an integer 64-8192';
    },
  });
  if (isCancel(tokens)) return null;
  return {
    maxToolIterations: Number.parseInt(iterations, 10),
    maxTokens: Number.parseInt(tokens, 10),
  };
}
