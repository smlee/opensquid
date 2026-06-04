/**
 * `ensure_umbrella_topic` primitive (T-CHAT-AS-TERMINAL CAT.7 — SessionStart
 * topic assurance, umbrella-level ≤1 topic).
 *
 * The SECOND consumer of the SessionStart hook mechanism (HH6.1) and the FIRST
 * one sanctioned to take an ACTION on `session_start`. Where
 * `check_chat_connection` is REPORT-ONLY, CAT.7 — under the remote-terminal
 * override [[project_opensquid_chat_is_remote_terminal]] — guarantees the
 * session's UMBRELLA owns exactly one telegram forum topic so inbound/outbound
 * chat lands in an isolated thread.
 *
 * The assurance, on `session_start`:
 *
 *   1. Resolve cwd → umbrella via `loadChannelsConfig` + `resolveUmbrellaForCwd`.
 *      - cwd in NO umbrella  → NO-OP. We never fabricate an umbrella row; that
 *        is the setup wizard's job. The session simply has no chat binding.
 *   2. Inspect the resolved umbrella's `telegram` binding:
 *      - already has a `topic_id`  → NO-OP (use the existing one topic). This is
 *        the umbrella-level ≤1:1 invariant in action: an opensquid-cwd session
 *        and a loop-cwd session both resolve to the SAME loop umbrella row, so
 *        the second session sees `topic_id` already set and NEVER creates a 2nd.
 *      - no `telegram` binding at all (no `chat_id`)  → NO-OP. Nothing to attach
 *        a topic to; the wizard hasn't wired the supergroup yet.
 *      - has `chat_id` but NO `topic_id`  → the ZERO-topic case: proceed.
 *   3. Gate on the chat-daemon being LIVE (a `ping` over its socket). No daemon
 *      → NO-OP. The assurance only runs when chat is live (a live remote
 *      terminal); we never spawn the daemon here.
 *   4. Create EXACTLY ONE topic via the daemon `create_topic` RPC
 *      ({platform:'telegram', chat_id, name} → {message_thread_id, name}), with
 *      an umbrella-derived name, then write `topic_id` back into THAT umbrella's
 *      row in `channels.json` via an atomic write that preserves every other
 *      field/row. Once `topic_id` is set, step 2 makes every subsequent run a
 *      no-op — idempotent, ≤1 topic per umbrella by construction.
 *
 * Fail-quiet: every failure mode (no daemon, RPC error, IO error, malformed
 * config) returns `ok(null)` and NEVER blocks session start. CAT.7 emits no
 * inject_context — it is a pure side-effecting assurance, so `null` (the
 * no-verdict branch) is the only return.
 *
 * Seams (test injection, no socket / no Telegram in unit tests):
 *   - `createTopic`  — the daemon `create_topic` RPC dial. Default dials the
 *     daemon socket one-shot (mirrors `chat_send.ts defaultDaemonSend`).
 *   - `daemonRunning` — the live-daemon gate. Default `ping`s the socket.
 *   - `now`          — clock (unused today; reserved for name stamping).
 *
 * Imports from: zod, node:net, node:os, node:path, ../channels/routing.js,
 *   ../runtime/atomic_write.js, ../runtime/result.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  channelsConfigPath,
  loadChannelsConfig,
  resolveUmbrellaForCwd,
  type ChannelsConfig,
} from '../channels/routing.js';
import { createTopic as clientCreateTopic, pingDaemon } from '../chat_daemon/client.js';
import { atomicWriteFile } from '../runtime/atomic_write.js';
import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Seams — injected by tests so a unit run never touches the socket / Telegram.
// ---------------------------------------------------------------------------

/** The daemon `create_topic` RPC: chat_id + name → the new thread id. */
export type CreateTopicFn = (args: {
  chatId: string;
  name: string;
}) => Promise<{ message_thread_id: number; name: string }>;

/** The live-daemon gate: true iff a chat-daemon answers on its socket. */
export type DaemonRunningFn = () => Promise<boolean>;

export interface EnsureUmbrellaTopicDeps {
  createTopic?: CreateTopicFn;
  daemonRunning?: DaemonRunningFn;
}

