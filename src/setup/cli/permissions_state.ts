/**
 * Permission override + audit persistence helpers for CLI.4.
 *
 * Split out of `permissions.ts` (file-size budget). Four concerns:
 *
 *   1. `readOverridesFile` / `writeOverridesFile` — load + atomically rewrite
 *      `~/.opensquid/permission_overrides.yaml`. Schema:
 *
 *        overrides:
 *          - pack: ci
 *            capability: shell_exec
 *            target: "pnpm test"
 *            granted_at: "2026-05-20T12:00:00.000Z"
 *
 *      Atomic write via `tmp + rename` matches the webhooks.yaml +
 *      schedules.yaml + trigger_state.yaml pattern.
 *
 *   2. `appendAuditEntry` / `readAuditEntries` — `~/.opensquid/
 *      permission_audit.jsonl`. CLI.4 ships the FILE-based audit-log
 *      surface; CLI.5 replaces this with the libsql `audit_log` table
 *      under the unified `category: capability_gate` row. The on-disk
 *      shape here is deliberately a subset of the CLI.5 column set so
 *      the migration is `INSERT INTO audit_log SELECT ...` and not a
 *      schema change.
 *
 *   3. `enumerateManifests` — walk `~/.opensquid/packs/<id>/manifest.yaml`
 *      and parse each through the `Manifest` schema (NOT through
 *      `loadPack`, which discards `manifest.permissions`). Returns the
 *      validated manifests so `permissions list` can render per-pack
 *      declared capabilities + their user overrides side-by-side.
 *
 *   4. `denylistRejectionFor` — central guard used by `grant`. Returns
 *      the human-readable rejection message if a `(capability, target)`
 *      pair would be blocked by the sealed built-in denylist; null if
 *      safe to persist. Honors `OPENSQUID_TRUST_BUILTIN_DENY=0` escape
 *      flag for parity with the gate.
 *
 * The override file is read by the daemon at gate-construction time
 * (wired via `CapabilityGateOpts.overrides`); the CLI is the
 * authoritative writer. We intentionally do NOT mutate pack manifests
 * — overrides are user-side state, separate from pack identity.
 *
 * Imports from: node:fs/promises, yaml, ../../packs/schemas/index,
 *   ../../packs/yaml, ../../runtime/builtin_denylist,
 *   ../../runtime/capability_gate, ../../runtime/paths.
 * Imported by: src/setup/cli/permissions.ts +
 *   src/setup/cli/permissions_actions.ts.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { minimatch } from 'minimatch';

import { parseYamlFile } from '../../packs/yaml.js';
import { Manifest, type Capability, type ManifestType } from '../../packs/schemas/index.js';
import {
  BUILTIN_BINARY_DENY,
  BUILTIN_CHANNEL_DENY,
  BUILTIN_PATH_DENY,
  BUILTIN_SHELL_DENY,
  BUILTIN_SUBAGENT_DENY,
  trustBuiltinDeny,
} from '../../runtime/builtin_denylist.js';
import type { UserOverride } from '../../runtime/capability_gate.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';

import { walkPacksDir } from './pack_walk.js';

import {
  appendJsonlEntry,
  readJsonlEntries,
  readKeyedYamlList,
  writeKeyedYamlList,
} from './state_io.js';

/** One row in `permission_overrides.yaml`. */
export interface OverrideRecord {
  pack: string;
  capability: Capability;
  target: string;
  granted_at: string;
}

/** One row in `permission_audit.jsonl`. Mirrors the CLI.5 audit_log columns. */
export interface AuditEntry {
  occurred_at_ms: number;
  category: 'capability_gate';
  decision: 'allowed' | 'denied' | 'prompted';
  pack: string;
  capability: Capability;
  target: string;
  source: 'declared' | 'user_approved' | 'user_override' | 'denied' | 'denylist';
  message?: string;
}

export const defaultOverridesPath = (): string =>
  join(OPENSQUID_HOME(), 'permission_overrides.yaml');

export const defaultAuditPath = (): string => join(OPENSQUID_HOME(), 'permission_audit.jsonl');

export const defaultPacksDir = (): string => join(OPENSQUID_HOME(), 'packs');

// ---------------------------------------------------------------------------
// permission_overrides.yaml — read / write
// ---------------------------------------------------------------------------

const isOverrideRecord = (v: unknown): v is OverrideRecord =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as OverrideRecord).pack === 'string' &&
  typeof (v as OverrideRecord).capability === 'string' &&
  typeof (v as OverrideRecord).target === 'string';

export async function readOverridesFile(path: string): Promise<OverrideRecord[]> {
  return readKeyedYamlList<OverrideRecord>(
    path,
    'overrides',
    'permission_overrides.yaml',
    isOverrideRecord,
  );
}

/**
 * Atomic write — delegates to `writeKeyedYamlList` (T-SIC L9 byte-preserves
 * the `overrides: []\n` empty form). Callers MUST pass the FULL desired
 * override set; we never merge here to avoid dropping unrelated overrides
 * on concurrent CLI invocations.
 */
export async function writeOverridesFile(
  path: string,
  overrides: readonly OverrideRecord[],
): Promise<void> {
  return writeKeyedYamlList(path, 'overrides', overrides);
}

