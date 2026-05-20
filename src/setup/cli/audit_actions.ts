/**
 * Action implementations for CLI.5 — `opensquid audit …`.
 *
 * Split out of `audit.ts` (file-size budget). Seven verb bodies:
 *
 *   actList    — default; newest 20 entries (or filtered).
 *   actShell   — narrow to `pending_shell` (queued shell_exec approvals).
 *                (capability_gate shell_exec verdicts are surfaced by
 *                permissions audit — CLI.4 — to avoid duplication.)
 *   actChannels— narrow to `channel_send` (deliver-only + outbound).
 *   actPending — narrow to `pending_shell` decision=`prompted` (the
 *                queue the user must approve/reject to unblock).
 *   actTail    — live polling tail; AbortController-owned lifecycle.
 *   actApprove — `transitionPending(id, 'approved')`. Exit 1 if no row.
 *   actReject  — `transitionPending(id, 'rejected')`. Exit 1 if no row.
 *
 * Output discipline: JSON-on-stdout for `list / shell / channels /
 * pending / approve / reject` (pipeable). `tail` emits one row per line —
 * compact format for human readability + greppability.
 *
 * Imports from: ../../runtime/audit_log.
 * Imported by: src/setup/cli/audit.ts.
 */

import { type AuditCategory, type AuditDecision, type AuditLog } from '../../runtime/audit_log.js';

import { formatTimestamp, parseDurationToMs } from './audit_state.js';

export interface ActionDeps {
  log: AuditLog;
  out: (s: string) => void;
  err: (s: string) => void;
  now: () => number;
  /** Tail uses a caller-owned AbortController so SIGINT + tests can abort. */
  abort?: AbortController;
}

export interface CommonFilterOpts {
  since?: string;
  decision?: string;
  limit?: string;
}

const VALID_DECISIONS = new Set<AuditDecision>([
  'allowed',
  'denied',
  'prompted',
  'success',
  'error',
  'approved',
  'rejected',
]);

interface ResolvedFilter {
  sinceMs?: number;
  decision?: AuditDecision;
  limit?: number;
}

