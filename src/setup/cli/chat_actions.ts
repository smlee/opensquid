/**
 * WIZ.3 — interactive chat-setup wizard. Implements `docs/tasks/WIZ.1-flow.md`
 * verbatim: detection → model alias → masked Anthropic key → chat_agent.yaml
 * authoring → dry-run preview → confirm → atomic write with backup → outro.
 *
 * Audit invariants:
 *   - No write without explicit `confirm()` → true after dry-run preview.
 *   - `isCancel()` checked after EVERY prompt; cancel path emits a "nothing
 *     written" message and exits clean.
 *   - Secrets prompted via `password()` (masked); never printed, logged, or
 *     written to YAML. Dry-run preview shows `=…<last4>` only.
 *   - Sub-mode hard-block in v1 (Replace into api-mode; Keep allowed + warned).
 *   - `OPENSQUID_NO_BILLED_CALLS=1` skips step (f) entirely.
 *   - `~/.opensquid/setup-chat.lock` via proper-lockfile prevents concurrent runs.
 *
 * Writes delegated to `./chat_actions_writers.ts`; prompt sub-flows to
 * `./chat_actions_prompts.ts`. This file orchestrates only.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { cancel, confirm, intro, isCancel, note, outro, select } from '@clack/prompts';
import pc from 'picocolors';
import { lock as acquireLock } from 'proper-lockfile';

import { OPENSQUID_HOME } from '../../runtime/paths.js';

import {
  runIdempotencyBranch,
  runModelAliasPrompts,
  runPackPrompts,
} from './chat_actions_prompts.js';
import {
  buildPlan,
  executePlan,
  renderPlanPreview,
  type WritePlan,
} from './chat_actions_writers.js';
import {
  defaultEnvPath,
  detectAgentBridgeRunning,
  detectChatDaemonRunning,
  detectModelsConfig,
  detectPacksDir,
  detectSecretsBackend,
  type ModelsState,
  type PacksState,
  type SecretsState,
} from './chat_state.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface WizardDeps {
  /** Override for OPENSQUID_HOME (test injection). Defaults to env var. */
  opensquidHome?: string;
  /** Override for ~/.loop/.env path. */
  envPath?: string;
  /** Exit code sink — tests assert against this without process.exit. */
  setExitCode?: (code: number) => void;
}

export interface WizardResult {
  outcome: 'completed' | 'aborted' | 'no_changes' | 'concurrent_lock';
  written?: string[];
}

// ---------------------------------------------------------------------------
// runChatSetupWizard — top-level orchestrator (lock + intro + branch routing).
// ---------------------------------------------------------------------------

export async function runChatSetupWizard(deps: WizardDeps = {}): Promise<WizardResult> {
  const setExitCode = deps.setExitCode ?? ((c) => (process.exitCode = c));
  const homeDir = deps.opensquidHome ?? OPENSQUID_HOME();
  const envPath = deps.envPath ?? defaultEnvPath();

  await mkdir(homeDir, { recursive: true });
  const lockPath = join(homeDir, 'setup-chat.lock');
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(lockPath, { retries: 0, stale: 30000, realpath: false });
  } catch {
    intro(pc.cyan('opensquid setup chat'));
    cancel(
      `Another opensquid setup chat is running. Refusing to start a second wizard.\nIf the prior run died, remove ${lockPath}.lock and re-run.`,
    );
    setExitCode(1);
    return { outcome: 'concurrent_lock' };
  }
  try {
    return await runInner({ homeDir, envPath, setExitCode });
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        /* lock-release best-effort */
      }
    }
  }
}

interface InnerDeps {
  homeDir: string;
  envPath: string;
  setExitCode: (code: number) => void;
}

