/**
 * agent_bridge — subscription-mode agent turn (WAB-SUB.1, 0.5.105).
 *
 * Authoritative spec: WAB-SUB.1 task — "subscription-mode agent turn
 * (spawn `claude --print`)". Reverses WAB v1's api-mode lock per user
 * directive: "i will not use anthropic api it will be all subscription."
 *
 * Responsibility:
 *   Drive a single agent turn by spawning the user's subscription host
 *   binary (e.g. `claude --print`) instead of hitting the Anthropic
 *   Messages API directly. The host (claude / codex / gemini) handles
 *   tool-use internally — opensquid does NOT orchestrate a tool_use
 *   round-trip loop here. The reply is the FINAL stdout text the host
 *   emits after running whatever internal tool calls it wanted.
 *
 * Why sibling file (not extending agent_loop.ts):
 *   agent_loop.ts is at 381 LOC pre-change. The 450 LOC file-size cap
 *   (project_code_quality memory) leaves no headroom for the
 *   subprocess-lifecycle code + structural ClaudeCliClient contract.
 *   Splitting also keeps the api-mode tool-orchestration loop visually
 *   separate from the subscription-mode delegation pattern — two
 *   different mental models, two files.
 *
 * Model neutrality contract (per feedback_stop_haiku_drift memory):
 *   NO vendor model name appears in this file. `opts.cli` is opaque to
 *   the runtime — the user's `models.yaml` declares the binary; we just
 *   spawn it. Audit grep over runtime code must return zero hits for
 *   `haiku|sonnet|opus|gpt-[0-9]|claude-[0-9]|gemini` outside of
 *   docs/comments referencing the CLI binary name.
 *
 * Decision lock — prompt-passing mechanism:
 *   We pass the prompt via stdin (NOT positional argv). `claude --print`
 *   accepts both per `claude --help` (`[prompt]` positional + reads
 *   stdin in non-TTY mode), but:
 *     - argv max length is OS-bounded (~256KB on macOS) — large prompts
 *       + history snippets risk E2BIG
 *     - argv prompts show up in `ps`/process listings — leaks user text
 *     - stdin is uniformly safer cross-platform
 *   Stdin mirrors the existing `subscription_cli.ts` strategy.
 *
 * Decision lock — session continuity:
 *   We accept `opts.resumeSessionId` and pass it via `--resume <id>` if
 *   set. opensquid's SessionState is the SOURCE OF TRUTH for history;
 *   claude's `--resume` is a parallel store managed by Claude Code. The
 *   two are NOT auto-synced — opts.resumeSessionId is for callers that
 *   explicitly opt in (e.g. continuing a claude session the user
 *   started outside opensquid). The default path bundles the last 6
 *   opensquid history entries into the prompt as a self-contained
 *   context block, so the binary gets full conversational context even
 *   without `--resume`.
 *
 * Decision lock — system prompt:
 *   We use `--append-system-prompt` (NOT `--system-prompt`). The latter
 *   REPLACES the host's default system prompt, which would strip out
 *   the host's own tool-use scaffolding (MCP integration, permission
 *   model). Appending preserves the host's defaults and layers
 *   opensquid's pack-specific guidance on top.
 *
 * Decision lock — env passthrough:
 *   We spawn with the parent's full `process.env` — subscription auth
 *   flows through Claude Code's own state (~/.claude/.credentials, OAuth
 *   token in keychain). We do NOT explicitly set ANTHROPIC_API_KEY (per
 *   task spec: "do NOT set it explicitly in spawn (let subscription
 *   auth take over via Claude Code's own state)"). If the user has
 *   ANTHROPIC_API_KEY in their environment from another purpose, claude
 *   will use it — that's the user's choice, not ours.
 *
 * Imports from: node:child_process, ./types.js.
 * Imported by: ./index.ts (barrel), ./agent_loop_subscription.test.ts.
 *   Future: dispatcher.ts (WAB-SUB.2) when the daemon path is wired.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { ChatHistoryContentBlock, ChatHistoryEntry, SessionState } from './types.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Default subprocess timeout. claude --print can take 30-90s for tool work. */
export const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 120_000;

/** History entries included in the prompt context block. */
export const SUBSCRIPTION_HISTORY_SNIPPET_LEN = 6;

