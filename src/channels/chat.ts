/**
 * chat:// adapter — in-session reply via Claude Code's reply surface.
 *
 * Hook-context contract: Claude Code captures a hook's stderr as the
 * reply text shown to the agent. Outside hook context (e.g. MCP server
 * over stdio), writing to stdout would corrupt the JSON-RPC stream, so
 * we still write to stdout ONLY when OPENSQUID_HOOK_CONTEXT is unset.
 * The MCP server entrypoint must NEVER set OPENSQUID_HOOK_CONTEXT=1
 * and must NEVER route through chat:// without first redirecting its
 * own stdout (see runtime/notification router, Task 1.14).
 *
 * URI scheme: `chat://` (no host, no path required). Any string starting
 * with `chat://` validates; the suffix is reserved for future routing
 * hints (e.g. `chat://main`) and is currently ignored.
 */

import type { ChannelAdapter, ChannelMessage, SendResult } from './types.js';

export const chatAdapter: ChannelAdapter = {
  scheme: 'chat',
  validate(uri: string): boolean {
    return uri === 'chat://' || uri.startsWith('chat://');
  },
  // Async signature is required by the ChannelAdapter contract; stdio writes
  // are themselves synchronous, hence the eslint disable.
  // eslint-disable-next-line @typescript-eslint/require-await
  async send(_uri: string, message: ChannelMessage): Promise<SendResult> {
    const tagged = `[opensquid:${message.severity ?? 'info'}] ${message.text}`;
    if (process.env.OPENSQUID_HOOK_CONTEXT === '1') {
      process.stderr.write(tagged + '\n');
    } else {
      process.stdout.write(tagged + '\n');
    }
    return { ok: true };
  },
};
