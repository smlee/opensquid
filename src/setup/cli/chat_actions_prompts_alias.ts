/**
 * Model-alias setup sub-flows for the chat-setup wizard — extracted from
 * `chat_actions_prompts.ts` in WAB-SUB.3 to keep both files under the
 * 450-LOC cap.
 *
 * Single public entry point: `runModelAliasPrompts(secrets, mode)`. The
 * mode argument is supplied by the orchestrator after `runModeChoice`
 * resolves the user's explicit api-vs-subscription pick. Each branch
 * returns a populated `AliasResult` (or `null` on cancel).
 *
 * Branch shapes:
 *   - api          → model select + masked Anthropic key + key dest.
 *                    Writes alias { mode:'api', provider:'anthropic',
 *                    model, args:[] }.
 *   - subscription → cli + impl + args. No key prompt; subscription auth
 *                    flows through the host's own login state. Writes
 *                    alias { mode:'subscription', impl, cli, args }.
 *
 * Imports from: @clack/prompts, ../../packs/schemas/models, ./chat_state.
 * Imported by: src/setup/cli/chat_actions_prompts.ts (dispatcher only).
 */

import { confirm, isCancel, password, select, text } from '@clack/prompts';

import type { ModelAlias } from '../../packs/schemas/models.js';

import type { SecretsState } from './chat_state.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface AliasResult {
  alias: ModelAlias;
  /** Plaintext Anthropic API key (api mode only). null when subscription mode
   *  OR when user opted to provide the key via shell rc instead of .env. */
  apiKey: string | null;
  /** Whether to persist the apiKey to ~/.loop/.env. Always false in sub mode. */
  storeKey: boolean;
}

/**
 * Dispatch by mode. Called by the orchestrator AFTER `runModeChoice`
 * resolved the user's pick.
 */
export async function runModelAliasPrompts(
  secrets: SecretsState,
  mode: 'api' | 'subscription',
): Promise<AliasResult | null> {
  if (mode === 'subscription') return runSubscriptionAliasSetup();
  return runApiAliasSetup(secrets);
}

// ---------------------------------------------------------------------------
// api branch
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL_REGEX = /^claude-[a-z0-9-]+$/;

const KNOWN_MODELS: { value: string; label: string }[] = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fast + cheap, ~$1/M input' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — more capable, ~$3/M input' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7 — most capable, ~$15/M input' },
  { value: '__other__', label: 'Other — type a model identifier' },
];

async function runApiAliasSetup(secrets: SecretsState): Promise<AliasResult | null> {
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
        {
          value: 'env',
          label: '~/.opensquid/.env (default — chmod 600, opensquid secrets backend)',
        },
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
    description: 'Daily-driver chat agent (configured via setup wizard, api mode)',
    mode: 'api',
    args: [],
    model,
    provider: 'anthropic',
  };
  return { alias, apiKey, storeKey };
}

// ---------------------------------------------------------------------------
// subscription branch — cli + impl + args. No Anthropic key prompted;
// subscription auth flows through the host's own login state (e.g. the
// user already ran `claude login`). Defaults:
//   - cli   = 'claude'     (Claude Code's binary; user can swap to a path)
//   - impl  = 'cli'        (subprocess; sdk path lands later, not Phase 1)
//   - args  = ['--print']  (Claude Code's non-interactive batch mode flag)
//
// We deliberately do NOT prompt for a model identifier — Claude Code's
// subscription picks its model from `--model` IF passed in `args`. Leaving
// model name out keeps the alias model-neutral.
// ---------------------------------------------------------------------------

const SUB_DEFAULT_CLI = 'claude';
const SUB_DEFAULT_ARGS = '--print';

async function runSubscriptionAliasSetup(): Promise<AliasResult | null> {
  const cliInput = await text({
    message: 'Subscription CLI binary (name on PATH or absolute path)',
    initialValue: SUB_DEFAULT_CLI,
    validate: (v) => {
      const trimmed = v.trim();
      if (trimmed.length === 0) return 'CLI cannot be empty';
      if (/\s/.test(trimmed)) {
        return 'CLI must be a single token. Use args for additional flags.';
      }
      return undefined;
    },
  });
  if (isCancel(cliInput)) return null;
  const cli = cliInput.trim();

  const implChoice = await select({
    message: 'Implementation',
    options: [
      {
        value: 'cli',
        label: 'cli — spawn `' + cli + ' --print` as a subprocess (recommended)',
      },
      {
        value: 'sdk',
        label: 'sdk — in-process SDK (deferred; pick cli unless you know you have an SDK)',
      },
    ],
    initialValue: 'cli',
  });
  if (isCancel(implChoice)) return null;

  const argsInput = await text({
    message:
      'CLI args (space-separated; --print is required for non-interactive mode; add --model <name> to pin a model)',
    initialValue: SUB_DEFAULT_ARGS,
    validate: (v) => {
      const tokens = v.split(/\s+/).filter((t) => t.length > 0);
      if (!tokens.includes('--print')) {
        return 'Subscription CLI args must include --print (non-interactive mode)';
      }
      return undefined;
    },
  });
  if (isCancel(argsInput)) return null;
  const args = argsInput.split(/\s+/).filter((t) => t.length > 0);

  const alias: ModelAlias = {
    description: 'Daily-driver chat agent (configured via setup wizard, subscription mode)',
    mode: 'subscription',
    impl: implChoice as 'cli' | 'sdk',
    cli,
    args,
  };
  return { alias, apiKey: null, storeKey: false };
}
