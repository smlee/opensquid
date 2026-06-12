/**
 * agent_bridge — pack binding (WAB.6 + WAB-SUB.2 mode dispatcher, 0.5.106).
 *
 * Specs: the warm-agent planning notes (not retained — docs/tasks/WAB.1-architecture.md is the surviving authority) WAB.6 §"pack_binding.ts"
 * + WAB-SUB.2 §"mode dispatcher". Architecture: `WAB.1-architecture.md`
 * decisions (e) + (g).
 *
 * Responsibility:
 *   `buildChatToolDispatcher` reads the pack's `chat_agent.yaml` (or a
 *   built-in fallback), resolves the model alias to a discriminated
 *   `runner` descriptor (api vs subscription), loads the system prompt,
 *   filters built-in tools per `disable_builtins`, opts in skills
 *   (warn-and-skip on unknown), and returns a `SimpleToolDispatcher` +
 *   the runtime tunables.
 *
 * Mode dispatch (WAB-SUB.2): both `api` and `subscription` are first-class.
 * The dispatcher switches on `runner.mode` once per turn — `api` calls
 * `runAgentTurn`, `subscription` calls `runAgentTurnSubscription`. Future
 * modes (local, mcp) throw "mode not yet implemented" with a setup-chat hint.
 *
 * Hard-fails: alias missing from modelsConfig; api mode missing `model`;
 * subscription mode missing `cli`; mode = local | mcp (unimplemented).
 *
 * Non-responsibility: does NOT construct the Anthropic SDK client (lazy in
 * daemon.ts), does NOT instantiate RagBackend (daemon-owned), does NOT call
 * setup (misconfiguration surfaces as a thrown error).
 *
 * Imports from: ../../models/dispatcher.js, ../../packs/schemas/chat_agent.js,
 *   ./tool_dispatcher.js, ./tools/index.js, ./types.js, node:fs/promises,
 *   node:path.
 * Imported by: daemon.ts, test sibling.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { resolveStrategy } from '../../models/dispatcher.js';
import type { ModelAliasConfig } from '../../models/types.js';
import type { Pack } from '../../runtime/types.js';
import type { RagBackend } from '../../rag/types.js';
import type { ChatAgentConfig } from '../../packs/schemas/chat_agent.js';
import type { SecretResolver } from '../../secrets/types.js';

import { SimpleToolDispatcher, type ToolRegistration } from './tool_dispatcher.js';
import {
  BUILT_INS,
  chatSendSpec,
  defaultDaemonSend,
  makeChatSendHandler,
  makeRecallHandler,
  makeStoreLessonHandler,
  recallSpec,
  storeLessonSpec,
  type DaemonSendFn,
  type MakeStoreLessonHandlerOptions,
} from './tools/index.js';
import type { ToolDispatcher, ToolHandler, ToolSpec } from './types.js';

// ---------------------------------------------------------------------------
// Built-in defaults — used when the pack ships no `chat_agent.yaml`.
//
// `default_model` defaults to `fast_chat` (the suggested alias name in
// the WIZ.4 setup wizard and the WAB.6 spec). If the user's
// `models.yaml` does not declare that alias, the resolver throws — the
// no-side-file path still requires a valid alias to function. Built-ins
// listed are the three sealed names with all bounds at the schema's
// defaults.
// ---------------------------------------------------------------------------

const FALLBACK_CHAT_AGENT: ChatAgentConfig = {
  default_model: 'fast_chat',
  skills: [],
  disable_builtins: [],
  max_tool_iterations: 8,
  max_tokens: 1024,
};

/** Terse built-in system prompt — used when no `system_prompt` path declared. */
const DEFAULT_SYSTEM_PROMPT =
  "You are a chat-agent embedded in opensquid's warm-agent loop. " +
  'Reply concisely. Use the `chat_send` tool to deliver your final answer to the user. ' +
  'Use `recall` to look up project memories when relevant. Use `store_lesson` ' +
  'to capture user-validated workflow / preference / skill_upgrade lessons for later review.';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BuildChatToolDispatcherOptions {
  /** The loaded pack (output of `loadPack`). */
  pack: Pack;
  /** Absolute path to the pack folder (for resolving `system_prompt` files). */
  packRoot: string;
  /** User's `models.yaml` content (alias → ModelAliasConfig). */
  modelsConfig: Record<string, ModelAliasConfig>;
  /** RAG backend shared across all sessions for the `recall` tool. */
  ragBackend: RagBackend;
  /** Required by `api` mode strategies — throws if absent and alias is api. */
  secrets?: SecretResolver;
  /** Override daemon-send for `chat_send` (tests). */
  daemonSend?: DaemonSendFn;
  /** Override store_lesson clock + path resolution (tests). */
  storeLessonOpts?: MakeStoreLessonHandlerOptions;
  /** Structured warn sink — unknown skill names + future degraded signals. */
  onWarn?: (message: string) => void;
}

