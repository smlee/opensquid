/**
 * agent_bridge — long-running daemon (WAB.7 + WAB-SUB.2 lazy api client, 0.5.106).
 *
 * Authoritative spec: the warm-agent planning notes [not retained — see docs/tasks/WAB.1-architecture.md, which is] WAB.7 +
 * WAB-SUB.2 §"daemon mode-aware lazy client". Architecture:
 * `docs/tasks/WAB.1-architecture.md` decisions (a)-(g).
 *
 * Wires every WAB.2-WAB.6 component (event bus, transport bridge, session
 * manager, batch coordinator + dispatcher, pack-bound tool dispatcher)
 * into a single long-running process driven by `start()` + `shutdown()`.
 * Owns the daemon-wide singletons:
 *   - one Anthropic SDK client — LAZILY constructed only when the
 *     resolved pack binding is api-mode (WAB-SUB.2 cap on subscription
 *     daemons paying for an unused SDK client + unused ANTHROPIC_API_KEY)
 *   - one PID lock at `~/.opensquid/agent-bridge[-<scope>].lock`
 *   - one PID file at `~/.opensquid/agent-bridge[-<scope>].pid`
 *     (CAT.5.1 — scope = umbrellaId → projectUuid → legacy unscoped, so the
 *      `loop` umbrella + the `general` session run concurrently)
 *   - one inbox watcher per project (the bridge is project-scoped)
 *   - one materialized MCP config at
 *     `~/.opensquid/agent-bridge/mcp-config.json` (subscription mode only)
 *
 * Mode-aware hard-fails (WAB-SUB.2):
 *   - api mode    → missing ANTHROPIC_API_KEY throws "Mode 'api' requires
 *                   ANTHROPIC_API_KEY ..." with setup-chat hint.
 *   - subscription mode → key is NOT required; missing key is silently
 *                         skipped (subscription auth flows through Claude
 *                         Code's own state).
 *   - all modes   → missing pack root / project UUID / PID lock held →
 *                   hard-fail with structured message
 *                   (`feedback_opensquid_runtime_failure_handling`).
 *
 * Shutdown order (spec WAB.7): dispatcher → transport → sessionManager →
 * release lock → delete PID file. The dispatcher's shutdown internally
 * drains the BatchCoordinator + awaits in-flight turns, so listing it
 * first stops new turns AND waits for the current one to finish before
 * we tear down the transport. Idempotent — a second call is a no-op.
 *
 * `@anthropic-ai/sdk` is an OPTIONAL peer dep — dynamic-imported only in
 * the api-mode branch so subscription-mode daemons don't even attempt the
 * import. A subscription pack with NO @anthropic-ai/sdk installed boots
 * cleanly — that's the whole point of mode dispatch.
 *
 * Imports from: node:fs/promises, node:os, node:path, proper-lockfile,
 *   ../paths.js, ../../models/load_config.js, ../../packs/loader.js,
 *   ../../rag/backend_factory.js, ./dispatcher.js, ./event_bus.js,
 *   ./mcp_config.js, ./pack_binding.js, ./session_manager.js,
 *   ./session_persistence.js, ./transport_bridge.js, ./types.js.
 * Imported by: ./cli.ts (the agent-bridge CLI), test sibling.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { lock as acquireLock } from 'proper-lockfile';

import { GENERAL_UMBRELLA } from '../../channels/routing.js';
import { loadModelsConfig } from '../../models/load_config.js';
import type { ModelAliasConfig } from '../../models/types.js';
import { loadPack } from '../../packs/loader.js';
import { libsqlQwen3WithLexicalFallback } from '../../rag/backend_factory.js';
import type { RagBackend } from '../../rag/types.js';
import { createResolver, dotenvBackend } from '../../secrets/index.js';
import type { SecretResolver } from '../../secrets/types.js';
import { OPENSQUID_HOME, resolveBuiltinScopeRoot } from '../paths.js';

import type { AnthropicMessageClient } from './agent_loop.js';
import { ChatDispatcher, type DispatcherAgentLoopOptions } from './dispatcher.js';
import { AgentEventBus } from './event_bus.js';
import { HeadlessLeaseManager, headlessSessionId } from './headless_lease.js';
import { resolveMcpConfigPath } from './mcp_config.js';
import { buildChatToolDispatcher, type BuildChatToolDispatcherResult } from './pack_binding.js';
import { SessionManager } from './session_manager.js';
import { SessionPersistence } from './session_persistence.js';
import { InboxTransportBridge } from './transport_bridge.js';
import type { SessionKey } from './types.js';

// Co-located with the runtime daemon's lock + pid at `~/.opensquid/`.
// Distinct filenames so the agent-bridge daemon can run alongside the
// scheduler daemon without lock contention.
//
// CAT.5.1 — PER-INSTANCE keying. The headless responder must run ALWAYS-ON
// and CONCURRENTLY (the `loop` umbrella + the project-less `general` session
// at the same time), so the daemon's side-files are keyed by a SCOPE string:
//
//   - umbrellaId when set (CAT.5/CAT.6)  → `agent-bridge-<umbrella>.{lock,pid,log}`
//     e.g. `agent-bridge-loop.*`, `agent-bridge-general.*`
//   - else projectUuid (legacy umbrella-less project daemon)
//     → `agent-bridge-<uuid>.*`
//   - neither (no scope derivable) → the LEGACY single-instance filenames
//     `agent-bridge.{lock,pid,log}` (back-compat — the original WAB.7 path).
//
// The scope is filename-sanitized (non-`[A-Za-z0-9._-]` → `_`) so an umbrella
// id or a path-shaped projectUuid can never escape `OPENSQUID_HOME()`.

/** Inputs that select the per-instance scope (umbrella wins over project). */
export interface AgentBridgeScopeKey {
  umbrellaId?: string;
  projectUuid?: string;
}

