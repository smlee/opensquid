/**
 * workspace-topic.ts — workspace → forum-topic binding primitive
 * (TPS.3 / v0.5.120+).
 *
 * Solves: given a workspace (cwd-resolved uuid + path) and a target
 * supergroup chat_id, ensure the workspace has a bound forum topic +
 * persist the binding to its `chat-routing.json`. Idempotent.
 *
 * Used by:
 *   - TPS.4 — `opensquid setup chat` wizard step (mode: "wizard")
 *   - TPS.6 — daemon auto-boot on MCP subscribe (mode: "auto-boot")
 *
 * Concurrency: protected by `proper-lockfile` on the per-project
 * `chat-routing.json` so two concurrent invocations for the same
 * workspace can't race-create two topics. The lock window covers
 * (load existing config) → (call createTopic if missing) → (write
 * updated config). Lock retries are bounded; if a stale lock from a
 * crashed prior run blocks acquisition, an `LOCKED` error is thrown
 * upward — callers (wizard, auto-boot) surface this to the user
 * rather than papering over it.
 *
 * Error propagation: this module does NOT swallow errors. RPC failures
 * (bot not admin, network), parse errors, and lock failures all
 * propagate. Callers decide how to surface them (TPS.4 prints to the
 * wizard, TPS.6 logs + falls back to general topic).
 *
 * Rebuild path: same as adapters/telegram.ts — see that file's header
 * for the ad-hoc tsc invocation. `pnpm build` does NOT recompile this
 * file; the chat-daemon worker loads dist/chat/daemon/workspace-topic.js
 * at runtime.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as lockfile from "proper-lockfile";

// Need synchronous require() to construct the rpc-client lazily without
// making resolveOrCreateTopic's signature async-on-import. ESM Node 20+
// exposes createRequire for exactly this case.
const requireCJS = createRequire(import.meta.url);

import {
  loadProjectChatRouting,
  projectChatRoutingPath,
  type ProjectChatRouting,
  type TelegramAutoBound,
} from "./routing.js";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export interface ResolveTopicArgs {
  workspaceUuid: string;
  workspacePath: string;
  /** Supergroup chat_id (e.g. "-1001234567890"). NOT prefixed with "telegram:". */
  chatId: string;
  mode: "wizard" | "auto-boot" | "manual";
  /**
   * Optional override of the topic-creation client. In production this
   * is a `DaemonClient` instance pointed at the running daemon's UDS;
   * in unit tests it's a stub that records the call without going over
   * the wire. The shape is intentionally minimal (just what this module
   * needs) so the daemon-side equivalent (TPS.6) can pass an in-process
   * adapter that calls the gateway directly without going through UDS.
   */
  rpcClient?: TopicCreatorClient;
  /** Optional override of the OPENSQUID_HOME data root. Used by tests. */
  dataRoot?: string;
}

export interface ResolveTopicResult {
  topicId: number;
  topicName: string;
  /** true = freshly created in this call; false = pre-existing binding reused. */
  created: boolean;
}

export interface TopicCreatorClient {
  createTopic(params: {
    platform: "telegram";
    chat_id: string;
    name: string;
  }): Promise<{ message_thread_id: number; name: string }>;
}

// ---------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------

