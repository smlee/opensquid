/**
 * CLI.4 — `opensquid permissions list|audit|grant|revoke`.
 *
 * Thin commander wiring. Verb bodies live in `./permissions_actions.ts`;
 * persistence + denylist guard helpers in `./permissions_state.ts`. This
 * file ONLY routes commander options/args into the action functions and
 * resolves default paths from `OPENSQUID_HOME()`.
 *
 * Verb semantics (locked):
 *
 *   list    — show every installed pack's `manifest.permissions:` block
 *             alongside any user overrides for that pack. JSON-on-stdout
 *             so callers can `jq` it. `--pack <id>` scopes to one pack.
 *
 *   audit   — query `~/.opensquid/permission_audit.jsonl` with optional
 *             `--since <duration>` (24h, 7d, 30m, 60s) +
 *             `--decision <allowed|denied|prompted>` filters. Newest-
 *             first. CLI.5 swaps this file-based sink for the libsql
 *             `audit_log` table; the wire shape is a deliberate subset
 *             of the CLI.5 columns so migration is `INSERT INTO ...
 *             SELECT ...`.
 *
 *   grant   — append a user-side override to
 *             `~/.opensquid/permission_overrides.yaml` (atomic write).
 *             Built-in denylist patterns are REJECTED at the CLI layer
 *             with an explicit error message — even if a user edits
 *             the file directly, the gate still applies the sealed
 *             denylist first (defense in depth). Escape hatch:
 *             `OPENSQUID_TRUST_BUILTIN_DENY=0` disables BOTH layers
 *             (matching the gate's env snapshot semantics).
 *
 *   revoke  — remove matching overrides. Without `--target`, removes
 *             every override for `(pack, capability)`. With `--target`,
 *             removes only the exact `(pack, capability, target)` row.
 *
 * Imports from: commander, ./permissions_actions, ./permissions_state.
 * Imported by: src/cli.ts.
 */

import {
  actAudit,
  actGrant,
  actList,
  actRevoke,
  defaultPaths,
  type ActionDeps,
  type AuditOpts,
  type GrantOpts,
  type ListOpts,
  type PermissionsPaths,
  type RevokeOpts,
} from './permissions_actions.js';

import type { Command } from 'commander';

export interface PermissionsCliDeps {
  overridesPath?: string;
  auditPath?: string;
  packsDir?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  now?: () => Date;
}

function buildDeps(deps: PermissionsCliDeps): ActionDeps {
  const defaults = defaultPaths();
  const paths: PermissionsPaths = {
    overridesPath: deps.overridesPath ?? defaults.overridesPath,
    auditPath: deps.auditPath ?? defaults.auditPath,
    packsDir: deps.packsDir ?? defaults.packsDir,
  };
  return {
    paths,
    out: deps.stdout ?? ((s) => process.stdout.write(s)),
    err: deps.stderr ?? ((s) => process.stderr.write(s)),
    now: deps.now ?? ((): Date => new Date()),
  };
}

export function registerPermissions(parent: Command, deps: PermissionsCliDeps = {}): Command {
  const ad = buildDeps(deps);
  const p = parent.command('permissions').description('Pack capability declarations + audit');

  p.command('list')
    .description('Show declared permissions + user overrides per pack')
    .option('--pack <pack>', 'limit to a single pack')
    .action((opts: ListOpts) => actList(ad, opts));

  p.command('audit')
    .description('Recent capability-gate decisions (file-based; CLI.5 migrates to libsql)')
    .option('--since <duration>', 'e.g. 24h, 7d, 30m, 60s')
    .option('--decision <kind>', 'allowed|denied|prompted')
    .option('--limit <n>', 'cap result count (default 100)')
    .action((opts: AuditOpts) => actAudit(ad, opts));

  p.command('grant <pack> <capability>')
    .description(
      'User-side override: grant a (pack, capability, target) tuple. Built-in denylist patterns rejected unless OPENSQUID_TRUST_BUILTIN_DENY=0',
    )
    .requiredOption('--target <pattern>', 'e.g. "pnpm test" or "https://api.github.com/**"')
    .action((pack: string, capability: string, opts: GrantOpts) =>
      actGrant(ad, pack, capability, opts),
    );

  p.command('revoke <pack> <capability>')
    .description(
      'Remove user-side override(s). Without --target, removes ALL overrides for (pack, capability)',
    )
    .option('--target <pattern>', 'narrow to a specific target')
    .action((pack: string, capability: string, opts: RevokeOpts) =>
      actRevoke(ad, pack, capability, opts),
    );

  return p;
}
