/**
 * agent_bridge — agent loop core (WAB.4, 0.5.97).
 *
 * Authoritative spec: the warm-agent planning notes (not retained — docs/tasks/WAB.1-architecture.md is the surviving authority) WAB.4.
 * Architecture: `docs/tasks/WAB.1-architecture.md` decisions (c) + (g).
 *
 * Responsibility:
 *   Drive a single agent turn against the Anthropic Messages API:
 *     1. Take the persisted `state.history`, append the inbound user
 *        message to a working copy (do NOT mutate `state`).
 *     2. Apply cache_control markers to the system prompt + the last
 *        two USER messages in the working history (Anthropic's
 *        prompt-cache breakpoint policy — see comment below).
 *     3. Loop `messages.create` → assistant block → if `stop_reason`
 *        is `'tool_use'`, dispatch tools, append `tool_result` blocks
 *        back to working history, repeat. Otherwise return.
 *     4. Cap at `MAX_TOOL_ITERATIONS=8` round-trips; throw on overflow.
 *     5. Return the NEW history entries (user input + every assistant
 *        block + tool_result blocks) plus the final reply text. Caller
 *        feeds these into `SessionManager.appendTurn` which atomically
 *        persists + mutates state.
 *
 * Decision (c) lock (WAB.1):
 *   The Anthropic SDK client is passed in via `opts.client` — there is
 *   exactly ONE daemon-wide client. We do NOT construct or hold one
 *   here. This keeps connection pooling sane (one HTTP agent across all
 *   sessions) and matches Hermes's `_get_or_create_agent` pattern.
 *
 * Decision (g) lock (WAB.1):
 *   `opts.model` is a fully-resolved string (e.g.
 *   `claude-haiku-4-5-20251001`) — alias resolution happens upstream in
 *   WAB.6's `pack_binding.ts`. This module is model-neutral; it never
 *   inspects the string. v1 supports `api` mode only because the
 *   subscription/local/MCP modes don't expose a tool-use round-trip.
 *
 * Cache-control marker policy (Anthropic prompt caching):
 *   - System prompt: ALWAYS marked (1 breakpoint). Most stable thing
 *     across turns — the agent's identity + tool surface description.
 *   - Last 2 user messages: marked on the FINAL content block of each
 *     (2 breakpoints). This keeps the previous-turn context warm
 *     through the current turn so a follow-up message hits the cache.
 *   - Total: 3 of Anthropic's 4-breakpoint limit. We reserve the 4th
 *     for a future tools-section marker.
 *   - 5-minute TTL: Anthropic's default. We do not refresh — sessions
 *     idle longer than 5 min lose the cache (WAB.1 risk callout
 *     accepted this).
 *
 * SDK type compatibility:
 *   `@anthropic-ai/sdk` v0.30.1's STABLE `messages.d.ts` does NOT
 *   include `cache_control` on content-block params (only the `beta`
 *   namespace does). The API itself accepts `cache_control` on the
 *   stable endpoint — prompt caching went GA mid-2024 and the SDK
 *   types haven't caught up on v0.30. To avoid forcing the upgrade or
 *   binding ourselves to the beta path, we use a STRUCTURAL contract
 *   (`AnthropicMessageClient`) below — opensquid owns the types, the
 *   real SDK client satisfies the contract structurally. No `any`, no
 *   `as never` casts at the API boundary.
 *
 * Imports from: ./types.js.
 * Imported by: dispatcher.ts (WAB.5 — glue), daemon.ts (WAB.7),
 *   agent_loop.test.ts.
 */

import { DEFAULT_WARN_OFFSET, ResourceFloor } from '../guard/resource_floor.js';

import type {
  ChatHistoryContentBlock,
  ChatHistoryEntry,
  SessionState,
  ToolDispatcher,
  ToolSpec,
} from './types.js';

// ---------------------------------------------------------------------------
// Tunables — exposed at module top so ops + the audit pass can find them.
// ---------------------------------------------------------------------------

/** Hard cap on tool-use round-trips per turn. Throws on overflow. */
export const MAX_TOOL_ITERATIONS = 8;

/** Default `max_tokens` for the assistant's reply. Overridable per call. */
export const DEFAULT_MAX_TOKENS = 1024;

/** Number of trailing user messages to mark with cache_control. */
export const CACHE_BREAKPOINT_USER_MSGS = 2;

