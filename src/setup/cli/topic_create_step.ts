/**
 * TPS.4 — first-run topic-create step for the chat-setup wizard.
 *
 * Slots between WIZ.3 (executePlan: writes models.yaml + chat_agent.yaml)
 * and WIZ.4 (runChannelTestStep). When the user has a Telegram supergroup
 * configured, offers to auto-create a forum topic for the current
 * workspace + bind it via TPS.3's `resolveOrCreateTopic`. Opt-out (default
 * = yes). On accept, the workspace's per-project `chat-routing.json` gets
 * an `auto_bound` block + the new topic_id added to `inbound_topic_ids`,
 * so the next WIZ.4 test (and subsequent agent traffic) lands in the
 * freshly-bound topic.
 *
 * Why not import `resolveOrCreateTopic` statically: `src.legacy/` is
 * excluded from `tsconfig.json`. The whole-tree typecheck can't see legacy
 * exports, and `tsconfig.build.json` doesn't emit them either. We load
 * the legacy module at runtime via a path computed from `import.meta.url`
 * — the runtime location is `dist/chat/daemon/workspace-topic.js` (built
 * by the ad-hoc `pnpm exec tsc src.legacy/...` invocation documented in
 * `src.legacy/chat/adapters/telegram.ts`). Tests inject a fake
 * `resolveOrCreateTopic` via the `deps` interface and bypass the loader.
 *
 * Never throws past the wizard — mirrors WIZ.4's contract. Every failure
 * prints a recovery hint via `note()` and returns. The WIZ.3 writes are
 * already on disk by the time this step runs; failure here leaves the
 * user with a working config minus the auto-binding.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { confirm, isCancel, note, spinner } from '@clack/prompts';
import pc from 'picocolors';

import { OPENSQUID_HOME } from '../../runtime/paths.js';

import type { ChatDaemonState } from './chat_state.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ResolveTopicArgs {
  workspaceUuid: string;
  workspacePath: string;
  chatId: string;
  mode: 'wizard' | 'auto-boot' | 'manual';
  dataRoot?: string;
}

export interface ResolveTopicResult {
  topicId: number;
  topicName: string;
  created: boolean;
}

export type ResolveOrCreateTopicFn = (args: ResolveTopicArgs) => Promise<ResolveTopicResult>;

export interface TopicCreateDeps {
  /** WIZ.2 daemon snapshot — same source the WIZ.4 sibling uses. */
  daemonState: ChatDaemonState;
  /** Cwd-walk start (test injection). Defaults to process.cwd(). */
  cwd?: string;
  /** Env override sink (test injection). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the topic-resolver (test injection). Defaults to the
   * runtime-loaded `resolveOrCreateTopic` from `dist/chat/daemon/
   * workspace-topic.js`. Tests substitute a stub here to avoid both the
   * dist dependency and the daemon RPC round-trip.
   */
  resolveOrCreateTopic?: ResolveOrCreateTopicFn;
  /**
   * Override the routing-read function (test injection). Defaults to
   * reading `~/.opensquid/projects/<uuid>/chat-routing.json`.
   */
  loadRouting?: (uuid: string) => Promise<ProjectChatRouting | null>;
}

export interface ProjectChatRouting {
  telegram?: {
    report_channel?: string;
    report_topic_id?: number;
    inbound_chat_ids?: string[];
    inbound_topic_ids?: number[];
    auto_bound?: {
      workspace_path: string;
      workspace_uuid: string;
      topic_id: number;
      topic_name: string;
      created_at: string;
      created_by: string;
    };
  };
  discord?: { report_channel?: string };
  slack?: { report_channel?: string };
}

// ---------------------------------------------------------------------------
// runTopicCreateStep — TPS.4 entry point. Returns void; never throws.
// ---------------------------------------------------------------------------

