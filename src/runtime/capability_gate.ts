/**
 * Capability gate (AUTO.3) — POSIX-style declared-capability check.
 * Spec: `docs/tasks/automation.md` AUTO.3.
 *
 * Precedence: builtin-deny → pack-deny → pack-allow → prompt → deny+audit.
 * Engine-vocabulary: gate speaks in `(pack, capability, target)` only.
 *
 * Risk postures (locked at AUTO.3):
 *   - Shell metacharacters (`; && || $() backticks | > >> <(`) blanket-
 *     reject unless the exact raw command is in the allowlist; SEC.4 ships
 *     full `shell-quote` argv parser.
 *   - HTTP allowlist match is on `new URL(target).hostname` (never glob on
 *     raw URL — foot-gun: `api.github.com.attacker.com`).
 *   - Parse failures + prompt-throw + audit-throw all DENY (constraint C10).
 *
 * Audit: every verdict flows through `auditLog`. CLI.5 lands the libsql
 * `audit_log` table; AUTO.3 ships the interface (no-op default).
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { minimatch } from 'minimatch';

import type {
  Capability,
  FileWritePermissionType,
  HttpRequestPermissionType,
  PermissionsType,
  SendMessagePermissionType,
  ShellExecPermissionType,
  SubagentCallPermissionType,
  SubprocessCallPermissionType,
} from '../packs/schemas/index.js';

import {
  BUILTIN_BINARY_DENY,
  BUILTIN_CHANNEL_DENY,
  BUILTIN_PATH_DENY,
  BUILTIN_SHELL_DENY,
  BUILTIN_SUBAGENT_DENY,
  SHELL_METACHARACTERS,
  trustBuiltinDeny,
} from './builtin_denylist.js';

// `target` = per-cap subject (command/URL/path/channel/binary); `method`
// only used by http_request.
export interface CapabilityRequest {
  pack: string;
  capability: Capability;
  target: string;
  method?: string;
  context?: Record<string, unknown>;
}

export interface CapabilityVerdict {
  allowed: boolean;
  source: 'declared' | 'user_approved' | 'user_override' | 'denied' | 'denylist';
  message?: string;
}
export type PromptCallback = (req: CapabilityRequest) => Promise<boolean>;
export type AuditLog = (verdict: CapabilityVerdict, req: CapabilityRequest) => void;

export interface PackPermissions {
  name: string;
  permissions?: PermissionsType;
}

/**
 * User-side capability override (CLI.4). Persisted in
 * `~/.opensquid/permission_overrides.yaml` and merged into the gate by
 * `applyOverrides()` (see `src/setup/cli/permissions_state.ts`).
 *
 * Each override grants `(pack, capability, target-glob)`. The CLI is
 * forbidden from persisting overrides that match the built-in denylist —
 * the gate still applies its built-in deny FIRST, so even a malicious
 * write to the overrides file can never escape the sealed denylist
 * unless `OPENSQUID_TRUST_BUILTIN_DENY=0` is set.
 */
export interface UserOverride {
  pack: string;
  capability: Capability;
  target: string;
}

export interface CapabilityGateOpts {
  packs: Map<string, PackPermissions>;
  prompt?: PromptCallback;
  auditLog?: AuditLog;
  /** Snapshot of env-var trust flag (constant per-instance). */
  trustBuiltinDeny?: boolean;
  /** Override `~/...` expansion target (defaults to os.homedir()). */
  homeDir?: string;
  /**
   * User-side overrides (CLI.4). Applied AFTER built-in deny + pack
   * deny, BEFORE pack allowlist. Override-matched verdicts carry
   * `source: 'user_override'` for audit-log triage.
   */
  overrides?: readonly UserOverride[];
}

function noopAudit(): void {
  /* default audit sink (named to satisfy eslint no-empty-function) */
}

function safeParseUrl(target: string): URL | null {
  try {
    return new URL(target);
  } catch {
    return null;
  }
}

// Hostname allowlist: exact OR `*.<suffix>` subdomain. The foot-gun
// `api.github.com.attacker.com` is rejected (its hostname is .attacker.com).
function matchHostname(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname.endsWith(`.${suffix}`);
  }
  return false;
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return resolve(home, path.slice(2));
  return path;
}

// Matchers are pure; `check()` is async only for the prompt callback.
export class CapabilityGate {
  private readonly packs: Map<string, PackPermissions>;
  private readonly prompt: PromptCallback | undefined;
  private readonly auditLogFn: AuditLog;
  private readonly trustBuiltinDeny: boolean;
  private readonly homeDir: string;
  private readonly overrides: readonly UserOverride[];