/** Convert persisted `OverrideRecord[]` into the runtime `UserOverride[]`
 *  shape consumed by `CapabilityGateOpts.overrides`. The `granted_at`
 *  stamp is for human audit; the gate doesn't need it. */
export function toRuntimeOverrides(records: readonly OverrideRecord[]): UserOverride[] {
  return records.map((r) => ({ pack: r.pack, capability: r.capability, target: r.target }));
}

// ---------------------------------------------------------------------------
// permission_audit.jsonl — append-only ring (CLI.4 only; CLI.5 migrates)
// ---------------------------------------------------------------------------

export async function appendAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  return appendJsonlEntry(path, entry);
}

export async function readAuditEntries(path: string): Promise<AuditEntry[]> {
  return readJsonlEntries<AuditEntry>(path);
}

// ---------------------------------------------------------------------------
// Pack manifest enumeration — list needs `manifest.permissions` which
// `loadPack` discards. We parse manifests directly through the schema.
// ---------------------------------------------------------------------------

export interface ManifestRow {
  packId: string;
  manifest: ManifestType;
}

export function enumerateManifests(packsDir: string): Promise<ManifestRow[]> {
  return walkPacksDir(packsDir, async (dir, name) => {
    const { data } = await parseYamlFile(join(dir, 'manifest.yaml'), Manifest);
    return { packId: name, manifest: data as ManifestType };
  });
}

// ---------------------------------------------------------------------------
// Denylist guard — central gate for `permissions grant`.
//
// Design (audit-critical): the CLI is FORBIDDEN from writing an override
// that matches the sealed built-in denylist. Even if a malicious user
// edits `permission_overrides.yaml` directly, the runtime gate still
// applies built-in deny FIRST — so the file is defense-in-depth, but the
// CLI's `grant` verb is the user-friendly surface that prevents accidental
// "I'll grant my pack `rm -rf /` and see what happens".
//
// Escape hatch: `OPENSQUID_TRUST_BUILTIN_DENY=0` disables the entire
// built-in denylist for the gate AND for this CLI guard, so the
// rejection behavior in `grant` mirrors what the gate would do at
// runtime. We snapshot the env-var ONCE per CLI invocation (via
// `trustBuiltinDeny()`) to match the gate's snapshot semantics.
// ---------------------------------------------------------------------------

export interface DenylistRejection {
  message: string;
}

export function denylistRejectionFor(
  capability: Capability,
  target: string,
  opts: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): DenylistRejection | null {
  if (!trustBuiltinDeny(opts.env ?? process.env)) return null;
  const home = opts.homeDir ?? homedir();
  switch (capability) {
    case 'shell_exec':
      for (const re of BUILTIN_SHELL_DENY) {
        if (re.test(target)) {
          return {
            message:
              `cannot grant shell_exec target "${target}" — matches built-in shell denylist ` +
              `(/${re.source}/). The sealed denylist blocks destructive patterns ` +
              `(rm -rf /, fork bombs, curl|sh, etc.). To override, set ` +
              `OPENSQUID_TRUST_BUILTIN_DENY=0 in the environment (NOT recommended — ` +
              `the gate will then trust pack + user overrides ONLY).`,
          };
        }
      }
      return null;
    case 'file_write': {
      const expandedTarget = resolveHome(target, home);
      for (const pattern of BUILTIN_PATH_DENY) {
        const expandedPattern = resolveHome(pattern, home);
        if (minimatch(expandedTarget, expandedPattern, { dot: true })) {
          return {
            message:
              `cannot grant file_write target "${target}" — matches built-in path denylist ` +
              `("${pattern}"). The sealed denylist blocks system + secret paths ` +
              `(/etc, /usr, ~/.ssh, ~/.aws/credentials, etc.). To override, set ` +
              `OPENSQUID_TRUST_BUILTIN_DENY=0 in the environment.`,
          };
        }
      }
      return null;
    }
    case 'send_message':
      return matchBuiltinGlobList(target, BUILTIN_CHANNEL_DENY, 'send_message', 'channel');
    case 'subprocess_call':
      return matchBuiltinGlobList(target, BUILTIN_BINARY_DENY, 'subprocess_call', 'binary');
    case 'subagent_call':
      return matchBuiltinGlobList(target, BUILTIN_SUBAGENT_DENY, 'subagent_call', 'subagent');
    case 'http_request':
      // http_request has no built-in denylist (parse-failure is the only
      // gate-side deny; an invalid URL would never reach `grant`).
      return null;
    default: {
      const _exhaustive: never = capability;
      return {
        message: `unknown capability "${String(_exhaustive)}" — cannot grant`,
      };
    }
  }
}

function matchBuiltinGlobList(
  target: string,
  patterns: readonly string[],
  capability: string,
  label: string,
): DenylistRejection | null {
  for (const pattern of patterns) {
    if (minimatch(target, pattern)) {
      return {
        message:
          `cannot grant ${capability} target "${target}" — matches built-in ${label} denylist ` +
          `("${pattern}"). To override, set OPENSQUID_TRUST_BUILTIN_DENY=0 in the environment.`,
      };
    }
  }
  return null;
}

function resolveHome(path: string, home: string): string {
  if (path === '~') return resolve(home);
  if (path.startsWith('~/')) return resolve(home, path.slice(2));
  return resolve(path);
}