const sanitizeScope = (scope: string): string => scope.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Derive the side-file scope suffix. `umbrellaId` (CAT.5/6) wins; else
 * `projectUuid` (legacy per-project); else `''` (the legacy single-instance
 * back-compat path). Pure + total.
 */
export function agentBridgeScope(key: AgentBridgeScopeKey = {}): string {
  // Key the side-file stem on the UMBRELLA only. The multi-instance need is
  // umbrella-level (`loop` + `general` headless daemons coexist as
  // `agent-bridge-loop` / `agent-bridge-general`); a plain project-scoped
  // daemon (no umbrella) keeps the legacy single `agent-bridge` stem — only
  // one runs at a time, exactly as before CAT.5. (Suffixing on projectUuid was
  // an over-generalization that diverged from the project-scoped tests.)
  return key.umbrellaId !== undefined && key.umbrellaId.length > 0
    ? sanitizeScope(key.umbrellaId)
    : '';
}

/** `agent-bridge[-<scope>]` filename stem keyed by the scope. */
const agentBridgeStem = (key: AgentBridgeScopeKey = {}): string => {
  const scope = agentBridgeScope(key);
  return scope.length > 0 ? `agent-bridge-${scope}` : 'agent-bridge';
};

export const agentBridgeLockPath = (key: AgentBridgeScopeKey = {}): string =>
  join(OPENSQUID_HOME(), `${agentBridgeStem(key)}.lock`);
export const agentBridgePidPath = (key: AgentBridgeScopeKey = {}): string =>
  join(OPENSQUID_HOME(), `${agentBridgeStem(key)}.pid`);
export const agentBridgeLogPath = (key: AgentBridgeScopeKey = {}): string =>
  join(OPENSQUID_HOME(), `${agentBridgeStem(key)}.log`);

/**
 * Scope-keyed side-file basenames within a given home dir (the daemon resolves
 * its `home` to `daemonHome ?? OPENSQUID_HOME()`, so it joins these itself
 * rather than going through the OPENSQUID_HOME()-rooted helpers above).
 */
