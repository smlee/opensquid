/**
 * agent_bridge — long-running daemon (WAB.7).
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` WAB.7.
 * Architecture: `docs/tasks/WAB.1-architecture.md` decisions (a)-(g).
 *
 * Wires every WAB.2-WAB.6 component (event bus, transport bridge, session
 * manager, batch coordinator + dispatcher, pack-bound tool dispatcher)
 * into a single long-running process driven by `start()` + `shutdown()`.
 * Owns the daemon-wide singletons:
 *   - one Anthropic SDK client (WAB.1 decision (c))
 *   - one PID lock at `~/.opensquid/agent-bridge.lock`
 *   - one PID file at `~/.opensquid/agent-bridge.pid`
 *   - one inbox watcher per project (the bridge is project-scoped)
 *
 * Hard-fail-at-start: missing ANTHROPIC_API_KEY, missing pack root,
 * missing project UUID, PID lock already held, bad pack config. Each
 * surface produces a CLEAR message naming the missing field + the
 * `opensquid setup chat` hint per `feedback_opensquid_runtime_failure_handling`.
 *
 * Shutdown order (spec WAB.7): dispatcher → transport → sessionManager →
 * release lock → delete PID file. The dispatcher's shutdown internally
 * drains the BatchCoordinator + awaits in-flight turns, so listing it
 * first stops new turns AND waits for the current one to finish before
 * we tear down the transport. Idempotent — a second call is a no-op.
 *
 * `@anthropic-ai/sdk` is an OPTIONAL peer dep — dynamic-imported at start
 * so non-daemon CLI verbs never pay the cost AND so a missing peer dep
 * throws with an actionable "install @anthropic-ai/sdk" message.
 *
 * Imports from: node:fs/promises, node:os, node:path, proper-lockfile,
 *   ../paths.js, ../../models/load_config.js, ../../packs/loader.js,
 *   ../../rag/backend_factory.js, ./dispatcher.js, ./event_bus.js,
 *   ./pack_binding.js, ./session_manager.js, ./session_persistence.js,
 *   ./transport_bridge.js, ./types.js.
 * Imported by: ./cli.ts (the agent-bridge CLI), test sibling.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { lock as acquireLock } from 'proper-lockfile';

import { loadModelsConfig } from '../../models/load_config.js';
import type { ModelAliasConfig } from '../../models/types.js';
import { loadPack } from '../../packs/loader.js';
import { libsqlQwen3WithLexicalFallback } from '../../rag/backend_factory.js';
import type { RagBackend } from '../../rag/types.js';
import { createResolver, dotenvBackend } from '../../secrets/index.js';
import type { SecretResolver } from '../../secrets/types.js';
import { OPENSQUID_HOME } from '../paths.js';

import type { AnthropicMessageClient } from './agent_loop.js';
import { ChatDispatcher } from './dispatcher.js';
import { AgentEventBus } from './event_bus.js';
import { buildChatToolDispatcher, type BuildChatToolDispatcherResult } from './pack_binding.js';
import { SessionManager } from './session_manager.js';
import { SessionPersistence } from './session_persistence.js';
import { InboxTransportBridge } from './transport_bridge.js';
import type { SessionKey } from './types.js';

// Co-located with the runtime daemon's lock + pid at `~/.opensquid/`.
// Distinct filenames so the agent-bridge daemon can run alongside the
// scheduler daemon without lock contention.
export const agentBridgeLockPath = (): string => join(OPENSQUID_HOME(), 'agent-bridge.lock');
export const agentBridgePidPath = (): string => join(OPENSQUID_HOME(), 'agent-bridge.pid');
export const agentBridgeLogPath = (): string => join(OPENSQUID_HOME(), 'agent-bridge.log');

export interface AgentBridgeDaemonOptions {
  /** Required — the project whose inbox + sessions this daemon serves. */
  projectUuid: string;
  /** Required — absolute path to the pack folder (contains manifest.yaml + chat_agent.yaml). */
  packRoot: string;
  /** Anthropic API key — defaults to process.env.ANTHROPIC_API_KEY. Hard-fails if absent. */
  anthropicApiKey?: string;
  /** Override the daemon-home base (tests). Defaults to OPENSQUID_HOME(). */
  daemonHome?: string;
  /** Override the models config (tests). Defaults to `loadModelsConfig()`. */
  modelsConfig?: Record<string, ModelAliasConfig>;
  /** Override the RAG backend (tests). Defaults to libsql-qwen3+lexical fallback. */
  ragBackend?: RagBackend;
  /** Override the secret resolver (tests). Defaults to an env+dotenv backend
   *  rooted at `~/.loop/.env`. The pack_binding's api-mode strategy uses
   *  this to read ANTHROPIC_API_KEY (and analogous keys). */
  secrets?: SecretResolver;
  /** Inject an Anthropic client (tests). Defaults to dynamic-import + construct. */
  anthropicClient?: AnthropicMessageClient;
  /** Structured warn sink. Defaults to stderr write. */
  onWarn?: (message: string) => void;
  /** Reply hook — fired when the chat agent emits a final reply. Defaults to
   *  no-op (production callers wire this to the legacy chat-daemon RPC; for
   *  WAB.7 the on-disk inbox + outbox plumbing lives upstream). */
  onReply?: (key: SessionKey, replyText: string, projectUuid: string) => void;
}