/**
 * Resolved agent-turn runner — discriminated union the dispatcher branches
 * on. `api` carries the concrete model id; `subscription` carries the CLI
 * binary + base args from `models.yaml`. Both modes are first-class.
 */
export type ResolvedAgentTurn =
  | { mode: 'api'; model: string }
  | { mode: 'subscription'; cli: string; args: string[] };

export interface BuildChatToolDispatcherResult {
  dispatcher: ToolDispatcher;
  systemPrompt: string;
  /** Daemon + dispatcher switch on `.mode` to pick runAgentTurn vs runAgentTurnSubscription. */
  runner: ResolvedAgentTurn;
  /** Human-readable model label: concrete model id (api) or cli name (subscription).
   *  Convenience for telemetry/session-manager so they don't switch on the union. */
  resolvedModel: string;
  tunables: { maxToolIterations: number; maxTokens: number };
}

// ---------------------------------------------------------------------------
// buildChatToolDispatcher — public entry point.
// ---------------------------------------------------------------------------

export async function buildChatToolDispatcher(
  opts: BuildChatToolDispatcherOptions,
): Promise<BuildChatToolDispatcherResult> {
  const chatAgent = opts.pack.chatAgent ?? FALLBACK_CHAT_AGENT;
  const warn = opts.onWarn ?? noopWarn;

  // 1. Resolve model alias to a discriminated runner descriptor. Both api
  //    and subscription modes are first-class; local/mcp throw with the
  //    setup-chat hint per WAB-SUB.2.
  const runner = resolveRunnerOrThrow(chatAgent.default_model, opts.modelsConfig, opts.secrets);
  const resolvedModel = runner.mode === 'api' ? runner.model : runner.cli;

  // 2. Load system prompt — pack-relative file, or built-in default.
  const systemPrompt = await loadSystemPrompt(chatAgent.system_prompt, opts.packRoot);

  // 3. Build the tool list:
  //    - Built-ins minus `disable_builtins`.
  //    - Plus any pack-declared `skills` that map to known well-known
  //      tool names (currently none — schema accepts arbitrary strings;
  //      warn-and-skip on every entry today). Reserved for future opt-in
  //      skill tools (e.g. `subagent_call`, `llm_classify` exposed as
  //      tools rather than internal primitives).
  const registrations = collectBuiltIns(chatAgent, opts);
  for (const skillName of chatAgent.skills) {
    warn(`[agent_bridge.pack_binding] unknown opt-in skill name '${skillName}' — skipping`);
  }

  const dispatcher = new SimpleToolDispatcher(registrations);

  return {
    dispatcher,
    systemPrompt,
    runner,
    resolvedModel,
    tunables: {
      maxToolIterations: chatAgent.max_tool_iterations,
      maxTokens: chatAgent.max_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// resolveRunnerOrThrow — alias → discriminated runner descriptor.
//
// api → validate `model` non-empty + resolveStrategy() for provider check.
// subscription → validate `cli` non-empty + resolveStrategy() for impl check.
// local | mcp → throws "mode not yet implemented" + setup-chat hint.
//
// resolveStrategy's return value is discarded — we call it for its side-
// effect of validating strategy preconditions (provider for api, impl for
// subscription). The actual SDK client (api) / spawn (subscription) is
// constructed downstream in daemon.ts / agent_loop_subscription.ts.
// ---------------------------------------------------------------------------

function resolveRunnerOrThrow(
  alias: string,
  modelsConfig: Record<string, ModelAliasConfig>,
  secrets?: SecretResolver,
): ResolvedAgentTurn {
  const cfg = modelsConfig[alias];
  if (cfg === undefined) {
    throw new Error(
      `Chat agent uses model alias '${alias}' which is not declared in models.yaml. ` +
        `Run \`opensquid setup chat\` to configure an api or subscription model alias.`,
    );
  }
  if (cfg.mode === 'api') {
    if (cfg.model === undefined || cfg.model.length === 0) {
      throw new Error(
        `Chat agent uses model alias '${alias}' (mode=api) but \`model\` field is missing — ` +
          `api strategies require a concrete model id. ` +
          `Run \`opensquid setup chat\` to fix the alias.`,
      );
    }
    // Validate strategy-constructor preconditions (e.g. provider field).
    resolveStrategy(alias, cfg, secrets);
    return { mode: 'api', model: cfg.model };
  }
  if (cfg.mode === 'subscription') {
    if (cfg.cli === undefined || cfg.cli.length === 0) {
      throw new Error(
        `Chat agent uses model alias '${alias}' (mode=subscription) but \`cli\` field is missing — ` +
          `subscription strategies require a binary name or path. ` +
          `Run \`opensquid setup chat\` to fix the alias.`,
      );
    }
    // Validate strategy-constructor preconditions (impl branch).
    resolveStrategy(alias, cfg, secrets);
    return { mode: 'subscription', cli: cfg.cli, args: cfg.args ?? [] };
  }
  // Future modes (local, mcp) reserved — emit the setup-chat hint.
  throw new Error(
    `Chat agent uses model alias '${alias}' (mode='${cfg.mode}'): mode not yet implemented ` +
      `in v1. Run \`opensquid setup chat\` to choose api or subscription.`,
  );
}

// ---------------------------------------------------------------------------
// loadSystemPrompt — pack-relative file read, or built-in default.
//
// Empty / undefined path → built-in default prompt. An absolute path is
// honored as-is (escape hatch for shared system prompts living outside
// the pack root); a relative path is joined against `packRoot`. File
// errors propagate verbatim — a `system_prompt:` declaration that points
// at a missing file is a configuration bug we want to surface loudly.
// ---------------------------------------------------------------------------

async function loadSystemPrompt(promptPath: string | undefined, packRoot: string): Promise<string> {
  if (promptPath === undefined || promptPath.length === 0) return DEFAULT_SYSTEM_PROMPT;
  const abs = isAbsolute(promptPath) ? promptPath : resolve(packRoot, promptPath);
  const raw = await readFile(abs, 'utf8');
  return raw.trim();
}

// ---------------------------------------------------------------------------
// collectBuiltIns — apply `disable_builtins` filter, return ToolRegistrations.
//
// Ordering matches `BUILT_INS` (chat_send, recall, store_lesson) so
// `dispatcher.list()` returns them in that order — matching the schema's
// enum order so docs + setup-UI prompts stay aligned.
// ---------------------------------------------------------------------------

function collectBuiltIns(
  chatAgent: ChatAgentConfig,
  opts: BuildChatToolDispatcherOptions,
): ToolRegistration[] {
  const disabled = new Set(chatAgent.disable_builtins);
  const out: ToolRegistration[] = [];
  for (const name of BUILT_INS) {
    if (disabled.has(name)) continue;
    out.push(buildBuiltIn(name, opts));
  }
  return out;
}

function buildBuiltIn(name: string, opts: BuildChatToolDispatcherOptions): ToolRegistration {
  switch (name) {
    case 'chat_send':
      return {
        spec: chatSendSpec satisfies ToolSpec,
        handler: makeChatSendHandler(opts.daemonSend ?? defaultDaemonSend) satisfies ToolHandler,
      };
    case 'recall':
      return {
        spec: recallSpec satisfies ToolSpec,
        handler: makeRecallHandler(opts.ragBackend) satisfies ToolHandler,
      };
    case 'store_lesson':
      return {
        spec: storeLessonSpec satisfies ToolSpec,
        handler: makeStoreLessonHandler(opts.storeLessonOpts ?? {}) satisfies ToolHandler,
      };
    default:
      // Compile-time exhaustiveness: `BUILT_INS` is `readonly BuiltinToolName[]`,
      // and the switch covers all three enum values. A future addition to
      // the enum would trip this and force the maintainer to update the
      // factory map alongside the schema.
      throw new Error(`pack_binding: built-in '${name}' has no factory registered`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopWarn: (message: string) => void = () => {
  /* default sink */
};