async function runInner(d: InnerDeps): Promise<WizardResult> {
  // (a) Intro splash
  intro(pc.cyan('opensquid setup chat — guided chat-agent setup'));
  note(introBody(d), 'About');

  // (b) Detection
  const detection = await runDetection(d);
  note(renderDetection(detection), 'State');

  if (detection.models.parseError !== undefined) {
    cancel(parseErrorMessage(detection.models));
    d.setExitCode(2);
    return { outcome: 'aborted' };
  }

  // (i) Idempotency
  if (detection.models.hasFastChat) {
    const choice = await runIdempotencyBranch(detection.models);
    if (choice === 'cancel') return abortNoChanges();
    if (choice === 'keep') {
      outro(pc.green('No changes. Existing fast_chat alias preserved.'));
      return { outcome: 'no_changes' };
    }
    if (choice === 'test_only') {
      outro(
        pc.yellow(
          'Test-only mode is wired in WIZ.4. Re-run after WIZ.4 ships, or pick Replace to re-author.',
        ),
      );
      return { outcome: 'no_changes' };
    }
    // 'replace' falls through.
  }

  // (c) Model alias setup
  const aliasResult = await runModelAliasPrompts(detection.secrets);
  if (aliasResult === null) return abortNoChanges();

  // (d) Pack + chat_agent.yaml authoring
  const packResult = await runPackPrompts(detection.packs, d.homeDir);
  if (packResult === null) return abortNoChanges();

  // (e) Channel offer (WIZ.4 deep-implements live verification)
  if ((await runChannelOffer(detection.secrets)) === 'cancel') return abortNoChanges();

  // (f) Live test (gated by OPENSQUID_NO_BILLED_CALLS)
  if ((await runLiveTest()) === 'cancel') return abortNoChanges();

  // (g) Dry-run preview + confirm + write
  const plan = buildPlan({
    homeDir: d.homeDir,
    envPath: d.envPath,
    modelsState: detection.models,
    fastChatAlias: aliasResult.alias,
    apiKey: aliasResult.apiKey,
    storeKey: aliasResult.storeKey,
    packRoot: packResult.packRoot,
    chatAgent: packResult.chatAgent,
    createPackManifest: packResult.createPackManifest,
    packId: packResult.packId,
    ...(packResult.customPromptPath !== undefined && {
      customPromptPath: packResult.customPromptPath,
    }),
    ...(packResult.customPromptBody !== undefined && {
      customPromptBody: packResult.customPromptBody,
    }),
  });
  note(renderPlanPreview(plan), 'Plan');

  const proceed = await confirm({
    message: `Write these ${String(plan.actions.length)} files?`,
    initialValue: false,
  });
  if (isCancel(proceed) || proceed !== true) return abortNoChanges();

  try {
    const result = await executePlan(plan);
    outro(successOutro(plan));
    return { outcome: 'completed', written: result.written };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cancel(
      `Write failed: ${message}\nBackups restored from ${plan.backupDir} (if any existing files were backed up).`,
    );
    d.setExitCode(3);
    return { outcome: 'aborted' };
  }
}

function abortNoChanges(): WizardResult {
  cancel('Aborted. No files modified.');
  return { outcome: 'aborted' };
}

// ---------------------------------------------------------------------------
// Static text builders
// ---------------------------------------------------------------------------

const introBody = (d: InnerDeps): string =>
  `This wizard walks you through:
  1. Declaring a model alias (fast_chat) so the chat agent can call Anthropic
  2. Writing a chat_agent.yaml side-file inside one of your packs
  3. (Optional) Sending a test message to verify end-to-end delivery

Nothing is written until you confirm. Ctrl-C aborts safely at any prompt.
Files affected (preview shown before write):
  - ${d.homeDir}/models.yaml       (created or merged)
  - ${d.envPath}                   (appended — ANTHROPIC_API_KEY)
  - <pack-root>/chat_agent.yaml    (created or replaced)
  - ${d.homeDir}/backup/<ts>/      (backups of overwritten files)`;

const parseErrorMessage = (models: ModelsState): string =>
  `Your existing ${models.path} has a YAML/schema error:
  ${models.parseError ?? 'unknown'}

The wizard refuses to overwrite a file it can't parse, because the merge step needs
to preserve unrelated aliases.

Fix: repair the file manually, OR move it aside
  mv ${models.path} ${models.path}.broken
and re-run.`;

const successOutro = (plan: WritePlan): string =>
  `${pc.green('Chat agent configured.')}

Next steps:
  - Start the bridge:    opensquid agent-bridge start
  - Test in chat:        send a message to your project Telegram channel
  - Undo this setup:     restore files from ${plan.backupDir}`;

// ---------------------------------------------------------------------------
// Detection — gather all five detector snapshots in parallel
// ---------------------------------------------------------------------------