// ---------------------------------------------------------------------------
// AnthropicMessageClient — structural contract.
//
// Matches the slice of `@anthropic-ai/sdk`'s `Anthropic.messages.create`
// we actually use. Carries `cache_control` on the param blocks because
// the real API accepts it even though the stable SDK types omit it.
//
// Tests inject a stub that satisfies this contract; production code
// passes the real SDK's `client.messages` property (structural-typing
// match — TypeScript does NOT require an explicit cast at the daemon
// boundary as long as the SDK's stable signature is a strict superset
// of the fields we read).
// ---------------------------------------------------------------------------

export interface AnthropicCacheControl {
  type: 'ephemeral';
}

export interface AnthropicTextBlockParam {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolUseBlockParam {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  cache_control?: AnthropicCacheControl;
}

export type AnthropicContentBlockParam =
  | AnthropicTextBlockParam
  | AnthropicToolUseBlockParam
  | AnthropicToolResultBlockParam;

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: AnthropicContentBlockParam[];
}

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicResponseTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicResponseToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export type AnthropicResponseBlock = AnthropicResponseTextBlock | AnthropicResponseToolUseBlock;

export interface AnthropicMessageResponse {
  content: AnthropicResponseBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
}

export interface AnthropicMessageCreateParams {
  model: string;
  max_tokens: number;
  system: AnthropicSystemBlock[];
  tools: ToolSpec[];
  messages: AnthropicMessageParam[];
}

export interface AnthropicMessageClient {
  create(params: AnthropicMessageCreateParams): Promise<AnthropicMessageResponse>;
}

// ---------------------------------------------------------------------------
// runAgentTurn options
// ---------------------------------------------------------------------------

export interface RunAgentTurnOptions {
  /** Daemon-wide Anthropic `client.messages` (one instance per daemon). */
  client: AnthropicMessageClient;
  /** Resolved model id (alias resolution upstream in WAB.6). */
  model: string;
  /** Assistant system prompt (loaded from pack `chat_agent.yaml` in WAB.6). */
  systemPrompt: string;
  /** Tool surface — typically `dispatcher.list()`. */
  tools: ToolSpec[];
  /** Resolves `tool_use` blocks from the model. */
  dispatcher: ToolDispatcher;
  /** Override `DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** Override `MAX_TOOL_ITERATIONS`. */
  maxToolIterations?: number;
  /** Resource-floor warn offset (iterations before the cap at which `warn` fires; default 1 ⇒ cap-1). */
  warnOffset?: number;
  /** Injected clock (tests). Defaults to `() => new Date().toISOString()`. */
  nowIso?: () => string;
}

// ---------------------------------------------------------------------------
// runAgentTurn — the only export consumed by callers (the SDK contract
// types above are exported for reuse by tests + future MCP-tool delegators).
// ---------------------------------------------------------------------------

export interface RunAgentTurnResult {
  /** New entries appended during this turn (user input + assistant + tool_results). */
  assistantEntries: ChatHistoryEntry[];
  /** Final text reply (concatenated text blocks from the terminal assistant message). */
  replyText: string;
  /** Set ⟺ the Resource floor halted the turn at the iteration cap (T2). The sole caller
   *  (`dispatcher.ts`) branches on this to surface the halt — it is NOT a normal reply. */
  halted?: { floor: 'resource'; reason: string };
}