// ---------------------------------------------------------------------------
// Default seams — the shared chat-daemon client (src/chat_daemon/client.ts).
// CL.3 (T-CHAT-FINALIZE-REMOVE-LEGACY): this module previously carried its OWN
// copy of the socket dance (daemonSocketPath + daemonRpc) — the 5th copy the
// audit found. Both now delegate to the one owner.
// ---------------------------------------------------------------------------

/** Default `create_topic` dial — the shared client's one-shot RPC. */
const defaultCreateTopic: CreateTopicFn = (args) => clientCreateTopic(args.chatId, args.name);

/** Default daemon-running gate — the shared client's `ping`. */
const defaultDaemonRunning: DaemonRunningFn = () => pingDaemon();

// ---------------------------------------------------------------------------
// Umbrella-derived topic name. Keep it short + stable + human-scannable.
// ---------------------------------------------------------------------------

function topicNameForUmbrella(umbrellaId: string): string {
  return `opensquid: ${umbrellaId}`;
}

// ---------------------------------------------------------------------------
// channels.json write-back — set the resolved umbrella's `topic_id`, preserve
// every other field and row, atomic publish. Re-reads the freshest config off
// disk just before the write (not the snapshot the resolver saw) so a
// concurrent edit to a SIBLING row is not clobbered.
// ---------------------------------------------------------------------------

async function writeBackTopicId(umbrellaId: string, topicId: number): Promise<void> {
  // Re-read raw to preserve any keys the (strict) schema would round-trip
  // identically; we mutate only the one umbrella's telegram.topic_id.
  const raw = await readFile(channelsConfigPath(), 'utf8');
  const cfg = JSON.parse(raw) as ChannelsConfig;
  const row = cfg.umbrellas.find((u) => u.id === umbrellaId);
  if (row?.telegram === undefined) {
    // The row/binding vanished between resolve and write — abort the write-back
    // rather than fabricate state. Caller is fail-quiet.
    throw new Error(`umbrella ${umbrellaId} no longer has a telegram binding`);
  }
  // Idempotency belt-and-suspenders: never overwrite an existing topic_id.
  if (row.telegram.topic_id !== undefined) return;
  row.telegram.topic_id = topicId;
  await atomicWriteFile(channelsConfigPath(), JSON.stringify(cfg, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// `cwd` is an optional override (tests inject it); production reads it from the
// session_start event payload via ctx.
const EnsureUmbrellaTopicArgs = z.object({ cwd: z.string().optional() }).strict();

export function registerEnsureUmbrellaTopicFunction(
  registry: FunctionRegistry,
  deps: EnsureUmbrellaTopicDeps = {},
): void {
  const createTopic = deps.createTopic ?? defaultCreateTopic;
  const daemonRunning = deps.daemonRunning ?? defaultDaemonRunning;

  registry.register({
    name: 'ensure_umbrella_topic',
    argSchema: EnsureUmbrellaTopicArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 40,
    execute: async (args, ctx) => {
      try {
        const cwd =
          args.cwd ??
          (ctx.event.kind === 'session_start' ? ctx.event.cwd : undefined) ??
          process.cwd();

        // 1. cwd → umbrella. Absent config / unresolved cwd → no-op.
        const channels = await loadChannelsConfig();
        if (channels === null) return ok(null);
        const umbrellaId = resolveUmbrellaForCwd(channels, cwd);
        if (umbrellaId === null) return ok(null);

        const row = channels.umbrellas.find((u) => u.id === umbrellaId);
        if (row?.telegram === undefined) return ok(null); // no binding → wizard's job

        // 2. Already has its one topic → no-op (≤1:1 invariant). This is also
        // the "second cwd in the same umbrella" path: the first session set
        // topic_id, the second sees it and never creates a 2nd.
        if (row.telegram.topic_id !== undefined) return ok(null);

        // 3. Zero-topic case. Gate on the daemon being live; no daemon → no-op.
        if (!(await daemonRunning())) return ok(null);

        // 4. Create EXACTLY ONE topic, then write topic_id back atomically.
        const created = await createTopic({
          chatId: row.telegram.chat_id,
          name: topicNameForUmbrella(umbrellaId),
        });
        await writeBackTopicId(umbrellaId, created.message_thread_id);

        return ok(null);
      } catch {
        // Fail-quiet: the assurance must never break session start.
        return ok(null);
      }
    },
  });
}