// ---------------------------------------------------------------------------
// ClaudeCliClient — structural contract for test injection.
//
// Production: `defaultClaudeCliClient` (below) spawns the real binary
// using `node:child_process.spawn`. Tests inject a stub that returns
// canned output. The interface is intentionally narrow — just `run(args,
// stdin, timeoutMs) → stdout`. Anything richer (streaming, partial
// output) belongs in a future iteration if we add stream-json parsing.
// ---------------------------------------------------------------------------

export interface ClaudeCliRunRequest {
  /** Binary to spawn (e.g. `'claude'` or `'/usr/local/bin/claude'`). */
  cli: string;
  /** Args list — built from opts (--print, --model, --mcp-config, etc). */
  args: string[];
  /** Prompt body written to the child's stdin then EOF. */
  stdin: string;
  /** Hard timeout; SIGTERM on expiry. */
  timeoutMs: number;
}

export interface ClaudeCliClient {
  /**
   * Spawn the CLI, write `stdin`, read stdout to EOF or timeout.
   * Throws on non-zero exit (error message includes stderr) or spawn
   * failure (ENOENT etc). Returns stdout AS-IS (caller trims).
   */
  run(req: ClaudeCliRunRequest): Promise<string>;
}

// ---------------------------------------------------------------------------
// runAgentTurnSubscription options
// ---------------------------------------------------------------------------

export interface RunAgentTurnSubscriptionOptions {
  /** Binary name or path (e.g. `'claude'`). */
  cli: string;
  /**
   * Base args — typically `['--print', '--model', '<model>']` from the
   * user's `models.yaml`. WAB-SUB.2 will derive these from the resolved
   * ModelStrategy (`.cli` + `.args`). We append our own runtime flags
   * (`--mcp-config`, `--resume`, `--append-system-prompt`) onto this
   * base list — order is base args first, then ours.
   */
  args: string[];
  /**
   * Optional MCP config path. If set, we pass `--mcp-config <path>`.
   * This is how the spawned claude gets access to opensquid's MCP
   * tools (chat_send, recall, store_lesson, etc) — claude reads the
   * config, connects to the named stdio/HTTP MCP servers, and uses
   * those tools internally during its own tool-use loop.
   */
  mcpConfigPath?: string;
  /**
   * Optional `--resume <id>`. See module-level "session continuity"
   * decision lock — defaults to undefined; callers that want claude
   * to thread into a parallel claude session pass the id explicitly.
   */
  resumeSessionId?: string;
  /**
   * Pack-specific system prompt. Passed via `--append-system-prompt`
   * (NOT `--system-prompt`) so the host's defaults stay intact. See
   * module-level "system prompt" decision lock.
   */
  systemPrompt: string;
  /** Override `DEFAULT_SUBSCRIPTION_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Override `SUBSCRIPTION_HISTORY_SNIPPET_LEN`. */
  historySnippetLen?: number;
  /** Test seam: inject a stub `ClaudeCliClient`. Production omits this. */
  client?: ClaudeCliClient;
  /** Injected clock (tests). Defaults to `() => new Date().toISOString()`. */
  nowIso?: () => string;
}

export interface RunAgentTurnSubscriptionResult {
  /** New entries: inbound user msg + assistant text reply. */
  assistantEntries: ChatHistoryEntry[];
  /** Trimmed stdout from the CLI — the final reply text. */
  replyText: string;
}

// ---------------------------------------------------------------------------
// runAgentTurnSubscription — the export.
// ---------------------------------------------------------------------------