export async function runTopicCreateStep(deps: TopicCreateDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (env.OPENSQUID_NO_BILLED_CALLS === '1') {
    note('Topic-create skipped (OPENSQUID_NO_BILLED_CALLS=1).', 'Topic');
    return;
  }

  // Pre-flight: daemon liveness (same snapshot WIZ.4 uses).
  if (!deps.daemonState.running) {
    note(daemonNotRunningHint(deps.daemonState.pidPath), 'Topic');
    return;
  }

  const workspaceUuid = await resolveProjectUuid({
    cwd: deps.cwd ?? process.cwd(),
    env,
  });
  if (workspaceUuid === null) {
    note(noProjectUuidHint(), 'Topic');
    return;
  }

  const loadRouting = deps.loadRouting ?? loadProjectChatRouting;
  const routing = await loadRouting(workspaceUuid);
  const chatId = routing?.telegram?.report_channel;
  if (chatId === undefined || chatId.length === 0) {
    note(noSupergroupHint(), 'Topic');
    return;
  }

  const proceed = await confirm({
    message:
      'Create a Telegram forum topic for this workspace so its messages are isolated from other projects?',
    initialValue: true,
  });
  if (isCancel(proceed) || proceed !== true) {
    note(
      'Topic-create skipped — workspace messages will land in the supergroup general topic.',
      'Topic',
    );
    return;
  }

  const workspacePath = deps.cwd ?? process.cwd();
  const resolver = deps.resolveOrCreateTopic ?? (await loadLegacyResolver());

  const s = spinner();
  s.start('Creating topic (or reusing existing binding)...');
  try {
    const result = await resolver({
      workspaceUuid,
      workspacePath: resolve(workspacePath),
      chatId,
      mode: 'wizard',
    });
    if (result.created) {
      s.stop(
        pc.green(
          `Created topic "${result.topicName}" (thread_id=${String(result.topicId)}). Bound to this workspace.`,
        ),
      );
    } else {
      s.stop(
        pc.green(
          `Existing topic "${result.topicName}" (thread_id=${String(result.topicId)}) reused. Workspace already bound.`,
        ),
      );
    }
  } catch (err) {
    s.stop(pc.red(`Topic-create failed: ${describeError(err)}`));
    note(recoveryHintFor(err), 'Topic');
  }
}

// ---------------------------------------------------------------------------
// Project UUID resolution — env override > cwd walk for .opensquid/project.json
// (Identical chain to runChannelTestStep — duplicated to avoid coupling
// the two sibling steps via shared private state.)
// ---------------------------------------------------------------------------

interface ProjectCard {
  version: 1;
  id: string;
  uuid: string;
}

