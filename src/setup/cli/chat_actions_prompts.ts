/**
 * Prompt sub-flows for WIZ.3 + WAB-SUB.3 — extracted from `chat_actions.ts`
 * to stay under the file-size budget.
 *
 * Each exported function maps to one WIZ.1 storyboard step that has more
 * than a single prompt:
 *   - runIdempotencyBranch (i) — keep / replace / test_only / cancel.
 *     Treats BOTH api and subscription modes as valid existing config
 *     (WAB-SUB.3 — old "subscription must be replaced" hard-block removed).
 *   - runModeChoice        (c.0) — api vs subscription. NO `initialValue`;
 *     the user explicitly picks. First substantive prompt in the flow.
 *   - runModelAliasPrompts (c)   — dispatches to api or subscription branch
 *     based on the prior mode choice. api → model + key + dest; subscription
 *     → cli + impl + args (no key prompt).
 *   - runPackPrompts       (d)   — pack selection + chat_agent.yaml authoring.
 *
 * Discipline: every `isCancel()` is checked. Every prompt that takes user
 * text input has a Zod-ish validator (we validate via clack's `validate:`
 * callback rather than re-parsing through Zod, because the callback returns
 * a string error message clack renders inline; Zod's error shape would need
 * an adapter layer).
 *
 * Mode-neutrality (WAB-SUB.3): neither api nor subscription is hardcoded as
 * default. The runtime dispatcher already accepts both modes (per WAB-SUB.2
 * pack_binding); the wizard now matches by letting the user pick at the
 * earliest shape-determining moment instead of pretending api is the only
 * supported mode.
 *
 * Imports from: @clack/prompts, node:path, ../../packs/schemas/chat_agent,
 *   ../../packs/schemas/models, ./chat_state.
 * Imported by: src/setup/cli/chat_actions.ts.
 */

import { join } from 'node:path';

import { cancel, confirm, isCancel, note, select, text } from '@clack/prompts';

import { ChatAgentSchema, type ChatAgentConfig } from '../../packs/schemas/chat_agent.js';

import type { ModelsState, PacksState } from './chat_state.js';

const ALIAS_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const PACK_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// (i) Idempotency prompt — returns the chosen branch label.
// ---------------------------------------------------------------------------

export type IdempotentChoice = 'keep' | 'replace' | 'test_only' | 'cancel';

export async function runIdempotencyBranch(models: ModelsState): Promise<IdempotentChoice> {
  // WAB-SUB.3: BOTH `api` and `subscription` modes are now first-class valid.
  // The old sub-mode hard-block ("WAB v1 requires api mode") is gone because
  // pack_binding (WAB-SUB.2) + the runtime dispatcher accept both. We only
  // warn for genuinely unsupported modes (`local`, `mcp`) — those modes' end-
  // to-end agent-bridge support has not landed.
  const mode = models.fastChatMode;
  if (mode !== undefined && mode !== 'api' && mode !== 'subscription') {
    note(
      `Existing fast_chat uses mode=${String(mode)}, which the agent bridge does not yet drive end-to-end. Pick Replace to switch to api or subscription mode.`,
      'Warning',
    );
  }
  const modeLabel = mode === undefined ? '(unknown mode)' : `mode=${mode}`;
  const choice = await select({
    message: `Existing fast_chat alias detected (${modeLabel}). What would you like to do?`,
    options: [
      { value: 'keep', label: 'Keep — exit without changes' },
      {
        value: 'replace',
        label:
          'Replace — re-pick mode (api or subscription), overwrite fast_chat (existing file backed up)',
      },
      { value: 'test_only', label: 'Test only — verify the existing config works (no writes)' },
    ],
    initialValue: 'keep',
  });
  if (isCancel(choice)) return 'cancel';
  return choice as IdempotentChoice;
}

// ---------------------------------------------------------------------------
// (c.0) Mode choice — api vs subscription. WAB-SUB.3 first-class choice.
//
// Position: FIRST substantive prompt in the wizard flow, after detection.
// The user explicitly picks; NEITHER mode is pre-selected via `initialValue`.
// Shape modeled on `gh auth login`'s HTTPS-vs-SSH protocol prompt (also
// no default — the user states intent before any branch-specific question
// is asked). Distinguishing this question UP FRONT means the subscription
// path NEVER prompts for an Anthropic API key, and the api path NEVER
// prompts for a CLI binary; cross-branch leakage is structurally impossible.
// ---------------------------------------------------------------------------

export type ModeChoice = 'api' | 'subscription' | 'cancel';

export async function runModeChoice(): Promise<ModeChoice> {
  const choice = await select({
    message: 'How should the chat agent reach the LLM?',
    options: [
      {
        value: 'api',
        label: 'Anthropic API (pay-per-token; needs an ANTHROPIC_API_KEY)',
      },
      {
        value: 'subscription',
        label: 'Claude Code subscription (no extra cost; uses your `claude` CLI)',
      },
    ],
    // NOTE: NO initialValue — explicit user pick per WAB-SUB.3 acceptance
    // criterion A. clack renders with the first option highlighted but
    // pressing Enter without arrow keys still requires intentional input.
  });
  if (isCancel(choice)) return 'cancel';
  return choice as ModeChoice;
}

// ---------------------------------------------------------------------------
// (c) Model alias setup — split into chat_actions_prompts_alias.ts (api +
//     subscription branches). Re-exported here for backwards compatibility
//     with callers that import from this module.
// ---------------------------------------------------------------------------

export { runModelAliasPrompts, type AliasResult } from './chat_actions_prompts_alias.js';

// ---------------------------------------------------------------------------
// (d) Pack + chat_agent.yaml setup
// ---------------------------------------------------------------------------

export interface PackResult {
  packId: string;
  packRoot: string;
  chatAgent: ChatAgentConfig;
  createPackManifest: boolean;
  /** FRS.B: user explicitly consented to activating the pack (active.json). */
  activatePack: boolean;
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

  // FRS.B (user-confirmed default 2026-06-10): surface the pack opt-in.
  // Decline = today's ungated state, now explicitly chosen — never silent.
  const activate = await confirm({
    message: `Activate the "${packId}" discipline pack for this machine (writes active.json — opensquid stays inert without it)?`,
    initialValue: true,
  });
  if (isCancel(activate)) return null;

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

  const result: PackResult = {
    packId,
    packRoot,
    chatAgent: parsed.data,
    createPackManifest,
    activatePack: activate === true,
  };
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