export class AgentBridgeDaemon {
  private readonly opts: AgentBridgeDaemonOptions;
  private readonly warn: (message: string) => void;
  private state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' = 'idle';
  private release: (() => Promise<void>) | null = null;
  private transport: InboxTransportBridge | null = null;
  private dispatcher: ChatDispatcher | null = null;
  private sessionManager: SessionManager | null = null;
  private bus: AgentEventBus | null = null;
  private signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
  private bindingResult: BuildChatToolDispatcherResult | null = null;

  constructor(opts: AgentBridgeDaemonOptions) {
    this.opts = opts;
    this.warn = opts.onWarn ?? defaultWarn;
  }

  /** Acquire PID lock, wire components, install signal handlers, start
   *  watching the inbox. Atomic — any failure rolls back acquired resources. */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`AgentBridgeDaemon.start: invalid state "${this.state}"`);
    }
    this.state = 'starting';

    // Validate required fields BEFORE acquiring the lock — a missing pack
    // root or project uuid should not leave a lockfile behind.
    if (this.opts.projectUuid.length === 0) {
      this.state = 'idle';
      throw new Error(
        'AgentBridgeDaemon: projectUuid is required. Set OPENSQUID_PROJECT_UUID ' +
          'or create `.opensquid/project.json` via `opensquid setup chat`.',
      );
    }
    if (this.opts.packRoot.length === 0) {
      this.state = 'idle';
      throw new Error(
        'AgentBridgeDaemon: packRoot is required. Set OPENSQUID_PACK_ROOT or ' +
          'run `opensquid setup chat` to install a pack.',
      );
    }
    const apiKey = this.opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    // The injected anthropicClient path skips the key check (tests use it).
    if (apiKey.length === 0 && this.opts.anthropicClient === undefined) {
      this.state = 'idle';
      throw new Error(
        'AgentBridgeDaemon: ANTHROPIC_API_KEY is not set. Run `opensquid setup chat` ' +
          'or export ANTHROPIC_API_KEY before starting the daemon.',
      );
    }

    // proper-lockfile: `realpath: false` lets the target not exist (it mkdirs
    // `.lock/` atomically); `retries: 0` fails fast on contention.
    const home = this.opts.daemonHome ?? OPENSQUID_HOME();
    await mkdir(home, { recursive: true });
    const lockPath = join(home, 'agent-bridge.lock');
    const pidPath = join(home, 'agent-bridge.pid');
    try {
      this.release = await acquireLock(lockPath, { retries: 0, realpath: false });
    } catch (err) {
      this.state = 'idle';
      throw new Error(
        `AgentBridgeDaemon.start: another daemon is already running (lock at ${lockPath}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    try {
      const client = this.opts.anthropicClient ?? (await constructAnthropicClient(apiKey));
      const pack = await loadPack(this.opts.packRoot);
      const modelsConfig = this.opts.modelsConfig ?? (await loadModelsConfig());
      const ragBackend = this.opts.ragBackend ?? defaultRagBackend(home);
      await ragBackend.init();
      // One chat-agent binding per daemon: the pack declares one chat
      // agent so per-session re-binding would only duplicate work.
      const secrets = this.opts.secrets ?? defaultSecretResolver();
      this.bindingResult = await buildChatToolDispatcher({
        pack,
        packRoot: this.opts.packRoot,
        modelsConfig,
        ragBackend,
        secrets,
        onWarn: (m) => this.warn(m),
      });
      const persistence = new SessionPersistence({
        root: join(home, 'agent-bridge', 'sessions'),
        onWarn: (m) => this.warn(m),
      });
      this.sessionManager = new SessionManager({
        persistence,
        defaultPackId: pack.name,
        defaultModelAlias: this.bindingResult.resolvedModel,
      });
      this.bus = new AgentEventBus();
      this.transport = new InboxTransportBridge({
        bus: this.bus,
        projectUuid: this.opts.projectUuid,
        onWarn: (m) => this.warn(m),
      });
      this.dispatcher = new ChatDispatcher({
        bus: this.bus,
        sessionManager: this.sessionManager,
        agentLoopOptions: {
          client,
          model: this.bindingResult.resolvedModel,
          systemPrompt: this.bindingResult.systemPrompt,
          tools: this.bindingResult.dispatcher.list(),
          dispatcher: this.bindingResult.dispatcher,
          maxTokens: this.bindingResult.tunables.maxTokens,
          maxToolIterations: this.bindingResult.tunables.maxToolIterations,
        },
        onWarn: (m) => this.warn(m),
        ...(this.opts.onReply !== undefined ? { onReply: this.opts.onReply } : {}),
      });
      this.dispatcher.start();
      await this.transport.start();
      await writeFile(pidPath, String(process.pid), 'utf8');
      this.installSignalHandlers();
      this.state = 'running';
    } catch (err) {
      // Rollback via shared teardown so reverse order matches shutdown().
      await this.teardown(pidPath);
      this.state = 'idle';
      throw err;
    }
  }

  /** Tear down in spec order. Idempotent — second call is a no-op so signal
   *  handlers + the CLI stop verb can both invoke without coordination. */
  async shutdown(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') return;
    this.state = 'stopping';
    const home = this.opts.daemonHome ?? OPENSQUID_HOME();
    await this.teardown(join(home, 'agent-bridge.pid'));
    this.state = 'stopped';
  }

  /** Test/admin: expose the live binding result for assertions. */
  bindingFor(): BuildChatToolDispatcherResult | null {
    return this.bindingResult;
  }

  // --- private ---

  /** Shared teardown — used by both shutdown() and start()'s rollback path.
   *  Order: dispatcher (drops batch timers + awaits in-flight turn) →
   *  transport (closes watcher + drains tail reads) → sessionManager
   *  (drains LRU, fires onEvict('shutdown')) → release lock → pidfile. */
  private async teardown(pidPath: string): Promise<void> {
    if (this.dispatcher !== null) {
      await safeAsync(() => this.dispatcher?.shutdown() ?? Promise.resolve());
      this.dispatcher = null;
    }
    if (this.transport !== null) {
      await safeAsync(() => this.transport?.shutdown() ?? Promise.resolve());
      this.transport = null;
    }
    if (this.sessionManager !== null) {
      safeSync(() => this.sessionManager?.shutdown());
      this.sessionManager = null;
    }
    if (this.release !== null) {
      await safeAsync(this.release);
      this.release = null;
    }
    await safeAsync(() => rm(pidPath, { force: true }));
    this.uninstallSignalHandlers();
    this.bus = null;
    this.bindingResult = null;
  }

  private installSignalHandlers(): void {
    const make = (): (() => void) => {
      let fired = false;
      return () => {
        if (fired) return;
        fired = true;
        void this.shutdown().then(() => {
          // Give the event loop one tick to flush stderr before exit.
          process.exit(0);
        });
      };
    };
    const sigterm = make();
    const sigint = make();
    process.on('SIGTERM', sigterm);
    process.on('SIGINT', sigint);
    this.signalHandlers = [
      { signal: 'SIGTERM', handler: sigterm },
      { signal: 'SIGINT', handler: sigint },
    ];
  }

  private uninstallSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers = [];
  }
}

const defaultWarn = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

function safeSync(fn: () => void): void {
  try {
    fn();
  } catch {
    /* best-effort */
  }
}
async function safeAsync(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* best-effort */
  }
}

/** Dynamic-import the optional `@anthropic-ai/sdk` peer dep. Throws a clear,
 *  actionable error when the package isn't installed. */
async function constructAnthropicClient(apiKey: string): Promise<AnthropicMessageClient> {
  const moduleName = '@anthropic-ai/sdk';
  let mod: { default: new (opts: { apiKey: string }) => { messages: AnthropicMessageClient } };
  try {
    mod = (await import(moduleName)) as typeof mod;
  } catch (err) {
    throw new Error(
      `AgentBridgeDaemon: @anthropic-ai/sdk is not installed. ` +
        `Install it as a peer dep: \`pnpm add @anthropic-ai/sdk\`. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return new mod.default({ apiKey }).messages;
}

/** libsql-qwen3 with lexical fallback on Ollama-down. Keeps the daemon up
 *  even when the local embedder is offline. */
function defaultRagBackend(home: string): RagBackend {
  const dbUrl = `file:${join(home, 'opensquid.db')}`;
  const ollamaUrl = process.env.OPENSQUID_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  return libsqlQwen3WithLexicalFallback({ dbUrl, ollamaUrl });
}

/** Default secret resolver: env-only + optional `~/.loop/.env` dotenv file.
 *  The dotenv path matches the user's documented config location; the env
 *  backend's process.env-wins behavior means real env vars override the file. */
function defaultSecretResolver(): SecretResolver {
  return createResolver([dotenvBackend({ path: join(homedir(), '.loop', '.env') })]);
}

// Env-resolution helpers (re-used by ./cli.ts).
/** packRoot: explicit env → `~/.opensquid/packs/default`. Existence checked
 *  at daemon start (loadPack throws on missing manifest). */
export function resolvePackRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENSQUID_PACK_ROOT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(env.OPENSQUID_HOME ?? join(homedir(), '.opensquid'), 'packs', 'default');
}

/** projectUuid resolution: env-only here; the cwd-walk for
 *  `.opensquid/project.json` lives in `cli.ts` (cwd-dependent). */
export function resolveProjectUuidFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.OPENSQUID_PROJECT_UUID;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return null;
}
