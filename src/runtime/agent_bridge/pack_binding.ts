/**
 * agent_bridge — pack binding (WAB.6).
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` WAB.6
 * §"pack_binding.ts". Architecture: `docs/tasks/WAB.1-architecture.md`
 * decisions (e) + (g).
 *
 * Responsibility:
 *   `buildChatToolDispatcher({ pack, packRoot, modelsConfig, ragBackend, ... })`
 *   reads the pack's `chat_agent.yaml` (or its built-in fallback when the
 *   pack didn't ship one), resolves the model alias to a concrete model id,
 *   loads the system prompt (file path → file contents, or built-in
 *   default), filters built-in tools per `disable_builtins`, opts in any
 *   declared skills (warn-and-skip on unknown), and returns a
 *   `SimpleToolDispatcher` plus the runtime tunables the agent loop needs.
 *
 * Hard-fail surface:
 *   - The pack's `default_model` alias is not declared in `modelsConfig` →
 *     throw with a clear message naming the alias.
 *   - The alias resolves to a mode other than `api` → throw with the spec's
 *     exact error message format pointing at `opensquid setup chat`. The
 *     WAB.4 agent loop only supports `api` mode (the tool-use round-trip
 *     uses Anthropic's stable Messages contract); subscription / local /
 *     MCP modes do not expose the round-trip and would silently fail.
 *
 * Non-responsibility:
 *   - Does NOT construct the Anthropic SDK client (one daemon-wide client,
 *     per WAB.1 decision (c)).
 *   - Does NOT instantiate the `RagBackend` — that's a per-daemon resource
 *     wired by WAB.7.
 *   - Does NOT call `setup`. Misconfiguration surfaces as a thrown error
 *     at bind-time; the operator runs setup themselves.
 *
 * Unknown-skill semantics (WAB.1 (e) lock + WIZ.1 open-question resolution):
 *   `chat_agent.skills: [name]` entries that don't appear in the pack's
 *   `skills/` directory are skipped with a structured warn via the optional
 *   `onWarn` callback. The chat agent still loads; the user's setup UI is
 *   the right place to surface "you wrote `subagent_call` but no such skill
 *   exists" — failing the bind here would block the entire warm-agent path
 *   on a single typo.
 *
 * Imports from: ../../models/dispatcher.js, ../../packs/schemas/chat_agent.js,
 *   ./tool_dispatcher.js, ./tools/index.js, ./types.js, node:fs/promises,
 *   node:path.
 * Imported by: future daemon.ts (WAB.7), test sibling.
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

export interface BuildChatToolDispatcherResult {
  dispatcher: ToolDispatcher;
  systemPrompt: string;
  /** Resolved concrete model id (e.g. `claude-haiku-4-5-20251001`). */
  resolvedModel: string;
  tunables: {
    maxToolIterations: number;
    maxTokens: number;
  };
}

// ---------------------------------------------------------------------------
// buildChatToolDispatcher — public entry point.
// ---------------------------------------------------------------------------

export async function buildChatToolDispatcher(
  opts: BuildChatToolDispatcherOptions,
): Promise<BuildChatToolDispatcherResult> {
  const chatAgent = opts.pack.chatAgent ?? FALLBACK_CHAT_AGENT;
  const warn = opts.onWarn ?? noopWarn;

  // 1. Resolve model alias. The agent loop's contract requires a concrete
  //    model id string and only supports api-mode round-trips today.
  const resolvedModel = resolveModelOrThrow(
    chatAgent.default_model,
    opts.modelsConfig,
    opts.secrets,
  );

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
    resolvedModel,
    tunables: {
      maxToolIterations: chatAgent.max_tool_iterations,
      maxTokens: chatAgent.max_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// resolveModelOrThrow — alias → concrete model id.
//
// Hard-fails on:
//   - alias missing from `modelsConfig`.
//   - alias declared but `mode !== 'api'` (the WAB.4 agent loop only
//     supports api-mode round-trips today).
//   - alias declared as api mode but `model` field missing (api strategies
//     need a concrete model id; surfacing here is friendlier than letting
//     the api strategy throw mid-turn).
//
// `resolveStrategy` is called BUT its return value is intentionally
// discarded — we use it for its side-effect of validating the strategy's
// constructor preconditions (e.g. api mode missing `provider` throws
// upfront). The actual SDK client used by the agent loop is daemon-wide.
// ---------------------------------------------------------------------------

function resolveModelOrThrow(
  alias: string,
  modelsConfig: Record<string, ModelAliasConfig>,
  secrets?: SecretResolver,
): string {
  const cfg = modelsConfig[alias];
  if (cfg === undefined) {
    throw new Error(
      `Chat agent uses model alias '${alias}' which is not declared in models.yaml. ` +
        `Run \`opensquid setup chat\` to configure an API model alias.`,
    );
  }
  if (cfg.mode !== 'api') {
    throw new Error(
      `Chat agent uses model alias '${alias}' which is configured for mode '${cfg.mode}'. ` +
        `The chat bridge currently only supports \`mode: api\`. ` +
        `Run \`opensquid setup chat\` to configure an API model alias.`,
    );
  }
  if (cfg.model === undefined || cfg.model.length === 0) {
    throw new Error(
      `Chat agent uses model alias '${alias}' (mode=api) but \`model\` field is missing — ` +
        `api strategies require a concrete model id. ` +
        `Run \`opensquid setup chat\` to fix the alias.`,
    );
  }
  // Validate strategy-constructor preconditions (e.g. provider field) by
  // resolving the strategy and discarding the handle.
  resolveStrategy(alias, cfg, secrets);
  return cfg.model;
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