const agentBridgeStemIn = (key: AgentBridgeScopeKey): string => agentBridgeStem(key);

export interface AgentBridgeDaemonOptions {
  /**
   * The project whose inbox + sessions this daemon serves. REQUIRED for the
   * normal project-scoped path. EMPTY (`''`) is permitted ONLY in project-less
   * mode (T-CHAT-AS-TERMINAL CAT.6 — `umbrellaId === 'general'` or
   * `projectLess: true`), where the umbrella id is the scope identity instead.
   */
  projectUuid: string;
  /**
   * Owning umbrella id (T-CHAT-AS-TERMINAL CAT.5). When set, the daemon runs
   * UMBRELLA-keyed: the transport watches the umbrella inbox, the dispatcher's
   * arbitration reads the umbrella lease (ownership-aware against the headless
   * id `headless-<umbrellaId>`), and a {@link HeadlessLeaseManager} holds the
   * lease while no human session is live (standing down when one appears).
   * Omitted ⇒ legacy per-project keying (no headless lease handoff).
   *
   * When `umbrellaId === 'general'` the daemon is automatically PROJECT-LESS
   * (CAT.6): the umbrella id is the scope identity and `projectUuid` is not
   * required (the general session has no project by design).
   */
  umbrellaId?: string;
  /**
   * Project-LESS mode (T-CHAT-AS-TERMINAL CAT.6). When true, the daemon runs
   * with NO real project: session-state + tool scoping key off the umbrella id
   * (the scope identity) instead of a project uuid, and the `projectUuid`
   * field is not required (defaults to `''`). Implied when
   * `umbrellaId === 'general'`. The normal project-scoped path is unchanged:
   * omit this (or leave it false) and `projectUuid` stays required.
   */
  projectLess?: boolean;
  /** Required — absolute path to the pack folder (contains manifest.yaml + chat_agent.yaml). */
  packRoot: string;
  /**
   * Anthropic API key — defaults to process.env.ANTHROPIC_API_KEY. Only
   * REQUIRED when the resolved pack binding is api-mode; subscription
   * mode skips the check entirely.
   */
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
  /** Inject an Anthropic client (tests). Defaults to dynamic-import + construct.
   *  In api-mode only — subscription mode never touches this. */
  anthropicClient?: AnthropicMessageClient;
  /**
   * Optional MCP config path override for subscription mode. Defaults to
   * `OPENSQUID_AGENT_BRIDGE_MCP_CONFIG` env → materialize the daemon's
   * default config at `<daemonHome>/agent-bridge/mcp-config.json`. Tests
   * that want to skip the I/O can pass a stub path here.
   */
  mcpConfigPath?: string;
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
  private headlessLease: HeadlessLeaseManager | null = null;
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
    //
    // CAT.6: project-less mode (umbrella='general' or explicit projectLess)
    // keys session-state + tool scoping off the UMBRELLA id, so an empty
    // projectUuid is legal there. The normal project-scoped path is unchanged
    // — a project-keyed daemon (no umbrella, not project-less) still REQUIRES
    // projectUuid.
    if (this.opts.projectUuid.length === 0 && !this.isProjectLess()) {
      this.state = 'idle';
      throw new Error(
        'AgentBridgeDaemon: projectUuid is required. Set OPENSQUID_PROJECT_UUID ' +
          'or create `.opensquid/project.json` via `opensquid setup chat`. ' +
          "(Project-less mode requires umbrellaId='general' or projectLess: true.)",
      );
    }
    if (this.opts.packRoot.length === 0) {
      this.state = 'idle';
      throw new Error(
        'AgentBridgeDaemon: packRoot is required. Set OPENSQUID_PACK_ROOT or ' +
          'run `opensquid setup chat` to install a pack.',
      );
    }
    // proper-lockfile: `realpath: false` lets the target not exist (it mkdirs
    // `.lock/` atomically); `retries: 0` fails fast on contention.
    const home = this.opts.daemonHome ?? OPENSQUID_HOME();
    await mkdir(home, { recursive: true });
    // CAT.5.1 — per-instance keying: lock/pid named by scope (umbrella → project
    // → legacy) so `loop` + `general` coexist without colliding.
    const stem = agentBridgeStemIn(this.scopeKey());
    const lockPath = join(home, `${stem}.lock`);
    const pidPath = join(home, `${stem}.pid`);
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
      // Mode-aware agentLoopOptions: api branch builds the Anthropic
      // client lazily AFTER we know the binding actually needs it;
      // subscription branch materializes the MCP config so the spawned
      // claude can discover opensquid's tools.
      const agentLoopOptions = await this.buildAgentLoopOptions(home);
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
      const umbrellaId = this.opts.umbrellaId;
      this.transport = new InboxTransportBridge({
        bus: this.bus,
        projectUuid: this.opts.projectUuid,
        ...(umbrellaId !== undefined ? { umbrellaId } : {}),
        onWarn: (m) => this.warn(m),
      });
      this.dispatcher = new ChatDispatcher({
        bus: this.bus,
        sessionManager: this.sessionManager,
        agentLoopOptions,
        onWarn: (m) => this.warn(m),
        // CAT.5: umbrella daemons run as the stable headless session id so the
        // dispatcher's ownership guard answers ONLY while WE hold the umbrella
        // lease (and resume threads the same session). Default arbitration
        // reads the umbrella lease ownership-aware against this id.
        ...(umbrellaId !== undefined ? { ownSessionId: headlessSessionId(umbrellaId) } : {}),
        ...(this.opts.onReply !== undefined ? { onReply: this.opts.onReply } : {}),
      });
      this.dispatcher.start();
      await this.transport.start();
      // CAT.5: hold the umbrella's chat lease while no human session is live.
      // acquireIfFree + a 30s fs-only heartbeat (zero idle token cost).
      if (umbrellaId !== undefined) {
        this.headlessLease = new HeadlessLeaseManager({
          umbrellaId,
          onWarn: (m) => this.warn(m),
        });
        await this.headlessLease.start();
      }
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

