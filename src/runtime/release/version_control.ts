/**
 * Role: resolve the project's version-control topology from active.json.
 * Context: ActiveJson `version-control.environments` (+ legacy top-level `versioning`).
 * Constraints: presence of staging IS the stage toggle; no hardcoded main/stage; production required.
 * Output: resolved environments + optional locked-prefix versioning, or a typed error.
 *
 * Guess-free: every default is named here (local → production when unset). No invented branches.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { VersioningConfig } from '../../packs/discovery.js';

/** Branch-name strings the user named at setup. Presence of staging toggles the stage hop. */
export interface Environments {
  production?: string;
  staging?: string;
  local?: string;
}

/** On-disk `version-control` block under active.json. */
export interface VersionControlBlock {
  environments?: Environments;
  /** Locked-prefix versioning folded under version-control (legacy top-level still read). */
  versioning?: VersioningConfig;
}

/** Fully resolved topology after defaults. */
export interface ResolvedEnvironments {
  production: string;
  /** Present only when configured — presence is the has-stage toggle. */
  staging?: string;
  local: string;
}

export interface ResolveError {
  ok: false;
  reason: string;
}
export interface ResolveOk {
  ok: true;
  environments: ResolvedEnvironments;
}
export type ResolveResult = ResolveOk | ResolveError;

/**
 * Role: pure resolve of environments → deterministic topology.
 * Context: raw optional env names from config.
 * Constraints: production required (non-empty); staging optional; local defaults to production when unset.
 * Output: ResolveResult.
 */
export function resolveEnvironments(raw: Environments | undefined | null): ResolveResult {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'version-control.environments is absent' };
  }
  const production = trimOrEmpty(raw.production);
  if (production === '') {
    return { ok: false, reason: 'version-control.environments.production is required' };
  }
  const stagingRaw = trimOrEmpty(raw.staging);
  const localRaw = trimOrEmpty(raw.local);
  const environments: ResolvedEnvironments = {
    production,
    local: localRaw === '' ? production : localRaw,
    ...(stagingRaw === '' ? {} : { staging: stagingRaw }),
  };
  return { ok: true, environments };
}

/** Deterministic PR/integration plan from resolved environments. One path, parameterized. */
export interface IntegrationPlan {
  /** Accumulation target the item must land on for SHIPPED. */
  target: string;
  /** Source of auto-PR head (staging if set, else local). */
  prHead: string;
  /** Always production — human merge gate. */
  prBase: string;
  /** True when staging is configured. */
  hasStaging: boolean;
  production: string;
  local: string;
  staging?: string;
}

export function integrationPlan(env: ResolvedEnvironments): IntegrationPlan {
  if (env.staging !== undefined) {
    return {
      target: env.staging,
      prHead: env.staging,
      prBase: env.production,
      hasStaging: true,
      production: env.production,
      local: env.local,
      staging: env.staging,
    };
  }
  return {
    target: env.local,
    prHead: env.local,
    prBase: env.production,
    hasStaging: false,
    production: env.production,
    local: env.local,
  };
}

export interface VersionControlConfig {
  environments: ResolvedEnvironments;
  plan: IntegrationPlan;
  versioning: VersioningConfig | null;
}

/**
 * Role: read version-control (+ folded/legacy versioning) from a scope's active.json.
 * Context: scopeRoot path or null.
 * Constraints: lenient on absent/malformed → null (caller fails visibly); never throws.
 * Output: VersionControlConfig | null.
 */
export async function readVersionControl(
  scopeRoot: string | null,
): Promise<VersionControlConfig | null> {
  if (scopeRoot === null) return null;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const json = JSON.parse(raw) as {
      'version-control'?: VersionControlBlock;
      versioning?: VersioningConfig;
    };
    const block = json['version-control'];
    const envRaw = block?.environments;
    const resolved = resolveEnvironments(envRaw);
    if (!resolved.ok) return null;
    const versioning = parseVersioning(block?.versioning ?? json.versioning);
    return {
      environments: resolved.environments,
      plan: integrationPlan(resolved.environments),
      versioning,
    };
  } catch {
    return null;
  }
}

/** Write/merge version-control into active.json (setup wizard). Preserves other keys. */
export async function writeVersionControl(
  scopeRoot: string,
  block: VersionControlBlock,
): Promise<void> {
  await fs.mkdir(scopeRoot, { recursive: true });
  const path = join(scopeRoot, 'active.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    existing = { packs: [] };
  }
  const next: Record<string, unknown> = { ...existing, 'version-control': block };
  // Keep top-level versioning in sync when folded under version-control (back-compat readers).
  if (block.versioning !== undefined) {
    next.versioning = block.versioning;
  }
  await fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

function trimOrEmpty(v: string | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parseVersioning(v: VersioningConfig | undefined): VersioningConfig | null {
  if (
    v?.strategy === 'locked-prefix' &&
    typeof v.prefix === 'string' &&
    v.prefix.trim().length > 0
  ) {
    return { strategy: 'locked-prefix', prefix: v.prefix, bump: v.bump ?? 'patch-per-release' };
  }
  return null;
}
