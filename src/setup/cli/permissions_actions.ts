/**
 * Action implementations for CLI.4 — `opensquid permissions …`.
 *
 * Split out of `permissions.ts` (file-size budget). Four verbs:
 *
 *   list     — show declared permissions per pack alongside user overrides.
 *              When `--pack <id>` is passed, scope to that one pack;
 *              otherwise enumerate every pack under
 *              `~/.opensquid/packs/`. Output is JSON (one entry per
 *              capability the pack declares OR has overrides for) so
 *              downstream tools can pipe it; the human-readable summary
 *              line is on stderr for ergonomics.
 *
 *   audit    — query `~/.opensquid/permission_audit.jsonl` (file-based;
 *              CLI.5 migrates to the libsql `audit_log` table). Honors
 *              `--since <duration>` (e.g. 24h, 7d) + `--decision <kind>`
 *              (allowed|denied|prompted). Returns rows sorted newest-first.
 *
 *   grant    — append a user-side override to
 *              `~/.opensquid/permission_overrides.yaml`. Rejects targets
 *              that match the sealed built-in denylist unless
 *              `OPENSQUID_TRUST_BUILTIN_DENY=0` is set in the environment.
 *              Atomic file write: tmp + rename.
 *
 *   revoke   — remove a matching override. Without `--target`, removes
 *              all overrides for `(pack, capability)`. With `--target`,
 *              removes only the matching `(pack, capability, target)`.
 *
 * Capability-vocabulary discipline: the CLI speaks the same `(pack,
 * capability, target)` tuple the runtime gate consumes. No translation
 * between human + machine vocabularies — the audit-log shape and the
 * gate's `CapabilityRequest` are literally the same triple.
 *
 * Imports from: ../../packs/schemas, ./permissions_state.
 * Imported by: src/setup/cli/permissions.ts.
 */

import { Capability, type CapabilityType } from '../../packs/schemas/index.js';

import {
  appendAuditEntry,
  defaultAuditPath,
  defaultOverridesPath,
  defaultPacksDir,
  denylistRejectionFor,
  enumerateManifests,
  readAuditEntries,
  readOverridesFile,
  writeOverridesFile,
  type AuditEntry,
  type OverrideRecord,
} from './permissions_state.js';

export interface PermissionsPaths {
  overridesPath: string;
  auditPath: string;
  packsDir: string;
}

export interface ActionDeps {
  paths: PermissionsPaths;
  out: (s: string) => void;
  err: (s: string) => void;
  now: () => Date;
}

export const defaultPaths = (): PermissionsPaths => ({
  overridesPath: defaultOverridesPath(),
  auditPath: defaultAuditPath(),
  packsDir: defaultPacksDir(),
});

// ---------------------------------------------------------------------------
// Capability parser — narrow the commander string into the Zod enum.
// ---------------------------------------------------------------------------