  constructor(opts: CapabilityGateOpts) {
    this.packs = opts.packs;
    this.prompt = opts.prompt;
    this.auditLogFn = opts.auditLog ?? noopAudit;
    this.trustBuiltinDeny = opts.trustBuiltinDeny ?? trustBuiltinDeny();
    this.homeDir = opts.homeDir ?? homedir();
    this.overrides = opts.overrides ?? [];
  }

  async check(req: CapabilityRequest): Promise<CapabilityVerdict> {
    const block = this.packs.get(req.pack)?.permissions?.[req.capability];

    if (this.trustBuiltinDeny) {
      const builtinDeny = this.matchBuiltinDeny(req);
      if (builtinDeny) {
        return this.audit({ allowed: false, source: 'denylist', message: builtinDeny }, req);
      }
    }

    // Pack-local deny wins over user overrides (a pack author explicitly
    // forbidding a pattern shouldn't be silently undermined by an old
    // override file). User override wins over pack allowlist gaps.
    if (block) {
      const packDeny = this.matchPackDeny(req, block);
      if (packDeny) {
        return this.audit({ allowed: false, source: 'denylist', message: packDeny }, req);
      }
    }

    const override = this.matchOverride(req);
    if (override) {
      return this.audit({ allowed: true, source: 'user_override', message: override }, req);
    }

    if (!block) return this.handleUndeclared(req);

    const declared = this.matchAllowlist(req, block);
    if (declared) return this.audit({ allowed: true, source: 'declared', message: declared }, req);

    return this.handleUndeclared(req);
  }

  private matchOverride(req: CapabilityRequest): string | null {
    for (const o of this.overrides) {
      if (o.pack !== req.pack) continue;
      if (o.capability !== req.capability) continue;
      // http_request override: hostname-exact OR `*.<suffix>` (parity with
      // pack allowlist; never raw-URL glob — foot-gun guard).
      if (req.capability === 'http_request') {
        const url = safeParseUrl(req.target);
        if (url === null) continue;
        if (matchHostname(url.hostname, o.target)) {
          return `user override: ${url.hostname} matches "${o.target}"`;
        }
        continue;
      }
      // file_write override: ~-expand + minimatch with dot:true (parity
      // with declared allowlist + pack-local deny matchPathList).
      if (req.capability === 'file_write') {
        const expanded = resolve(expandHome(req.target, this.homeDir));
        const expandedPattern = resolve(expandHome(o.target, this.homeDir));
        if (minimatch(expanded, expandedPattern, { dot: true })) {
          return `user override: matches "${o.target}"`;
        }
        continue;
      }
      // shell_exec override: exact OR glob, but the SHELL_METACHARACTERS
      // gate still applies (an override cannot un-block metachars unless
      // it's an exact-match like the declared allowlist semantic).
      if (req.capability === 'shell_exec') {
        if (o.target === req.target) return `user override exact: "${o.target}"`;
        let hasMeta = false;
        for (const meta of SHELL_METACHARACTERS) {
          if (req.target.includes(meta)) {
            hasMeta = true;
            break;
          }
        }
        if (hasMeta) continue;
        if (minimatch(req.target, o.target)) return `user override glob: "${o.target}"`;
        continue;
      }
      // send_message / subprocess_call / subagent_call → minimatch glob
      // on the raw target (parity with `matchGlobList`).
      if (minimatch(req.target, o.target)) return `user override: matches "${o.target}"`;
    }
    return null;
  }

  private matchBuiltinDeny(req: CapabilityRequest): string | null {
    switch (req.capability) {
      case 'shell_exec':
        for (const re of BUILTIN_SHELL_DENY) {
          if (re.test(req.target)) return `built-in shell deny: matches ${re.source}`;
        }
        return null;
      case 'file_write':
        return this.matchPathList(req.target, BUILTIN_PATH_DENY, 'built-in path deny');
      case 'send_message':
        return matchGlobList(req.target, BUILTIN_CHANNEL_DENY, 'built-in channel deny');
      case 'subprocess_call':
        return matchGlobList(req.target, BUILTIN_BINARY_DENY, 'built-in binary deny');
      case 'subagent_call':
        return matchGlobList(req.target, BUILTIN_SUBAGENT_DENY, 'built-in subagent deny');
      case 'http_request':
        // Parse-failure → deny (C10: no silent fail-open).
        if (safeParseUrl(req.target) === null) return `invalid URL "${req.target}"`;
        return null;
      default: {
        const _exhaustive: never = req.capability;
        return `unknown capability ${String(_exhaustive)}`;
      }
    }
  }