function resolveFilter(
  deps: ActionDeps,
  opts: CommonFilterOpts,
  verb: string,
): ResolvedFilter | null {
  const out: ResolvedFilter = {};
  if (opts.since !== undefined) {
    const ms = parseDurationToMs(opts.since);
    if (ms === null) {
      deps.err(
        `opensquid audit ${verb}: --since "${opts.since}" must be like "24h", "7d", "30m", "60s"\n`,
      );
      process.exitCode = 1;
      return null;
    }
    out.sinceMs = deps.now() - ms;
  }
  if (opts.decision !== undefined) {
    if (!VALID_DECISIONS.has(opts.decision as AuditDecision)) {
      deps.err(
        `opensquid audit ${verb}: --decision "${opts.decision}" must be one of ${[...VALID_DECISIONS].join('|')}\n`,
      );
      process.exitCode = 1;
      return null;
    }
    out.decision = opts.decision as AuditDecision;
  }
  if (opts.limit !== undefined) {
    const n = Number.parseInt(opts.limit, 10);
    if (Number.isFinite(n) && n > 0) out.limit = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// list — default. Newest 20 (or --limit). Optional --category, --since,
// --decision filters.
// ---------------------------------------------------------------------------

export interface ListOpts extends CommonFilterOpts {
  category?: string;
}

const VALID_CATEGORIES = new Set<AuditCategory>([
  'capability_gate',
  'webhook',
  'schedule',
  'resume',
  'channel_send',
  'pending_shell',
]);

export async function actList(deps: ActionDeps, opts: ListOpts): Promise<void> {
  const filter = resolveFilter(deps, opts, 'list');
  if (filter === null) return;
  let category: AuditCategory | undefined;
  if (opts.category !== undefined) {
    if (!VALID_CATEGORIES.has(opts.category as AuditCategory)) {
      deps.err(
        `opensquid audit list: --category "${opts.category}" must be one of ${[...VALID_CATEGORIES].join('|')}\n`,
      );
      process.exitCode = 1;
      return;
    }
    category = opts.category as AuditCategory;
  }
  const rows = await deps.log.query({
    ...(filter.sinceMs !== undefined ? { sinceMs: filter.sinceMs } : {}),
    ...(filter.decision !== undefined ? { decision: filter.decision } : {}),
    ...(category !== undefined ? { category } : {}),
    limit: filter.limit ?? 20,
  });
  if (rows.length === 0) {
    deps.out('(no audit entries match the query)\n');
    return;
  }
  deps.out(JSON.stringify({ entries: rows }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// shell — pending_shell rows (queue + history).
// ---------------------------------------------------------------------------

export async function actShell(deps: ActionDeps, opts: CommonFilterOpts): Promise<void> {
  const filter = resolveFilter(deps, opts, 'shell');
  if (filter === null) return;
  const rows = await deps.log.query({
    category: 'pending_shell',
    ...(filter.sinceMs !== undefined ? { sinceMs: filter.sinceMs } : {}),
    ...(filter.decision !== undefined ? { decision: filter.decision } : {}),
    limit: filter.limit ?? 20,
  });
  deps.out(JSON.stringify({ entries: rows }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// channels — channel_send rows.
// ---------------------------------------------------------------------------

export async function actChannels(deps: ActionDeps, opts: CommonFilterOpts): Promise<void> {
  const filter = resolveFilter(deps, opts, 'channels');
  if (filter === null) return;
  const rows = await deps.log.query({
    category: 'channel_send',
    ...(filter.sinceMs !== undefined ? { sinceMs: filter.sinceMs } : {}),
    ...(filter.decision !== undefined ? { decision: filter.decision } : {}),
    limit: filter.limit ?? 20,
  });
  deps.out(JSON.stringify({ entries: rows }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// pending — pending_shell + decision=prompted. The queue the user must
// approve/reject. Limit defaults to 50 (likely-larger than `list`).
// ---------------------------------------------------------------------------

export async function actPending(deps: ActionDeps, opts: CommonFilterOpts): Promise<void> {
  const filter = resolveFilter(deps, opts, 'pending');
  if (filter === null) return;
  const rows = await deps.log.query({
    category: 'pending_shell',
    decision: 'prompted',
    ...(filter.sinceMs !== undefined ? { sinceMs: filter.sinceMs } : {}),
    limit: filter.limit ?? 50,
  });
  if (rows.length === 0) {
    deps.out('(no pending approvals)\n');
    return;
  }
  deps.out(JSON.stringify({ pending: rows }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// tail — live polling. AbortController-owned; SIGINT handler installed
// in the verb wrapper (audit.ts) is responsible for `controller.abort()`.
// ---------------------------------------------------------------------------

export interface TailOpts {
  follow?: boolean;
  interval?: string;
  category?: string;
  signal: AbortSignal;
}

export async function actTail(deps: ActionDeps, opts: TailOpts): Promise<void> {
  let category: AuditCategory | undefined;
  if (opts.category !== undefined) {
    if (!VALID_CATEGORIES.has(opts.category as AuditCategory)) {
      deps.err(
        `opensquid audit tail: --category "${opts.category}" must be one of ${[...VALID_CATEGORIES].join('|')}\n`,
      );
      process.exitCode = 1;
      return;
    }
    category = opts.category as AuditCategory;
  }
  const intervalRaw = opts.interval !== undefined ? Number.parseInt(opts.interval, 10) : 1000;
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : 1000;
  const tailOpts: {
    sinceMs: number;
    intervalMs: number;
    signal: AbortSignal;
    category?: AuditCategory;
  } = {
    sinceMs: deps.now(),
    intervalMs,
    signal: opts.signal,
  };
  if (category !== undefined) tailOpts.category = category;
  const stream = await deps.log.tail(tailOpts);
  for await (const row of stream) {
    deps.out(
      `${formatTimestamp(row.occurredAtMs)}  ${row.category.padEnd(16)} ${row.decision.padEnd(10)} ` +
        `${(row.packId ?? '-').padEnd(20)} id=${String(row.id)}\n`,
    );
    if (opts.follow !== true) {
      // Without --follow, exit after the first batch is yielded.
      // The signal owner aborts via the verb's finally block.
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// approve / reject — atomic transition. Both verbs treat
// `rowsAffected === 0` as "already resolved or never existed" → exit 1.
// ---------------------------------------------------------------------------

async function actTransition(
  deps: ActionDeps,
  rawId: string,
  to: 'approved' | 'rejected',
): Promise<void> {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    deps.err(
      `opensquid audit ${to === 'approved' ? 'approve' : 'reject'}: invalid id "${rawId}"\n`,
    );
    process.exitCode = 1;
    return;
  }
  const updated = await deps.log.transitionPending(id, to);
  if (!updated) {
    deps.err(
      `opensquid audit ${to === 'approved' ? 'approve' : 'reject'}: ` +
        `no pending row with id=${String(id)} (already resolved or never existed)\n`,
    );
    process.exitCode = 1;
    return;
  }
  deps.out(JSON.stringify({ transitioned: { id, to } }, null, 2) + '\n');
}

export async function actApprove(deps: ActionDeps, rawId: string): Promise<void> {
  await actTransition(deps, rawId, 'approved');
}

export async function actReject(deps: ActionDeps, rawId: string): Promise<void> {
  await actTransition(deps, rawId, 'rejected');
}
