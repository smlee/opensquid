/**
 * T-npm-auto-update UPD.1 (wg-7091e922881b) — the check layer for the npm
 * rollout: a cached, fail-quiet version probe surfaced as a once-per-day
 * CLI notice and an `opensquid doctor` section.
 *
 * Design locks (per the track pre-research):
 *   - The CLI hot path does ZERO network — it reads the cache file only;
 *     a stale cache spawns a DETACHED refresher (`opensquid update
 *     --check-only`) that writes the cache for the NEXT invocation.
 *   - Hook bins / MCP server / chat-daemon worker NEVER import this module
 *     (a hook must never pay a network call; grep-pinned in the suite).
 *   - `refreshCache` is the refresher's ONLY write path and is
 *     READ-MERGE-WRITE: the cache carries two fields with two writers (the
 *     notice closure stamps `notified_at`; the refresher updates
 *     `latest`/`checked_at`) — a blind refresher write would drop a
 *     concurrent notice stamp and break the 24h throttle.
 *   - Probe failures are SILENT (offline / firewalled / custom registry →
 *     no notice, no harm). Auto-apply is deliberately NOT here — the
 *     update only ever runs as a foreground user-invoked command.
 *
 * Imports from: node:fs/promises, node:path, semver, ./atomic_write.js,
 *   ./paths.js.
 * Imported by: src/cli.ts (notice + doctor), src/setup/cli/update.ts
 *   (--check-only), src/setup/cli/doctor.ts (update section).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import semver from 'semver';

import { atomicWriteFile } from './atomic_write.js';
import { OPENSQUID_HOME } from './paths.js';

export interface UpdateCache {
  /** Latest version seen on the registry. */
  latest: string;
  /** ISO timestamp of the successful probe that wrote this. */
  checked_at: string;
  /** ISO timestamp of the last time the NOTICE was printed (24h throttle). */
  notified_at?: string;
}

export const updateCachePath = (): string => join(OPENSQUID_HOME(), 'update-check.json');

const DAY_MS = 24 * 60 * 60 * 1000;
export const CHANGELOG_URL = 'https://github.com/smlee/opensquid/blob/main/CHANGELOG.md';

export async function readUpdateCache(): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(await readFile(updateCachePath(), 'utf8')) as UpdateCache;
    return typeof parsed.latest === 'string' && typeof parsed.checked_at === 'string'
      ? parsed
      : null;
  } catch {
    return null; // ENOENT / corrupt → treated as absent
  }
}

export async function writeUpdateCache(cache: UpdateCache): Promise<void> {
  try {
    await atomicWriteFile(updateCachePath(), JSON.stringify(cache, null, 2));
  } catch {
    /* best-effort — a cache failure must never break a CLI command */
  }
}

export function isStale(cache: UpdateCache | null, nowMs: number): boolean {
  if (cache === null) return true;
  const t = Date.parse(cache.checked_at);
  return !Number.isFinite(t) || nowMs - t > DAY_MS;
}

/** The notice line, or null (not newer / bad semver / throttled <24h). */
export function noticeLine(
  cache: UpdateCache | null,
  current: string,
  nowMs: number,
): string | null {
  if (cache === null) return null;
  if (semver.valid(cache.latest) === null || semver.valid(current) === null) return null;
  if (!semver.gt(cache.latest, current)) return null;
  const last = cache.notified_at === undefined ? NaN : Date.parse(cache.notified_at);
  if (Number.isFinite(last) && nowMs - last < DAY_MS) return null;
  return (
    `opensquid ${current} → ${cache.latest} available — run \`opensquid update\`. ` +
    `Changelog: ${CHANGELOG_URL}`
  );
}

/**
 * The refresher's ONLY write path — READ-MERGE-WRITE so a concurrent
 * notice's `notified_at` stamp survives the refresh (the 24h-throttle race
 * the spec-audit caught).
 */
export async function refreshCache(latest: string, nowIso: string): Promise<void> {
  const prior = await readUpdateCache();
  await writeUpdateCache({
    latest,
    checked_at: nowIso,
    ...(prior?.notified_at !== undefined ? { notified_at: prior.notified_at } : {}),
  });
}

/** The running package's version — this file lives at <root>/{dist,src}/runtime/,
 *  so package.json is two levels up (same idiom as mcp/server.ts). */
export async function readCurrentVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Fail-quiet registry probe: the latest published version, or null. */
export async function probeLatest(timeoutMs = 3_000): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/opensquid/latest', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' && semver.valid(body.version) !== null
      ? body.version
      : null;
  } catch {
    return null; // offline / firewalled / slow — no notice, no harm
  }
}