  private matchPackDeny(req: CapabilityRequest, block: PermBlock): string | null {
    const denies = block.deny ?? [];
    if (denies.length === 0) return null;
    if (req.capability === 'shell_exec') {
      for (const pattern of denies) {
        if (minimatch(req.target, pattern)) return `pack-local shell deny: matches "${pattern}"`;
      }
      return null;
    }
    if (req.capability === 'file_write') {
      return this.matchPathList(req.target, denies, 'pack-local path deny');
    }
    return matchGlobList(req.target, denies, 'pack-local deny');
  }

  // Shared file-path matcher: expand `~`, resolve, minimatch both sides.
  private matchPathList(target: string, patterns: readonly string[], label: string): string | null {
    const expanded = resolve(expandHome(target, this.homeDir));
    for (const pattern of patterns) {
      const expandedPattern = resolve(expandHome(pattern, this.homeDir));
      if (minimatch(expanded, expandedPattern, { dot: true })) {
        return `${label}: matches "${pattern}"`;
      }
    }
    return null;
  }

  private matchAllowlist(req: CapabilityRequest, block: PermBlock): string | null {
    if (req.capability === 'shell_exec') {
      const cmds = (block as ShellExecPermissionType).commands ?? [];
      const exact = cmds.find((c) => c === req.target);
      if (exact !== undefined) return `shell allowlist exact: "${exact}"`;
      // Metachar gate (replaced by shell-quote argv parser in SEC.4).
      for (const meta of SHELL_METACHARACTERS) {
        if (req.target.includes(meta)) return null;
      }
      for (const pattern of cmds) {
        if (minimatch(req.target, pattern)) return `shell allowlist glob: "${pattern}"`;
      }
      return null;
    }
    if (req.capability === 'http_request') {
      const perm = block as HttpRequestPermissionType;
      const url = safeParseUrl(req.target);
      if (url === null) return null;
      const method = (req.method ?? 'GET').toUpperCase();
      const methods = perm.methods ?? ['GET'];
      if (!methods.includes(method as (typeof methods)[number])) return null;
      for (const pattern of perm.domains ?? []) {
        if (matchHostname(url.hostname, pattern)) {
          return `http allowlist: ${url.hostname} matches "${pattern}" (${method})`;
        }
      }
      return null;
    }
    if (req.capability === 'file_write') {
      const paths = (block as FileWritePermissionType).paths ?? [];
      return this.matchPathList(req.target, paths, 'file allowlist');
    }
    if (req.capability === 'send_message') {
      const channels = (block as SendMessagePermissionType).channels ?? [];
      return matchGlobList(req.target, channels, 'channel allowlist');
    }
    if (req.capability === 'subprocess_call') {
      const bins = (block as SubprocessCallPermissionType).binaries ?? [];
      return matchGlobList(req.target, bins, 'binary allowlist');
    }
    if (req.capability === 'subagent_call') {
      const targets = (block as SubagentCallPermissionType).targets ?? [];
      return matchGlobList(req.target, targets, 'subagent allowlist');
    }
    const _exhaustive: never = req.capability;
    return `unknown capability ${String(_exhaustive)}`;
  }

  // Undeclared: prompt callback OR deny+audit. C10: prompt-throw +
  // audit-throw both DENY (never fail-open).
  private async handleUndeclared(req: CapabilityRequest): Promise<CapabilityVerdict> {
    if (!this.prompt) {
      return this.audit(
        denied(`undeclared "${req.capability}" for pack "${req.pack}" (non-interactive)`),
        req,
      );
    }
    try {
      const approved = await this.prompt(req);
      return this.audit(
        approved
          ? {
              allowed: true,
              source: 'user_approved',
              message: `user approved "${req.capability}" → "${req.target}"`,
            }
          : denied(`user denied "${req.capability}" → "${req.target}"`),
        req,
      );
    } catch (e) {
      return this.audit(denied(`prompt threw — deny (C10): ${String(e)}`), req);
    }
  }

  private audit(verdict: CapabilityVerdict, req: CapabilityRequest): CapabilityVerdict {
    try {
      this.auditLogFn(verdict, req);
    } catch {
      // Audit-sink errors NEVER influence the verdict (constraint C10).
    }
    return verdict;
  }
}

type PermBlock =
  | ShellExecPermissionType
  | HttpRequestPermissionType
  | FileWritePermissionType
  | SendMessagePermissionType
  | SubprocessCallPermissionType
  | SubagentCallPermissionType;

function matchGlobList(target: string, patterns: readonly string[], label: string): string | null {
  for (const pattern of patterns) {
    if (minimatch(target, pattern)) return `${label}: matches "${pattern}"`;
  }
  return null;
}

function denied(message: string): CapabilityVerdict {
  return { allowed: false, source: 'denied', message };
}
