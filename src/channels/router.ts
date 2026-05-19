/**
 * NotificationRouter — resolves (severity, project) → concrete channel
 * targets, then multicasts in parallel with partial-success accounting.
 *
 * Resolution algorithm (per docs/opensquid-real-design.md §"Resolution
 * algorithm"):
 *   1. If `project` is set AND `perProjectOverride[project][severity]`
 *      exists → use that list of abstract channel names.
 *   2. Else use `severityTiers[severity]` (or fall back to `['chat']`
 *      if absent).
 *   3. For each abstract name: resolve to a URI via `channelMapping`
 *      (the literal name `'chat'` is special-cased to `chat://`).
 *   4. For each URI: extract scheme, look up registered adapter; skip
 *      silently if no adapter handles that scheme (misconfigured
 *      mapping is a warning, not a crash — see §"Fallback chain").
 *   5. If zero targets resolved → fall back to the chat adapter (if
 *      registered). This is the last-resort path that guarantees the
 *      user sees the message in-session even when their channel config
 *      is broken.
 *
 * Multicast policy: parallel `Promise.all` with per-task `.catch` →
 * partial-success. No silent drops: every failure is counted and
 * surfaced in the result's `errors` array. Even if every target fails
 * (including the chat fallback), we return `{ sent: 0, failed: N }`
 * rather than throwing — the runtime must stay alive.
 */

import type {
  ChannelAdapter,
  ChannelMessage,
  RoutingConfig,
  SendResult,
  Severity,
} from './types.js';

export interface MulticastResult {
  sent: number;
  failed: number;
  errors: string[];
}

export class NotificationRouter {
  private readonly adapters = new Map<string, ChannelAdapter>();

  /** Register an adapter keyed by its URI scheme (e.g. 'chat', 'telegram'). */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.scheme, adapter);
  }

  /**
   * Resolve (severity, project, config) → ordered list of concrete
   * targets. Returns an empty array only if no adapters are registered
   * at all (including no chat fallback).
   */
  resolve(
    severity: Severity,
    project: string | null,
    config: RoutingConfig,
  ): { uri: string; adapter: ChannelAdapter }[] {
    const projectOverride =
      project !== null ? config.perProjectOverride?.[project]?.[severity] : undefined;
    const abstractNames = projectOverride ?? config.severityTiers[severity] ?? ['chat'];

    const resolved: { uri: string; adapter: ChannelAdapter }[] = [];
    for (const name of abstractNames) {
      const uri = name === 'chat' ? 'chat://' : config.channelMapping[name];
      if (uri === undefined || uri === '') continue;
      const schemePart = uri.split('://')[0];
      if (schemePart === undefined || schemePart === '') continue;
      const adapter = this.adapters.get(schemePart);
      if (adapter !== undefined) {
        resolved.push({ uri, adapter });
      }
    }

    if (resolved.length === 0) {
      const chat = this.adapters.get('chat');
      if (chat !== undefined) {
        resolved.push({ uri: 'chat://', adapter: chat });
      }
    }

    return resolved;
  }

  /**
   * Multicast `message` to every channel resolved for (severity,
   * project). Sends are issued in parallel; each rejection is caught
   * and translated to a `SendResult` with `ok: false` so partial
   * success is preserved.
   */
  async multicast(
    severity: Severity,
    project: string | null,
    message: ChannelMessage,
    config: RoutingConfig,
  ): Promise<MulticastResult> {
    const targets = this.resolve(severity, project, config);
    const results = await Promise.all(
      targets.map((t) =>
        t.adapter.send(t.uri, message).catch(
          (e: unknown): SendResult => ({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }),
        ),
      ),
    );
    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    const errors = results.filter((r) => !r.ok).map((r) => r.error ?? 'unknown');
    return { sent, failed, errors };
  }
}
