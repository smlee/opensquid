/**
 * UPD.1 (T-npm-auto-update, wg-7091e922881b) — the update-check layer:
 * cache round-trip, staleness, the 24h-throttled notice line, the
 * READ-MERGE-WRITE refresh (the notified_at race pin the spec-audit
 * demanded), and the fail-quiet probe against a stubbed fetch.
 *
 * Plus the design's grep pin: no hook bin / MCP server / daemon worker
 * entrypoint may import update_check (the no-network-in-hooks line).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHANGELOG_URL,
  isStale,
  noticeLine,
  probeLatest,
  readCurrentVersion,
  readUpdateCache,
  refreshCache,
  updateCachePath,
  writeUpdateCache,
} from './update_check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let home: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-updcheck-'));
  process.env.OPENSQUID_HOME = home;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const NOW = Date.parse('2026-06-11T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('cache round-trip', () => {
  it('write → read returns the same cache; missing/corrupt → null', async () => {
    expect(await readUpdateCache()).toBeNull();
    await writeUpdateCache({ latest: '0.5.401', checked_at: iso(NOW) });
    expect(await readUpdateCache()).toEqual({ latest: '0.5.401', checked_at: iso(NOW) });
    // Corrupt → null, no throw.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(dirname(updateCachePath()), { recursive: true });
    await writeFile(updateCachePath(), '{not json', 'utf8');
    expect(await readUpdateCache()).toBeNull();
  });
});

describe('isStale', () => {
  it('null / old / unparsable → true; fresh → false', () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale({ latest: 'x', checked_at: iso(NOW - 25 * 3600_000) }, NOW)).toBe(true);
    expect(isStale({ latest: 'x', checked_at: 'garbage' }, NOW)).toBe(true);
    expect(isStale({ latest: 'x', checked_at: iso(NOW - 3600_000) }, NOW)).toBe(false);
  });
});

describe('noticeLine', () => {
  const fresh = { latest: '0.5.401', checked_at: iso(NOW) };

  it('newer cached version → the line (versions + verb + changelog url)', () => {
    const line = noticeLine(fresh, '0.5.400', NOW);
    expect(line).toContain('0.5.400 → 0.5.401');
    expect(line).toContain('opensquid update');
    expect(line).toContain(CHANGELOG_URL);
  });

  it('24h throttle: notified 1h ago → null; 25h ago → line', () => {
    expect(noticeLine({ ...fresh, notified_at: iso(NOW - 3600_000) }, '0.5.400', NOW)).toBeNull();
    expect(
      noticeLine({ ...fresh, notified_at: iso(NOW - 25 * 3600_000) }, '0.5.400', NOW),
    ).not.toBeNull();
  });

  it('equal/older/garbage versions → null', () => {
    expect(noticeLine(fresh, '0.5.401', NOW)).toBeNull();
    expect(noticeLine(fresh, '0.5.402', NOW)).toBeNull();
    expect(noticeLine({ latest: 'not-semver', checked_at: iso(NOW) }, '0.5.400', NOW)).toBeNull();
    expect(noticeLine(fresh, 'not-semver', NOW)).toBeNull();
    expect(noticeLine(null, '0.5.400', NOW)).toBeNull();
  });
});

describe('refreshCache — the notified_at race pin (READ-MERGE-WRITE)', () => {
  it('preserves a prior notified_at so the 24h throttle survives a refresh', async () => {
    await writeUpdateCache({
      latest: '0.5.401',
      checked_at: iso(NOW - 25 * 3600_000),
      notified_at: iso(NOW - 3600_000), // notified 1h ago
    });
    await refreshCache('0.5.402', iso(NOW));
    const after = await readUpdateCache();
    expect(after).toEqual({
      latest: '0.5.402',
      checked_at: iso(NOW),
      notified_at: iso(NOW - 3600_000), // PRESERVED
    });
    // The throttle still holds on the merged cache.
    expect(noticeLine(after, '0.5.400', NOW)).toBeNull();
  });

  it('over an absent cache writes without notified_at', async () => {
    await refreshCache('0.5.402', iso(NOW));
    expect(await readUpdateCache()).toEqual({ latest: '0.5.402', checked_at: iso(NOW) });
  });
});

describe('probeLatest (stubbed fetch)', () => {
  const fetchResult = (ok: boolean, body: unknown): unknown => ({
    ok,
    json: () => Promise.resolve(body),
  });

  it('ok → version; non-200 → null; reject → null; garbage version → null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(fetchResult(true, { version: '0.5.401' }))),
    );
    expect(await probeLatest()).toBe('0.5.401');

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(fetchResult(false, {}))),
    );
    expect(await probeLatest()).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    expect(await probeLatest()).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(fetchResult(true, { version: 'not-semver' }))),
    );
    expect(await probeLatest()).toBeNull();
  });
});

describe('readCurrentVersion', () => {
  it('returns the real package.json version', async () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      version: string;
    };
    expect(await readCurrentVersion()).toBe(pkg.version);
  });
});

describe('no-network-in-hooks grep pin', () => {
  it('no hook bin / MCP server / daemon worker imports update_check', () => {
    const forbidden = [
      ...readdirSync(resolve(__dirname, 'hooks'))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => resolve(__dirname, 'hooks', f)),
      resolve(__dirname, '../mcp/server.ts'),
      resolve(__dirname, '../mcp/chat-bridge-server.ts'),
    ];
    for (const f of forbidden) {
      expect(readFileSync(f, 'utf8')).not.toContain('update_check');
    }
  });
});