export function parseCapability(raw: string): CapabilityType | null {
  const parsed = Capability.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// list — declared per pack + user overrides side-by-side.
// ---------------------------------------------------------------------------

export interface ListOpts {
  pack?: string;
}

interface ListRow {
  pack: string;
  declared: Record<string, unknown>;
  overrides: { capability: CapabilityType; target: string; granted_at: string }[];
}

export async function actList(deps: ActionDeps, opts: ListOpts): Promise<void> {
  const [manifests, overrides] = await Promise.all([
    enumerateManifests(deps.paths.packsDir),
    readOverridesFile(deps.paths.overridesPath),
  ]);
  const rowsByPack = new Map<string, ListRow>();
  for (const m of manifests) {
    if (opts.pack !== undefined && m.packId !== opts.pack) continue;
    const declared: Record<string, unknown> = m.manifest.permissions ?? {};
    rowsByPack.set(m.packId, { pack: m.packId, declared, overrides: [] });
  }
  // Overrides may reference packs not yet installed; surface them too so
  // the user sees "you have overrides for a pack you don't have installed".
  for (const o of overrides) {
    if (opts.pack !== undefined && o.pack !== opts.pack) continue;
    const existing = rowsByPack.get(o.pack);
    const entry = { capability: o.capability, target: o.target, granted_at: o.granted_at };
    if (existing) {
      existing.overrides.push(entry);
    } else {
      rowsByPack.set(o.pack, { pack: o.pack, declared: {}, overrides: [entry] });
    }
  }
  const rows = [...rowsByPack.values()].sort((a, b) => a.pack.localeCompare(b.pack));
  if (rows.length === 0) {
    deps.out('(no packs with declared permissions or user overrides)\n');
    return;
  }
  deps.out(JSON.stringify({ packs: rows }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// audit — query permission_audit.jsonl with --since / --decision filters.
// ---------------------------------------------------------------------------

export interface AuditOpts {
  since?: string;
  decision?: string;
  limit?: string;
}

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

export function parseDurationToMs(spec: string): number | null {
  const m = DURATION_RE.exec(spec.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '0', 10);
  if (!Number.isFinite(n) || n < 0) return null;
  switch (m[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return null;
  }
}

const VALID_DECISIONS = new Set<AuditEntry['decision']>(['allowed', 'denied', 'prompted']);

export async function actAudit(deps: ActionDeps, opts: AuditOpts): Promise<void> {
  let sinceMs: number | null = null;
  if (opts.since !== undefined) {
    const ms = parseDurationToMs(opts.since);
    if (ms === null) {
      deps.err(
        `opensquid permissions audit: --since "${opts.since}" must be like "24h", "7d", "30m", "60s"\n`,
      );
      process.exitCode = 1;
      return;
    }
    sinceMs = deps.now().getTime() - ms;
  }
  if (
    opts.decision !== undefined &&
    !VALID_DECISIONS.has(opts.decision as AuditEntry['decision'])
  ) {
    deps.err(
      `opensquid permissions audit: --decision "${opts.decision}" must be one of allowed|denied|prompted\n`,
    );
    process.exitCode = 1;
    return;
  }
  const entries = await readAuditEntries(deps.paths.auditPath);
  const filtered = entries.filter((e) => {
    if (sinceMs !== null && e.occurred_at_ms < sinceMs) return false;
    if (opts.decision !== undefined && e.decision !== opts.decision) return false;
    return true;
  });
  filtered.sort((a, b) => b.occurred_at_ms - a.occurred_at_ms);
  const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 100;
  const sliced = Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered;
  if (sliced.length === 0) {
    deps.out('(no audit entries match the query)\n');
    return;
  }
  deps.out(JSON.stringify({ entries: sliced }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// grant — append override (atomic) after denylist check.
// ---------------------------------------------------------------------------

export interface GrantOpts {
  target: string;
}

export async function actGrant(
  deps: ActionDeps,
  pack: string,
  capability: string,
  opts: GrantOpts,
): Promise<void> {
  const cap = parseCapability(capability);
  if (cap === null) {
    deps.err(
      `opensquid permissions grant: unknown capability "${capability}" — must be one of ${Capability.options.join('|')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (opts.target === undefined || opts.target.length === 0) {
    deps.err('opensquid permissions grant: --target <pattern> is required\n');
    process.exitCode = 1;
    return;
  }
  const rejection = denylistRejectionFor(cap, opts.target);
  if (rejection !== null) {
    deps.err(`opensquid permissions grant: ${rejection.message}\n`);
    process.exitCode = 1;
    return;
  }
  const existing = await readOverridesFile(deps.paths.overridesPath);
  const duplicate = existing.find(
    (o) => o.pack === pack && o.capability === cap && o.target === opts.target,
  );
  if (duplicate !== undefined) {
    deps.err(
      `opensquid permissions grant: override already exists for pack="${pack}" capability="${cap}" target="${opts.target}" (granted_at ${duplicate.granted_at})\n`,
    );
    process.exitCode = 1;
    return;
  }
  const record: OverrideRecord = {
    pack,
    capability: cap,
    target: opts.target,
    granted_at: deps.now().toISOString(),
  };
  await writeOverridesFile(deps.paths.overridesPath, [...existing, record]);
  deps.out(JSON.stringify({ granted: record }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// revoke — remove matching override(s).
// ---------------------------------------------------------------------------

export interface RevokeOpts {
  target?: string;
}

export async function actRevoke(
  deps: ActionDeps,
  pack: string,
  capability: string,
  opts: RevokeOpts,
): Promise<void> {
  const cap = parseCapability(capability);
  if (cap === null) {
    deps.err(
      `opensquid permissions revoke: unknown capability "${capability}" — must be one of ${Capability.options.join('|')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const existing = await readOverridesFile(deps.paths.overridesPath);
  const next = existing.filter((o) => {
    if (o.pack !== pack) return true;
    if (o.capability !== cap) return true;
    if (opts.target !== undefined && o.target !== opts.target) return true;
    return false;
  });
  const removed = existing.length - next.length;
  if (removed === 0) {
    deps.err(
      `opensquid permissions revoke: no override matches pack="${pack}" capability="${cap}"${
        opts.target !== undefined ? ` target="${opts.target}"` : ''
      }\n`,
    );
    process.exitCode = 1;
    return;
  }
  await writeOverridesFile(deps.paths.overridesPath, next);
  deps.out(
    JSON.stringify({ revoked: removed, pack, capability: cap, target: opts.target }, null, 2) +
      '\n',
  );
}

// ---------------------------------------------------------------------------
// audit-log appender — exported so the runtime gate's `auditLog` callback
// can write file-based entries until CLI.5 ships the libsql sink.
// ---------------------------------------------------------------------------

export async function recordAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  await appendAuditEntry(path, entry);
}
