/**
 * SLC.4 — proof-tests for the additive status-line snapshot writer (SLC.2) + the documented paste-block (SLC.3).
 * Every seam is INJECTED (no `.opensquid` home, no live DB, no `node` spawn); the fail-open contract is forced
 * deterministically via a temp path that makes the real `atomicWriteFile` throw. The coverage authority for
 * `R-SLC-SNAPSHOT` / `R-SLC-REFRESH`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  writeStatuslineSnapshot,
  refreshStatuslineSnapshot,
  STATUSLINE_SNAPSHOT_FILE,
} from './statusline_snapshot.js';
import { emitMonitorEvent } from './monitor_emit.js';
import type { LoopStateItem } from './loop_state.js';

const NOW = 1_000_000;
const one: LoopStateItem = {
  wgId: 'wg-x',
  stage: 'code',
  phase: 'test',
  phaseIndex: 4,
  phaseTotal: 7,
  lifecycle: 'running',
  lastActivityMs: NOW,
  updatedAt: NOW,
  terminal: false,
};

describe('writeStatuslineSnapshot (SLC.2 — injected seams, no home/DB I/O)', () => {
  it('writes the SLC.1 fragment to <dir>/loop-statusline via the injected write seam', async () => {
    const writes: [string, string][] = [];
    await writeStatuslineSnapshot('/proj', NOW, {
      collect: () => Promise.resolve([one]),
      resolveDir: () => Promise.resolve('/proj/.opensquid'),
      write: (p, d) => {
        writes.push([p, d]);
        return Promise.resolve();
      },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe(join('/proj/.opensquid', STATUSLINE_SNAPSHOT_FILE));
    expect(writes[0]?.[1]).toContain('🦑 ');
    expect(writes[0]?.[1]).toContain('wg-x · code · test (4/7) ⟳');
  });

  it('publishes "" when the board is all-terminal (the pill blanks — graceful drain)', async () => {
    const writes: string[] = [];
    await writeStatuslineSnapshot('/p', NOW, {
      collect: () =>
        Promise.resolve([{ wgId: 'wg-y', stage: 'done', updatedAt: NOW, terminal: true }]),
      resolveDir: () => Promise.resolve('/p'),
      write: (_p, d) => {
        writes.push(d);
        return Promise.resolve();
      },
    });
    expect(writes[0]).toBe('');
  });

  it('propagates a write fault (so the fail-open wrapper has something to catch)', async () => {
    await expect(
      writeStatuslineSnapshot('/p', NOW, {
        collect: () => Promise.resolve([one]),
        resolveDir: () => Promise.resolve('/p'),
        write: () => Promise.reject(new Error('disk full')),
      }),
    ).rejects.toThrow('disk full');
  });
});

describe('refreshStatuslineSnapshot / emitMonitorEvent (SLC.2 — fail-open at the choke-point)', () => {
  const prevRoot = process.env.OPENSQUID_PROJECT_ROOT;

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = prevRoot;
    vi.restoreAllMocks();
  });

  // Point the project root at a regular FILE, so `resolveLocalStoreDir` returns `<file>/.opensquid` and the real
  // `atomicWriteFile`'s `mkdir` fails with ENOTDIR — a deterministic, hermetic write fault.
  async function forceWriteFault(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'sl-fault-'));
    const asFile = join(dir, 'not-a-dir');
    await writeFile(asFile, 'x', 'utf8');
    process.env.OPENSQUID_PROJECT_ROOT = asFile;
  }

  it('refreshStatuslineSnapshot swallows a write fault and logs to stderr (never throws)', async () => {
    await forceWriteFault();
    let logged = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logged += String(chunk);
      return true;
    });
    await expect(refreshStatuslineSnapshot()).resolves.toBeUndefined();
    expect(logged).toContain('[statusline] snapshot refresh failed (ignored)');
  });

  it('emitMonitorEvent resolves even when the snapshot refresh faults (emit isolation)', async () => {
    await forceWriteFault();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // A snapshot render/write fault must NEVER propagate out of the load-bearing state-change emit.
    await expect(
      emitMonitorEvent({ kind: 'stage_advance', wgId: 'wg-iso', stage: 'code', atMs: NOW }),
    ).resolves.toBeUndefined();
  });
});

describe('the documented additive paste-block (SLC.3 — sh -c against a temp fragment)', () => {
  // Execute the REAL block documented in docs/loop-status-feed.md (extracted, not a paraphrase — keep in sync).
  async function docBlock(): Promise<string> {
    const docPath = fileURLToPath(new URL('../../../docs/loop-status-feed.md', import.meta.url));
    const doc = await readFile(docPath, 'utf8');
    const m = /# --- opensquid loop pill[\s\S]*?# --- end opensquid loop pill ---/.exec(doc);
    if (m === null) throw new Error('paste-block not found in docs/loop-status-feed.md');
    return `out="base"\n${m[0]}\nprintf '%s' "$out"`;
  }

  async function runIn(cwd: string): Promise<string> {
    return execFileSync('sh', ['-c', await docBlock()], { cwd, encoding: 'utf8' });
  }

  async function project(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'sl-pill-'));
    await mkdir(join(root, '.opensquid'), { recursive: true });
    return root;
  }
  const fragPath = (root: string): string => join(root, '.opensquid', 'loop-statusline');

  it('appends a dim pill when the fragment is FRESH and non-empty', async () => {
    const root = await project();
    await writeFile(fragPath(root), '🦑 wg-x · code · test (4/7) ⟳ · 3m ago', 'utf8');
    const out = await runIn(root);
    expect(out).toContain('wg-x · code · test (4/7) ⟳');
  });

  it('shows NO pill when the fragment is STALE (mtime older than 2 min)', async () => {
    const root = await project();
    await writeFile(fragPath(root), '🦑 wg-x · code', 'utf8');
    const old = NOW / 1000; // ~1970 — deterministically stale, no real sleep
    utimesSync(fragPath(root), old, old);
    expect(await runIn(root)).toBe('base');
  });

  it('shows NO pill when the fragment is MISSING (no file)', async () => {
    const root = await project(); // .opensquid exists, but no loop-statusline
    expect(await runIn(root)).toBe('base');
  });

  it('shows NO pill when the fragment is EMPTY (a drained board)', async () => {
    const root = await project();
    await writeFile(fragPath(root), '', 'utf8');
    expect(await runIn(root)).toBe('base');
  });
});