  /**
   * Build the dispatcher's mode-aware agentLoopOptions. Lazy api-client
   * construction lives here so subscription-mode daemons never touch
   * `@anthropic-ai/sdk` (nor require ANTHROPIC_API_KEY). Subscription mode
   * resolves the MCP config path so the spawned claude can reach
   * opensquid's MCP servers.
   *
   * Throws on api-mode start if no API key + no injected client. Throws on
   * subscription-mode start if MCP config materialization fails. Both
   * happen during the daemon's start() try/catch which rolls back the
   * lock + binding.
   */
  private async buildAgentLoopOptions(home: string): Promise<DispatcherAgentLoopOptions> {
    if (this.bindingResult === null) {
      throw new Error('AgentBridgeDaemon.buildAgentLoopOptions: binding result is null');
    }
    const binding = this.bindingResult;
    const runner = binding.runner;
    if (runner.mode === 'api') {
      const apiKey = this.opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
      // The injected anthropicClient path skips the key check (tests use it).
      if (apiKey.length === 0 && this.opts.anthropicClient === undefined) {
        throw new Error(
          "AgentBridgeDaemon: Mode 'api' requires ANTHROPIC_API_KEY in env / secrets " +
            'backend. Run `opensquid setup chat` or export ANTHROPIC_API_KEY before ' +
            'starting the daemon (or switch the pack to mode=subscription).',
        );
      }
      const client = this.opts.anthropicClient ?? (await constructAnthropicClient(apiKey));
      return {
        mode: 'api',
        client,
        model: runner.model,
        systemPrompt: binding.systemPrompt,
        tools: binding.dispatcher.list(),
        dispatcher: binding.dispatcher,
        maxTokens: binding.tunables.maxTokens,
        maxToolIterations: binding.tunables.maxToolIterations,
      };
    }
    if (runner.mode === 'subscription') {
      const mcpConfigPath = await resolveMcpConfigPath({
        ...(this.opts.mcpConfigPath !== undefined ? { explicitPath: this.opts.mcpConfigPath } : {}),
        daemonHome: home,
      });
      return {
        mode: 'subscription',
        cli: runner.cli,
        args: runner.args,
        mcpConfigPath,
        systemPrompt: binding.systemPrompt,
      };
    }
    // Exhaustiveness — pack_binding's resolveRunnerOrThrow rejects
    // unimplemented modes before we get here, but a future addition to
    // the union would trip this at compile time.
    return assertNever(runner);
  }