interface Detection {
  models: ModelsState;
  packs: PacksState;
  secrets: SecretsState;
  daemon: { running: boolean; pid?: number };
  bridge: { running: boolean; pid?: number };
}

async function runDetection(d: InnerDeps): Promise<Detection> {
  const modelsPath = join(d.homeDir, 'models.yaml');
  const packsDir = join(d.homeDir, 'packs');
  const [models, packs, secrets, daemon, bridge] = await Promise.all([
    detectModelsConfig(modelsPath),
    detectPacksDir(packsDir),
    detectSecretsBackend({ envPath: d.envPath }),
    detectChatDaemonRunning(),
    detectAgentBridgeRunning(),
  ]);
  return { models, packs, secrets, daemon, bridge };
}

function renderDetection(det: Detection): string {
  const y = pc.green;
  const n = pc.dim;
  const b = pc.red;
  const withChat = det.packs.packs.filter((p) => p.hasChatAgent).map((p) => p.name);
  const fastChat =
    det.models.parseError !== undefined
      ? b('PARSE ERROR')
      : det.models.hasFastChat
        ? y(`present (mode=${det.models.fastChatMode ?? 'unknown'})`)
        : n('absent');
  const modelsState =
    det.models.parseError !== undefined
      ? b('PARSE ERROR')
      : det.models.present
        ? y('found')
        : n('not found');
  const packCount =
    det.packs.packs.length > 0
      ? y(`${String(det.packs.packs.length)} pack(s) found`)
      : n('none — wizard will create starter');
  return [
    `Models config (${det.models.path}): ${modelsState}`,
    `  fast_chat alias: ${fastChat}`,
    `Secrets backend (${det.secrets.envPath}): ${det.secrets.envPresent ? y('found') : n('not found')}`,
    `  ANTHROPIC_API_KEY: ${det.secrets.anthropicKeyPresent ? y('set') : n('not set')}`,
    `Packs available (${det.packs.path}): ${packCount}`,
    `  Packs with chat_agent.yaml: ${withChat.length > 0 ? y(withChat.join(', ')) : n('none')}`,
    `chat-daemon running: ${det.daemon.running ? y(`yes (pid=${String(det.daemon.pid)})`) : n('no')}`,
    `agent-bridge running: ${det.bridge.running ? y(`yes (pid=${String(det.bridge.pid)})`) : n('no')}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// (e) + (f) inline prompt helpers (each only one prompt; staying in this
// file keeps the call site readable)
// ---------------------------------------------------------------------------

async function runChannelOffer(secrets: SecretsState): Promise<'ok' | 'cancel'> {
  const channelChoice = await select({
    message: 'Set up Telegram channel now?',
    options: [
      { value: 'skip', label: "Skip for now (default) — I'll configure channels later" },
      { value: 'detect', label: 'Detect + verify the existing bot token (no writes)' },
    ],
    initialValue: 'skip',
  });
  if (isCancel(channelChoice)) return 'cancel';
  if (channelChoice === 'detect') {
    if (secrets.telegramTokenPresent) {
      note(`Token found at ${secrets.envPath}. Live verification ships in WIZ.4.`, 'Channel');
    } else {
      note(
        'OPENSQUID_TELEGRAM_BOT_TOKEN not found. Add it to ~/.loop/.env (see reference_user_telegram_config in memory).',
        'Channel',
      );
    }
  }
  return 'ok';
}

async function runLiveTest(): Promise<'ok' | 'cancel'> {
  if (process.env.OPENSQUID_NO_BILLED_CALLS === '1') {
    note('Test skipped (OPENSQUID_NO_BILLED_CALLS set).', 'Test');
    return 'ok';
  }
  const testChoice = await select({
    message: 'Send a test message via chat-daemon now?',
    options: [
      { value: 'skip', label: 'Skip (default)' },
      { value: 'send', label: 'Yes — send "[opensquid wizard test]" to project:telegram' },
    ],
    initialValue: 'skip',
  });
  if (isCancel(testChoice)) return 'cancel';
  if (testChoice === 'send') {
    note(
      'Live test wiring ships in WIZ.4. Proceeding to save (test result does not gate the write).',
      'Test',
    );
  }
  return 'ok';
}

export { runChatSetupWizard as runWizard };
