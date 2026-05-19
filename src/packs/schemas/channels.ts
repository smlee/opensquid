/**
 * Zod schema for `channels.yaml` — the pack's suggested channel URI defaults.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Pluggable channels"
 * + §"Two-layer pattern" + memory `project_opensquid_notification_routing`.
 *
 * Two-layer model: packs declare abstract channel names (`alerts`, `audit_log`,
 * `opensquid_topic`); user config at `~/.opensquid/channels.yaml` maps
 * abstract names → concrete URIs (`telegram://12345/666`, `slack://...`, etc.).
 * The pack-side `channels.yaml` is OPTIONAL suggested defaults a pack ships
 * for documentation / setup-UI prefill — runtime resolution always reads the
 * user's mapping last (resolution algorithm steps 3-4).
 *
 * Schema shape: `Record<string, string>` — abstract name → URI string. We do
 * NOT validate URI schemes at this layer because new adapters land over time
 * (Phase 1 ships chat / telegram / discord / slack; more later). The channel
 * adapter registry (Task 2.6 / runtime adapter layer) is the right place to
 * reject unknown schemes; at load time we accept any string so a pack can
 * declare a future-adapter URI without breaking on schema validation.
 *
 * `.default({})` makes an empty `channels.yaml` (or a missing file) parse to
 * `{}` — out-of-the-box constraint. The minimum-viable pack ships no channels.
 *
 * Imports from: zod only (self-contained per audit constraint).
 * Imported by: src/packs/schemas/index.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// ChannelsConfig — abstract channel name → suggested URI default.
//
// Abstract name conventions (not enforced — packs are free to invent names):
//   - `alerts`         — high-severity ops alerts
//   - `audit_log`      — append-only event log
//   - `chat`           — in-session reply surface (always available)
//   - `report_channel` — task-summary destination
//
// URI forms (informational — adapter registry validates):
//   - `chat://`
//   - `telegram://<chat_id>` or `telegram://<chat_id>/<topic_id>`
//   - `discord://<guild>/<channel>`
//   - `slack://<workspace>/<channel>`
// ---------------------------------------------------------------------------

export const ChannelsConfig = z.record(z.string(), z.string()).default({});
export type ChannelsConfig = z.infer<typeof ChannelsConfig>;