  /** Tear down in spec order. Idempotent — second call is a no-op so signal
   *  handlers + the CLI stop verb can both invoke without coordination. */
  async shutdown(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') return;
    this.state = 'stopping';
    const home = this.opts.daemonHome ?? OPENSQUID_HOME();
    await this.teardown(join(home, `${agentBridgeStemIn(this.scopeKey())}.pid`));
    this.state = 'stopped';
  }

  /** This daemon's scope key (umbrella → project) for side-file naming. */
  private scopeKey(): AgentBridgeScopeKey {
    return {
      ...(this.opts.umbrellaId !== undefined ? { umbrellaId: this.opts.umbrellaId } : {}),
      projectUuid: this.opts.projectUuid,
    };
  }

  /** Test/admin: expose the live binding result for assertions. */
  bindingFor(): BuildChatToolDispatcherResult | null {
    return this.bindingResult;
  }

  /**
   * CAT.6 — true when the daemon runs project-less (no real project; the
   * umbrella id is the scope identity). Project-less is signalled either by the
   * reserved `general` umbrella or an explicit `projectLess: true` opt. Pure
   * function of the options — used by `start()`'s guard + scope-key derivation.
   */
  private isProjectLess(): boolean {
    return this.opts.projectLess === true || this.opts.umbrellaId === GENERAL_UMBRELLA;
  }

  // --- private ---

  /** Shared teardown — used by both shutdown() and start()'s rollback path.
   *  Order: dispatcher (drops batch timers + awaits in-flight turn) →
   *  headlessLease (stop heartbeat + release our hold) → transport (closes
   *  watcher + drains tail reads) → sessionManager (drains LRU, fires
   *  onEvict('shutdown')) → release lock → pidfile. */
  private async teardown(pidPath: string): Promise<void> {
    if (this.dispatcher !== null) {
      await safeAsync(() => this.dispatcher?.shutdown() ?? Promise.resolve());
      this.dispatcher = null;
    }
    // CAT.5: stop the heartbeat + release OUR hold (only if still ours) so a
    // freshly-opened terminal isn't blocked by a stale headless lease.
    if (this.headlessLease !== null) {
      await safeAsync(() => this.headlessLease?.stop() ?? Promise.resolve());
      this.headlessLease = null;
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

/**
 * CAT.6 packRoot for the project-less general session: the built-in `general`
 * pack (`packs/builtin/general/`). `OPENSQUID_GENERAL_PACK_ROOT` wins for test
 * isolation / an operator override; otherwise it resolves under the built-in
 * scope root (`resolveBuiltinScopeRoot()`).
 */
export function resolveGeneralPackRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENSQUID_GENERAL_PACK_ROOT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(resolveBuiltinScopeRoot(), 'general');
}

/** Compile-time exhaustiveness helper for the mode discriminator switch. */
function assertNever(x: never): never {
  throw new Error(
    `AgentBridgeDaemon: unhandled runner mode '${(x as { mode: string }).mode}' — ` +
      `run \`opensquid setup chat\` to choose api or subscription.`,
  );
}