export async function resolveOrCreateTopic(args: ResolveTopicArgs): Promise<ResolveTopicResult> {
  const routingPath = projectChatRoutingPath(args.workspaceUuid, args.dataRoot);
  // Lockfile lives next to the routing file; proper-lockfile handles
  // both lock acquisition and the necessary parent-dir creation logic
  // as long as the target exists. Ensure the dir exists first.
  await fs.mkdir(path.dirname(routingPath), { recursive: true });
  // proper-lockfile requires the target file to exist; touch it
  // (empty config) if it doesn't, so the lock can be acquired
  // regardless of whether the workspace has ever had routing set up.
  await ensureRoutingFileExists(routingPath);

  // Retry tuning rationale (TPS.3 pre-research): typical createTopic
  // round-trip is 200-600ms (UDS + HTTPS to api.telegram.org). 8
  // retries with 1.5× backoff at 50ms-800ms gives ~2.4s headroom —
  // plenty for one contender to finish while another waits. Stale is
  // proper-lockfile's default (10s); not setting it explicitly.
  const release = await lockfile.lock(routingPath, {
    retries: { retries: 8, factor: 1.5, minTimeout: 50, maxTimeout: 800 },
  });

  try {
    const existing = await loadProjectChatRouting(args.workspaceUuid, args.dataRoot);
    assertAutoBoundInvariant(existing, routingPath);
    const bound = existing?.telegram?.auto_bound;
    if (bound && Number.isFinite(bound.topic_id) && bound.topic_id > 0) {
      // Idempotent — already bound, return existing.
      // Sanity check: if the auto_bound.workspace_uuid disagrees with
      // the outer uuid (the directory name), log on stderr but trust
      // the outer uuid as authoritative.
      if (bound.workspace_uuid !== args.workspaceUuid) {
        process.stderr.write(
          `[workspace-topic] auto_bound.workspace_uuid (${bound.workspace_uuid}) ≠ outer uuid (${args.workspaceUuid}) for ${routingPath}; using existing binding\n`,
        );
      }
      return { topicId: bound.topic_id, topicName: bound.topic_name, created: false };
    }

    const name = deriveTopicName(args.workspacePath, args.workspaceUuid);
    const client = args.rpcClient ?? defaultRpcClient(args.dataRoot);
    const created = await client.createTopic({
      platform: "telegram",
      chat_id: args.chatId,
      name,
    });

    const nextAutoBound: TelegramAutoBound = {
      workspace_path: args.workspacePath,
      workspace_uuid: args.workspaceUuid,
      topic_id: created.message_thread_id,
      topic_name: created.name,
      created_at: new Date().toISOString(),
      created_by: args.mode,
    };

    const merged: ProjectChatRouting = {
      ...(existing ?? {}),
      telegram: {
        ...(existing?.telegram ?? {}),
        // Persist both auto_bound metadata + the actual routing field
        // (inbound_topic_ids) so the routing index picks up the new
        // binding on its next ~30s hot-reload without separate writes.
        inbound_topic_ids: mergeTopicIds(
          existing?.telegram?.inbound_topic_ids,
          created.message_thread_id,
        ),
        inbound_chat_ids: mergeChatIds(existing?.telegram?.inbound_chat_ids, args.chatId),
        auto_bound: nextAutoBound,
      },
    };
    try {
      await persistRoutingAtomic(routingPath, merged);
    } catch (persistErr) {
      // TPS.3 pre-research, choice #6 partial-failure compensation:
      // createTopic SUCCEEDED but persist FAILED — Telegram has a real
      // topic we cannot reference. Log it to a recovery file so the
      // user can clean up (delete the orphan topic manually) instead
      // of accumulating ghost topics on every retry. Don't try to
      // rollback (delete the topic) here — that requires a second
      // RPC call that could also fail, compounding the problem.
      // The user-facing surface lives in TPS.5 collision channel.
      await recordOrphanTopic(args.dataRoot, {
        chat_id: args.chatId,
        topic_id: created.message_thread_id,
        topic_name: created.name,
        workspace_uuid: args.workspaceUuid,
        workspace_path: args.workspacePath,
        mode: args.mode,
        persist_error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        occurred_at: new Date().toISOString(),
      });
      throw persistErr;
    }

    return {
      topicId: created.message_thread_id,
      topicName: created.name,
      created: true,
    };
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------

/**
 * Derive a deterministic, human-readable topic name from the workspace
 * path + uuid. The basename of the path is the most user-recognisable
 * part; the uuid prefix disambiguates two workspaces with the same
 * basename. Examples:
 *
 *   deriveTopicName("/Users/slee/projects/loop", "da96385b-...") =
 *     "loop · da96385b"
 *   deriveTopicName("/", "abc12345-...") = "root · abc12345"
 */
export function deriveTopicName(workspacePath: string, workspaceUuid: string): string {
  const basenameRaw = path.basename(workspacePath) || "root";
  // Telegram limit per [aiogram docs](https://docs.aiogram.dev/en/latest/api/methods/create_forum_topic.html)
  // is 1-128 chars. Cap basename at 48 to leave headroom for the
  // " · 12345678" suffix (11 chars) — total max output ~59 chars.
  // 48 is conservative: Telegram client truncates topic-list display
  // at ~30-35 chars anyway. Pre-research verdict #4.
  const basename = basenameRaw.length > 48 ? `${basenameRaw.slice(0, 45)}...` : basenameRaw;
  const uuidShort = workspaceUuid.slice(0, 8);
  return `${basename} · ${uuidShort}`;
}

/**
 * Merge a single new topic_id into an optional existing array. Avoids
 * duplicates while preserving order (existing first, new last).
 */
export function mergeTopicIds(existing: number[] | undefined, newId: number): number[] {
  if (!existing || existing.length === 0) return [newId];
  if (existing.includes(newId)) return existing;
  return [...existing, newId];
}

/**
 * Same as mergeTopicIds for chat_ids (strings).
 */
export function mergeChatIds(existing: string[] | undefined, newId: string): string[] {
  if (!existing || existing.length === 0) return [newId];
  if (existing.includes(newId)) return existing;
  return [...existing, newId];
}

/**
 * Clear an existing auto_bound block (TPS.7 stale-topic lifecycle).
 * Leaves `inbound_topic_ids` alone — caller decides whether to also
 * scrub those (typically yes, since the stale topic_id no longer
 * exists). Returns true if a binding was cleared, false if none.
 */
export async function clearBinding(args: {
  workspaceUuid: string;
  dataRoot?: string;
}): Promise<boolean> {
  const routingPath = projectChatRoutingPath(args.workspaceUuid, args.dataRoot);
  await fs.mkdir(path.dirname(routingPath), { recursive: true });
  await ensureRoutingFileExists(routingPath);
  const release = await lockfile.lock(routingPath, {
    retries: { retries: 8, factor: 1.5, minTimeout: 50, maxTimeout: 800 },
    stale: 10_000,
  });
  try {
    const existing = await loadProjectChatRouting(args.workspaceUuid, args.dataRoot);
    if (!existing?.telegram?.auto_bound) return false;
    const staleTopicId = existing.telegram.auto_bound.topic_id;
    const next: ProjectChatRouting = {
      ...existing,
      telegram: {
        ...existing.telegram,
        inbound_topic_ids: (existing.telegram.inbound_topic_ids ?? []).filter(
          (t) => t !== staleTopicId,
        ),
        auto_bound: undefined,
      },
    };
    // Drop the auto_bound key entirely (don't leave `auto_bound: undefined`
    // in the JSON output).
    if (next.telegram) delete next.telegram.auto_bound;
    if (next.telegram?.inbound_topic_ids?.length === 0) delete next.telegram.inbound_topic_ids;
    await persistRoutingAtomic(routingPath, next);
    return true;
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------

async function ensureRoutingFileExists(routingPath: string): Promise<void> {
  try {
    await fs.access(routingPath);
  } catch {
    await fs.writeFile(routingPath, "{}\n", { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      // EEXIST is fine — another process touched it in the race window.
      if (err.code !== "EEXIST") throw err;
    });
  }
}

async function persistRoutingAtomic(routingPath: string, cfg: ProjectChatRouting): Promise<void> {
  // Write to a sibling tmp + rename for atomicity (rename(2) is atomic
  // on the same filesystem). Avoids partial-write reads from the daemon's
  // 30s reload loop.
  const tmp = `${routingPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  await fs.rename(tmp, routingPath);
}

function defaultRpcClient(dataRoot?: string): TopicCreatorClient {
  // No cache: DaemonClient construction is cheap (just stores config)
  // and caching it across calls broke tests that switch OPENSQUID_HOME
  // per test. Construct fresh; pay the ~no-op cost. Pre-research
  // verdict #7.
  const { DaemonClient } = requireCJS("./rpc-client.js") as typeof import("./rpc-client.js");
  return new DaemonClient(dataRoot ? { dataRoot } : {});
}

/**
 * Invariant check: if `auto_bound.topic_id` is set, it MUST appear in
 * `inbound_topic_ids`. Pre-research verdict #9: log a warning on
 * mismatch but do NOT auto-repair (preserves user-edited intent).
 */
function assertAutoBoundInvariant(
  cfg: ProjectChatRouting | null,
  routingPath: string,
): void {
  const bound = cfg?.telegram?.auto_bound;
  if (!bound) return;
  const inboundTopics = cfg?.telegram?.inbound_topic_ids ?? [];
  if (!inboundTopics.includes(bound.topic_id)) {
    process.stderr.write(
      `[workspace-topic] invariant warning: auto_bound.topic_id=${bound.topic_id} not in inbound_topic_ids=${JSON.stringify(inboundTopics)} for ${routingPath}; not auto-repairing\n`,
    );
  }
}

interface OrphanTopicRecord {
  chat_id: string;
  topic_id: number;
  topic_name: string;
  workspace_uuid: string;
  workspace_path: string;
  mode: ResolveTopicArgs["mode"];
  persist_error: string;
  occurred_at: string;
}

async function recordOrphanTopic(
  dataRoot: string | undefined,
  record: OrphanTopicRecord,
): Promise<void> {
  // Pre-research verdict #6: log orphans to a recovery file so the
  // user can clean up (delete the topic manually via Telegram client
  // or via a future TPS.7 cleanup tool) instead of accumulating
  // ghost topics on every retry. Doesn't try to delete the topic
  // (that's a separate RPC call that could ALSO fail, compounding).
  const root = dataRoot ?? process.env.OPENSQUID_HOME;
  if (!root) return; // best-effort: nowhere to write
  const recoveryPath = path.join(root, "orphan-topics.jsonl");
  try {
    await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
    await fs.appendFile(recoveryPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // If even the recovery write fails, give up silently. The original
    // persist error will propagate; that's the load-bearing surface.
  }
}
