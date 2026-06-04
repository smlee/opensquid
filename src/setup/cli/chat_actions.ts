/**
 * WIZ.3 + WAB-SUB.3 — interactive chat-setup wizard. Implements
 * `docs/tasks/WIZ.1-flow.md` storyboard with the WAB-SUB.3 mode-choice
 * extension: detection → mode choice (api | subscription) → mode-specific
 * alias setup → chat_agent.yaml authoring → dry-run preview → confirm →
 * atomic write with backup → outro.
 *
 * Audit invariants:
 *   - No write without explicit `confirm()` → true after dry-run preview.
 *   - `isCancel()` checked after EVERY prompt; cancel path emits a "nothing
 *     written" message and exits clean.
 *   - Secrets prompted via `password()` (masked) IN api mode only; subscription
 *     mode never prompts for a key. Dry-run preview shows `=…<last4>` only.
 *   - Both `mode=api` and `mode=subscription` are first-class choices —
 *     NEITHER pre-selected as `initialValue` (WAB-SUB.3 spec criterion A).
 *   - Existing config (idempotency branch) treats BOTH modes as valid;
 *     Replace walks the mode-choice prompt again.
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
  runModeChoice,
  runModelAliasPrompts,
  runPackPrompts,
} from './chat_actions_prompts.js';
import { runChannelTestStep } from './chat_actions_test_step.js';
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
  type ChatDaemonState,
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
  /**
   * WIZ.5 `--dry-run`. Wizard walks prompts + renders the plan, then exits
   * WITHOUT calling `executePlan`. The dry-run preview is the deliverable;
   * no files are written, no backups created. Final confirm prompt is
   * skipped (we wouldn't honor a `true` answer anyway).
   */
  dryRun?: boolean;
  /**
   * WIZ.5 `--replace`. Skips the existing-config (idempotency) branch and
   * always proceeds to author fresh config — overwriting any existing
   * fast_chat alias. Backup of the prior models.yaml is still made.
   */
  replace?: boolean;
}

export interface WizardResult {
  outcome: 'completed' | 'aborted' | 'no_changes' | 'concurrent_lock' | 'dry_run';
  written?: string[];
}

// ---------------------------------------------------------------------------
// runChatSetupWizard — top-level orchestrator (lock + intro + branch routing).
// ---------------------------------------------------------------------------

export async function runChatSetupWizard(deps: WizardDeps = {}): Promise<WizardResult> {
  const setExitCode = deps.setExitCode ?? ((c) => (process.exitCode = c));
  const homeDir = deps.opensquidHome ?? OPENSQUID_HOME();
  const envPath = deps.envPath ?? defaultEnvPath();
  const dryRun = deps.dryRun === true;
  const replace = deps.replace === true;

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
    return await runInner({ homeDir, envPath, setExitCode, dryRun, replace });
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
  dryRun: boolean;
  replace: boolean;
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
  // WIZ.5: `--replace` skips the idempotency branch entirely — proceed
  // straight to authoring fresh config, overwriting any existing fast_chat
  // alias. Caller still sees the dry-run preview + confirm before any
  // write happens, so this is not a "silent overwrite" foot-gun.
  if (detection.models.hasFastChat && !d.replace) {
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
  } else if (detection.models.hasFastChat && d.replace) {
    note(
      'fast_chat alias exists. --replace: skipping confirm, will overwrite after dry-run preview.',
      'Replace',
    );
  }

  // (c.0) Mode choice — api vs subscription. WAB-SUB.3: this is the FIRST
  // shape-determining prompt. NEITHER mode is pre-selected; the user
  // explicitly picks. Reached on clean-state runs AND on the Replace branch
  // of an existing-config run (so "Replace" can swap api↔subscription
  // both ways, not just sub→api as the WIZ.3 hard-block forced).
  const mode = await runModeChoice();
  if (mode === 'cancel') return abortNoChanges();

  // (c) Model alias setup — branches on the mode choice. api prompts
  //     model + masked key + key dest. subscription prompts cli + impl
  //     + args (no Anthropic API key prompt; subscription auth flows
  //     through the host's own login state).
  const aliasResult = await runModelAliasPrompts(detection.secrets, mode);
  if (aliasResult === null) return abortNoChanges();

  // (d) Pack + chat_agent.yaml authoring
  const packResult = await runPackPrompts(detection.packs, d.homeDir);
  if (packResult === null) return abortNoChanges();

  // (e) Channel offer — pre-write channel-token detection only. Live
  //     delivery happens post-write in step (f) below; this prompt stays
  //     here so the user sees the channel status before committing writes.
  if ((await runChannelOffer(detection.secrets)) === 'cancel') return abortNoChanges();

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

  // WIZ.5: `--dry-run` short-circuits before the confirm + executePlan.
  // The plan preview IS the deliverable; nothing is written. We still emit
  // a clear outro so the user knows the wizard finished cleanly.
  if (d.dryRun) {
    outro(
      pc.yellow(
        `Dry-run complete. ${String(plan.actions.length)} file(s) WOULD be written.\nRe-run without --dry-run to apply.`,
      ),
    );
    return { outcome: 'dry_run' };
  }

  const proceed = await confirm({
    message: `Write these ${String(plan.actions.length)} files?`,
    initialValue: false,
  });
  if (isCancel(proceed) || proceed !== true) return abortNoChanges();

  try {
    const result = await executePlan(plan);
    // (e2) Topic creation is no longer a wizard step (CAT.8 retire). The
    //      umbrella's one forum topic is created on the first SessionStart by the
    //      `ensure_umbrella_topic` assurance (default-discipline's
    //      session-connection-check skill) on `channels.json` — the legacy
    //      chat-routing.json `resolveOrCreateTopic` path is gone.
    // (f) WIZ.4 — opt-in live test, post-write. The user's models.yaml +
    //     chat_agent.yaml are on disk by now; offering the test here lets
    //     them verify end-to-end delivery against the freshly written
    //     config. Skipped when OPENSQUID_NO_BILLED_CALLS=1.
    await runChannelTestStep({ daemonState: detection.daemon });
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
  1. Picking how the agent reaches its LLM (Anthropic API key OR Claude Code subscription)
  2. Declaring a model alias (fast_chat) for the agent
  3. Writing a chat_agent.yaml side-file inside one of your packs
  4. (Optional) Sending a test message to verify end-to-end delivery

Nothing is written until you confirm. Ctrl-C aborts safely at any prompt.
Files affected (preview shown before write):
  - ${d.homeDir}/models.yaml       (created or merged)
  - ${d.envPath}                   (appended — ANTHROPIC_API_KEY, api mode only)
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
  daemon: ChatDaemonState;
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
      { value: 'detect', label: 'Detect the existing bot token (no writes, no calls)' },
    ],
    initialValue: 'skip',
  });
  if (isCancel(channelChoice)) return 'cancel';
  if (channelChoice === 'detect') {
    if (secrets.telegramTokenPresent) {
      note(
        `Token found at ${secrets.envPath}. Live delivery is offered after save (step f).`,
        'Channel',
      );
    } else {
      note(
        'OPENSQUID_TELEGRAM_BOT_TOKEN not found. Add it to ~/.loop/.env before accepting the post-save test.',
        'Channel',
      );
    }
  }
  return 'ok';
}

// `ChatDaemonState` is imported so the orchestrator's compile-time surface
// matches what `runChannelTestStep` consumes. Re-exported for callers that
// want to construct a wizard-equivalent test invocation in their own code.
export type { ChatDaemonState };

export { runChatSetupWizard as runWizard };