export async function runAgentTurn(
  state: SessionState,
  inboundText: string,
  opts: RunAgentTurnOptions,
): Promise<RunAgentTurnResult> {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxIter = opts.maxToolIterations ?? MAX_TOOL_ITERATIONS;

  // 1. Build the inbound user message + working history copy.
  //    We do NOT mutate state.history — the caller's SessionManager
  //    .appendTurn owns the atomic persist-then-mutate. If we threw
  //    mid-loop, the caller's catch leaves state untouched.
  const inboundEntry: ChatHistoryEntry = {
    role: 'user',
    content: [{ type: 'text', text: inboundText }],
    timestamp: nowIso(),
  };
  const working: ChatHistoryEntry[] = [...state.history, inboundEntry];

  // 2. Track which entries get the cache_control marker. We recompute
  //    every iteration (because tool_result entries get appended mid-
  //    loop), but the user-message indices are stable across the
  //    current turn — the inbound message is the most recent user
  //    entry; the prior one (if any) is the previous turn's user
  //    message; older entries are NOT marked.
  //
  //    Note: tool_result entries are role='user' to the API but they're
  //    NOT human input — including them in the cache-mark set wastes a
  //    breakpoint on transient mid-turn content. We filter to entries
  //    that have at least one `text` block (real human input).
  const newEntries: ChatHistoryEntry[] = [inboundEntry];
  let lastResponse: AnthropicMessageResponse | undefined;

  // T2 — the Resource floor: the iteration budget is a floor EMISSION, not a raw throw. `observe()` at
  // the top of each lap returns `halt` AT the cap (⇒ a typed `halted` return the sole caller surfaces),
  // or `warn` approaching it. In-memory: one runAgentTurn = one process, nothing to persist.
  const resourceFloor = new ResourceFloor({
    cap: maxIter,
    warnOffset: opts.warnOffset ?? DEFAULT_WARN_OFFSET,
  });

  for (;;) {
    if (resourceFloor.observe() === 'halt') {
      // budget reached — END the turn with a typed halt (no `throw`; the caller branches on `halted`).
      const reason = `resource floor: reached MAX_TOOL_ITERATIONS=${maxIter} (last stop_reason=${
        lastResponse?.stop_reason ?? 'never-called'
      })`;
      return {
        assistantEntries: newEntries,
        replyText: `Stopped: ${reason}.`,
        halted: { floor: 'resource', reason },
      };
    }
    const cacheTargets = pickCacheTargets(working);
    const request: AnthropicMessageCreateParams = {
      model: opts.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: opts.tools,
      messages: working.map((entry, i) => toRequestMessage(entry, cacheTargets.has(i))),
    };

    const response = await opts.client.create(request);
    lastResponse = response;

    // 3. Persist the assistant turn into both working history (for the
    //    next iteration's messages array) and newEntries (return value).
    const assistantEntry: ChatHistoryEntry = {
      role: 'assistant',
      content: response.content.map(fromResponseBlock),
      timestamp: nowIso(),
    };
    working.push(assistantEntry);
    newEntries.push(assistantEntry);

    // 4. Terminal? Return.
    if (response.stop_reason !== 'tool_use') {
      const replyText = extractTextReply(response);
      return { assistantEntries: newEntries, replyText };
    }

    // 5. Tool-use round — dispatch every tool_use block, collect
    //    results into ONE user message (per Anthropic's convention).
    const toolResults: ChatHistoryContentBlock[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let resultText: string;
      try {
        resultText = await opts.dispatcher.call(block.name, block.input, {
          sessionKey: state.key,
          projectUuid: state.projectUuid,
        });
      } catch (err) {
        // Surface the error back to the model as the tool_result —
        // some tools' failures are recoverable (the model can retry
        // with different args). Throwing here would abort the turn
        // entirely.
        resultText = `tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: resultText,
      });
    }
    const toolResultEntry: ChatHistoryEntry = {
      role: 'user',
      content: toolResults,
      timestamp: nowIso(),
    };
    working.push(toolResultEntry);
    newEntries.push(toolResultEntry);
  }
  // unreachable: the `for (;;)` only exits via a `return` (a terminal stop_reason or the Resource-floor
  // halt). The iteration cap is now the floor's typed `halted` return above, not a throw.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick history-index set to mark with cache_control. Targets the last
 * `CACHE_BREAKPOINT_USER_MSGS` entries that look like real user input
 * (role='user' AND content contains at least one text block). Excludes
 * tool_result-only entries — those are mid-turn API plumbing, not
 * stable prefix material.
 */
function pickCacheTargets(working: ChatHistoryEntry[]): Set<number> {
  const userTextIdx: number[] = [];
  for (let i = 0; i < working.length; i++) {
    const entry = working[i];
    if (entry === undefined) continue;
    if (entry.role !== 'user') continue;
    const hasText = entry.content.some((b) => b.type === 'text');
    if (hasText) userTextIdx.push(i);
  }
  return new Set(userTextIdx.slice(-CACHE_BREAKPOINT_USER_MSGS));
}

/**
 * Translate one history entry into an Anthropic request message. If
 * `mark` is true, attach `cache_control: ephemeral` to the LAST content
 * block (per Anthropic's "marker placement" guidance — the breakpoint
 * applies to all content UP TO AND INCLUDING the marker, so marking the
 * last block caches the whole entry).
 */
function toRequestMessage(entry: ChatHistoryEntry, mark: boolean): AnthropicMessageParam {
  const lastIdx = entry.content.length - 1;
  const content = entry.content.map((block, j) =>
    historyToRequestBlock(block, mark && j === lastIdx),
  );
  return { role: entry.role, content };
}

function historyToRequestBlock(
  block: ChatHistoryContentBlock,
  withCache: boolean,
): AnthropicContentBlockParam {
  const cc = withCache ? { cache_control: { type: 'ephemeral' as const } } : {};
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, ...cc };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input, ...cc };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...cc,
      };
  }
}

function fromResponseBlock(block: AnthropicResponseBlock): ChatHistoryContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
}

function extractTextReply(response: AnthropicMessageResponse): string {
  return response.content
    .filter((b): b is AnthropicResponseTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