async function resolveProjectUuid(deps: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const fromEnv = deps.env.OPENSQUID_PROJECT_UUID;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  let dir = resolve(deps.cwd);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, '.opensquid', 'project.json');
    try {
      const raw = await readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as ProjectCard;
      if (parsed?.version === 1 && parsed.uuid && parsed.id) return parsed.uuid;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default routing reader — duplicates WIZ.4's inlined reader. Same
// type-poison avoidance rationale documented in chat_actions_test_step.ts.
// ---------------------------------------------------------------------------

async function loadProjectChatRouting(uuid: string): Promise<ProjectChatRouting | null> {
  const p = join(OPENSQUID_HOME(), 'projects', uuid, 'chat-routing.json');
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as ProjectChatRouting;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lazy legacy-resolver loader — resolves at first call so tests that
// inject `deps.resolveOrCreateTopic` never trigger the dist read. Path
// is constructed from `import.meta.url` (runtime location) rather than
// a static import string so the tsconfig src.legacy exclude is honored.
// ---------------------------------------------------------------------------

async function loadLegacyResolver(): Promise<ResolveOrCreateTopicFn> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Runtime: this file is at dist/setup/cli/topic_create_step.js;
  // workspace-topic.js lives at dist/chat/daemon/workspace-topic.js.
  const target = resolve(here, '..', '..', 'chat', 'daemon', 'workspace-topic.js');
  const mod = (await import(pathToFileURL(target).href)) as {
    resolveOrCreateTopic?: ResolveOrCreateTopicFn;
  };
  if (typeof mod.resolveOrCreateTopic !== 'function') {
    throw new Error(
      `legacy workspace-topic module at ${target} did not export resolveOrCreateTopic — rebuild dist/chat/daemon/* per the src.legacy header instructions`,
    );
  }
  return mod.resolveOrCreateTopic;
}

// ---------------------------------------------------------------------------
// Error classification — maps known TPS.3 failure modes to user-actionable
// recovery hints. Catch-all returns a generic "see daemon logs" hint.
// Detection is message-substring based (Telegram + grammy error messages
// pass through resolveOrCreateTopic unchanged).
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function recoveryHintFor(err: unknown): string {
  const msg = describeError(err);
  const lower = msg.toLowerCase();
  // 403 — bot lacks can_manage_topics. Telegram returns "Bad Request:
  // CHAT_ADMIN_REQUIRED" or "Forbidden: ...".
  if (
    lower.includes('chat_admin_required') ||
    lower.includes('can_manage_topics') ||
    msg.includes('403') ||
    lower.includes('forbidden')
  ) {
    return [
      "The bot needs the 'Manage Topics' admin permission on this supergroup.",
      'In Telegram: open the group → Edit → Administrators → your bot → enable Manage Topics.',
      'Then re-run `opensquid setup chat` and accept the topic-create step.',
    ].join('\n');
  }
  // 429 — rate-limited.
  if (msg.includes('429') || lower.includes('too many requests') || lower.includes('retry after')) {
    return [
      'Telegram is rate-limiting topic creation for this bot.',
      'Wait a minute, then re-run `opensquid setup chat` and accept the topic-create step.',
    ].join('\n');
  }
  // 400 — forum topics disabled on the supergroup.
  if (
    (msg.includes('400') && (lower.includes('topic') || lower.includes('forum'))) ||
    lower.includes('topics_disabled') ||
    lower.includes('not a forum')
  ) {
    return [
      'Forum topics are not enabled on this supergroup.',
      'In Telegram: open the group → Edit → Topics → enable Topics.',
      'Then re-run `opensquid setup chat` and accept the topic-create step.',
    ].join('\n');
  }
  // Lockfile LOCKED — another opensquid process is binding.
  if (lower.includes('elocked') || lower.includes('lock')) {
    return [
      'Another opensquid process is binding a topic for this workspace right now.',
      'Wait a few seconds and re-run `opensquid setup chat`.',
    ].join('\n');
  }
  // Persist failed AFTER createTopic — orphan recorded.
  if (lower.includes('orphan') || (lower.includes('persist') && lower.includes('fail'))) {
    return [
      'A topic was created on Telegram but the local binding write failed.',
      'The orphan was logged to ~/.opensquid/orphan-topics.jsonl for manual cleanup.',
      'Re-run `opensquid setup chat` after fixing the disk / permissions issue.',
    ].join('\n');
  }
  return [
    'See `~/.opensquid/chat-daemon.log` for daemon-side detail.',
    'Re-run `opensquid setup chat` to retry the topic-create step.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Static-text hints (same shape as WIZ.4 sibling)
// ---------------------------------------------------------------------------

function daemonNotRunningHint(pidPath: string): string {
  return [
    `The chat-daemon is not running (pidfile: ${pidPath}).`,
    'Start it with:',
    '  opensquid chat-daemon start',
    'then re-run `opensquid setup chat` and accept the topic-create step.',
  ].join('\n');
}

function noProjectUuidHint(): string {
  return [
    'Could not resolve the active project UUID.',
    'Run `opensquid init` in this directory, or set OPENSQUID_PROJECT_UUID.',
  ].join('\n');
}

function noSupergroupHint(): string {
  return [
    'No Telegram supergroup is configured for this workspace.',
    'Set `report_channel` in ~/.opensquid/projects/<uuid>/chat-routing.json,',
    'then re-run `opensquid setup chat` to bind a workspace topic.',
  ].join('\n');
}
