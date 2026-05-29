/**
 * Synthetic `Event` construction for `opensquid triggers fire`.
 *
 * Split out of `triggers.ts` (file-size budget). The synthetic event keys
 * its payload on the trigger kind so downstream handlers see the same shape
 * they would on a real fire (e.g. webhook.path becomes the URL path,
 * file_changed.paths[0] becomes the changed path).
 *
 * `source: 'cli.triggers.fire'` is stamped on each payload so handlers /
 * audit log consumers can distinguish a manual CLI fire from a real
 * cron/webhook/watcher event without re-introspecting their context.
 *
 * Imports from: runtime/types.
 * Imported by: src/setup/cli/triggers.ts.
 */

import type { Event, Trigger } from '../../runtime/types.js';
import type { TriggerRow } from './triggers.js';

export function synthFireEvent(row: TriggerRow, trigger: Trigger, now: Date): Event {
  const iso = now.toISOString();
  switch (trigger.kind) {
    case 'schedule':
      return {
        kind: 'schedule',
        scheduleId: row.id,
        fireTime: iso,
        triggerPayload: { source: 'cli.triggers.fire' },
      };
    case 'webhook':
      return {
        kind: 'webhook',
        subscriptionId: row.id,
        method: 'POST',
        headers: { 'x-opensquid-fire': '1' },
        body: { source: 'cli.triggers.fire' },
        receivedAt: iso,
      };
    case 'inbound_channel':
      return {
        kind: 'inbound_channel',
        channelUri: trigger.channel ?? row.id,
        sender: 'cli.triggers.fire',
        text: '',
        receivedAt: iso,
      };
    case 'file_changed':
      return {
        kind: 'file_changed',
        path: trigger.paths?.[0] ?? '',
        changeKind: 'change',
        changedAt: iso,
      };
    case 'tool_call':
      return { kind: 'tool_call', tool: 'cli.fire', args: {} };
    case 'post_tool_call':
      // T-POSTPUSH POSTPUSH.1 — synthetic post-tool-use fire surfaces a
      // success exit code so verify-CI-after-push-style skills can be
      // triggered manually via `opensquid triggers fire`.
      return { kind: 'post_tool_call', tool: 'cli.fire', args: {}, exit_code: 0 };
    case 'prompt_submit':
      return { kind: 'prompt_submit', prompt: '' };
    case 'session_end':
      return { kind: 'session_end', sessionId: 'cli.fire' };
    case 'stop':
      return { kind: 'stop', assistantText: '' };
  }
}