export async function runAgentTurnSubscription(
  state: SessionState,
  inboundText: string,
  opts: RunAgentTurnSubscriptionOptions,
): Promise<RunAgentTurnSubscriptionResult> {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUBSCRIPTION_TIMEOUT_MS;
  const snippetLen = opts.historySnippetLen ?? SUBSCRIPTION_HISTORY_SNIPPET_LEN;
  const client = opts.client ?? defaultClaudeCliClient;

  // 1. Build the inbound user entry (mirrors runAgentTurn shape so the
  //    caller's SessionManager.appendTurn can persist either result
  //    without branching on mode).
  const inboundEntry: ChatHistoryEntry = {
    role: 'user',
    content: [{ type: 'text', text: inboundText }],
    timestamp: nowIso(),
  };

  // 2. Assemble the args list. Base args first (`--print --model ...`),
  //    then our runtime layers. We always add `--append-system-prompt`;
  //    `--mcp-config` and `--resume` are conditional.
  const args = [...opts.args, '--append-system-prompt', opts.systemPrompt];
  if (opts.mcpConfigPath !== undefined) {
    args.push('--mcp-config', opts.mcpConfigPath);
  }
  if (opts.resumeSessionId !== undefined) {
    args.push('--resume', opts.resumeSessionId);
  }

  // 3. Build the stdin body — last N history entries serialized as a
  //    plain-text transcript, then the inbound message. claude reads
  //    stdin once, EOF-terminated, and treats the whole blob as the
  //    user message for the turn. Self-contained context means we
  //    don't depend on --resume to thread history.
  const stdinBody = buildPromptBody(state.history, inboundText, snippetLen);

  // 4. Spawn + collect stdout.
  const stdout = await client.run({ cli: opts.cli, args, stdin: stdinBody, timeoutMs });
  const replyText = stdout.trim();

  // 5. Build the assistant entry. Subscription mode = single text block
  //    (no tool_use to persist — claude handled tools internally).
  const assistantEntry: ChatHistoryEntry = {
    role: 'assistant',
    content: [{ type: 'text', text: replyText }],
    timestamp: nowIso(),
  };

  return {
    assistantEntries: [inboundEntry, assistantEntry],
    replyText,
  };
}

// ---------------------------------------------------------------------------
// buildPromptBody — serialize history snippet + inbound into one blob.
//
// Format intentionally simple (no JSON, no markdown framing) — claude
// reads it as a single user turn and infers structure from the role
// prefixes. Last N entries from state.history (filtered to text blocks
// only — tool_use/tool_result are mid-turn API plumbing that belong to
// the api-mode runAgentTurn, not subscription mode).
// ---------------------------------------------------------------------------

export function buildPromptBody(
  history: ChatHistoryEntry[],
  inboundText: string,
  snippetLen: number,
): string {
  const snippet = history.slice(-snippetLen).filter(hasTextBlock);
  if (snippet.length === 0) return inboundText;

  const lines: string[] = ['<conversation_history>'];
  for (const entry of snippet) {
    const text = entry.content
      .filter((b): b is ChatHistoryContentBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text.length === 0) continue;
    lines.push(`${entry.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  lines.push('</conversation_history>', '', inboundText);
  return lines.join('\n');
}

function hasTextBlock(entry: ChatHistoryEntry): boolean {
  return entry.content.some((b) => b.type === 'text');
}

// ---------------------------------------------------------------------------
// defaultClaudeCliClient — production spawn-based impl.
//
// Mirrors src/models/strategies/subscription_cli.ts lifecycle:
//   1. spawn(cli, args, stdio=['pipe','pipe','pipe'])
//   2. setTimeout(timeoutMs) — SIGTERM + reject on fire
//   3. write stdin + end()
//   4. accumulate stdout / stderr
//   5. on close: clearTimeout; exit 0 → resolve stdout; else reject with stderr
//
// Differences from subscription_cli.ts:
//   - Does NOT call .trim() on stdout — caller trims (lets tests assert
//     exact bytes when needed).
//   - Caller-supplied timeoutMs is required (no DEFAULT_TIMEOUT_MS fallback
//     here — runAgentTurnSubscription resolves the default and passes it).
// ---------------------------------------------------------------------------

export const defaultClaudeCliClient: ClaudeCliClient = {
  run(req: ClaudeCliRunRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc: ChildProcess = spawn(req.cli, req.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        settle(() => reject(new Error(`subscription cli timeout after ${req.timeoutMs}ms`)));
      }, req.timeoutMs);

      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      proc.on('error', (e) => {
        settle(() => reject(new Error(`subscription cli spawn failed: ${e.message}`)));
      });

      proc.on('close', (code) => {
        settle(() => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(new Error(`subscription cli exit ${code}: ${stderr.trim()}`));
          }
        });
      });

      // stdin.end() flushes the prompt and signals EOF. Wrapped in
      // try/catch because synchronous spawn errors (e.g. Windows
      // ENOENT) can close stdin before this write lands.
      try {
        proc.stdin?.write(req.stdin);
        proc.stdin?.end();
      } catch (e) {
        settle(() => reject(new Error(`subscription cli stdin write failed: ${String(e)}`)));
      }
    });
  },
};
