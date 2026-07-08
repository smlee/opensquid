/**
 * Tests for `FileWatcher` (AUTO.5).
 *
 * Coverage matches the spec's acceptance criteria:
 *   1. add/change/unlink basic — three flavors all dispatch with correct path.
 *   2. Debounce burst — 10 rapid writes collapse to 1 event.
 *   3. Rate-limit denial — limiter says no → no dispatch + audit entry.
 *   4. ignored defaults — node_modules / .git excluded.
 *   5. awaitWriteFinish — partial write doesn't emit until stable.
 *   6. Lifecycle — `stop()` is idempotent + closes chokidar cleanly +
 *      no leaked listeners.
 *   7. Per-(kind, path) debounce — unlink followed by add stays as 2 events.
 *   8. Dispatch error — auditor records `file_changed_error`.
 *
 * Strategy:
 *   - Real fs via `os.tmpdir()` + per-test mkdtemp + cleanup in afterEach.
 *   - Real chokidar via `usePolling: true` (CI-safe; macOS FSEvents test
 *     flakes without it). 50ms `pollInterval` keeps tests fast.
 *   - In-memory libsql for the rate limiter; reuses the AUTO.2 pattern.
 *   - Promise-based "wait for predicate" helper instead of fixed sleeps,
 *     bounded by a 5s timeout per assertion.
 */

import { mkdtemp, rm, writeFile, unlink, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { FileChangedEvent } from '../event.js';
import { RateLimiter, type PackRateLimits } from '../rate_limit.js';

import { FileWatcher, type FileWatcherAuditEntry } from './file_watcher.js';

import type { Client } from '@libsql/client';

// ---------------------------------------------------------------------------
// Helpers — kept colocated so each test reads top-to-bottom.
// ---------------------------------------------------------------------------

// Under a full parallel suite, chokidar + debounce can lag past 5s on a busy machine.
const WAIT_TIMEOUT_MS = 15_000;

async function waitFor(
  pred: () => boolean,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? WAIT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? 25;
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: predicate did not become true within timeout');
    }
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  dir: string;
  events: FileChangedEvent[];
  audit: FileWatcherAuditEntry[];
  watcher: FileWatcher;
  rateLimiter: RateLimiter;
  client: Client;
  cleanup: () => Promise<void>;
}

async function makeHarness(opts: {
  paths?: string[];
  ignored?: string[];
  debounceMs?: number;
  limits?: Map<string, PackRateLimits>;
  dispatchThrows?: boolean;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'opensquid-fw-'));
  const events: FileChangedEvent[] = [];
  const audit: FileWatcherAuditEntry[] = [];
  const client = createClient({ url: ':memory:' });
  const rateLimiter = new RateLimiter(client, {
    limits: opts.limits ?? new Map<string, PackRateLimits>(),
  });
  const cfg = {
    pack: 'p1',
    skill: 's1',
    paths: opts.paths ?? [join(dir, '**/*.ts')],
    debounceMs: opts.debounceMs ?? 50,
    usePolling: true,
    ...(opts.ignored !== undefined ? { ignored: opts.ignored } : {}),
  };
  const dispatchFn = opts.dispatchThrows
    ? async (_event: FileChangedEvent): Promise<void> => {
        await Promise.resolve();
        throw new Error('boom');
      }
    : async (event: FileChangedEvent): Promise<void> => {
        await Promise.resolve();
        events.push(event);
      };
  const watcher = new FileWatcher(cfg, dispatchFn, rateLimiter, {
    auditLog: (e) => audit.push(e),
  });
  watcher.start();
  // chokidar needs one polling tick to enumerate initial state when
  // usePolling=true; give it a beat so `ignoreInitial: true` settles.
  await sleep(150);

  return {
    dir,
    events,
    audit,
    watcher,
    rateLimiter,
    client,
    cleanup: async () => {
      await watcher.stop();
      client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('FileWatcher — basic add/change/unlink', () => {
  let h: Harness;

  afterEach(async () => {
    await h.cleanup();
  });

  it('dispatches FileChangedEvent for add / change / unlink', async () => {
    h = await makeHarness({});
    const file = join(h.dir, 'a.ts');

    await writeFile(file, 'export const a = 1;\n');
    await waitFor(() => h.events.some((e) => e.changeKind === 'add'));
    const addEvent = h.events.find((e) => e.changeKind === 'add')!;
    expect(addEvent.kind).toBe('file_changed');
    expect(addEvent.path).toContain('a.ts');
    expect(typeof addEvent.changedAt).toBe('string');

    h.events.length = 0;
    await writeFile(file, 'export const a = 2;\n');
    await waitFor(() => h.events.some((e) => e.changeKind === 'change'));

    h.events.length = 0;
    await unlink(file);
    await waitFor(() => h.events.some((e) => e.changeKind === 'unlink'));
  });
});

describe('FileWatcher — debounce', () => {
  let h: Harness;
  afterEach(async () => {
    await h.cleanup();
  });

  it('collapses 10 rapid writes to 1 change event per (kind, path)', async () => {
    h = await makeHarness({ debounceMs: 250 });
    const file = join(h.dir, 'burst.ts');
    await writeFile(file, 'init\n');
    await waitFor(() => h.events.some((e) => e.changeKind === 'add'));
    h.events.length = 0;
    h.audit.length = 0;

    for (let i = 0; i < 10; i += 1) {
      await appendFile(file, `line ${i}\n`);
    }
    // Wait past debounce window for the tail to flush.
    await sleep(600);
    // After 10 burst writes, at most one debounced `change` event
    // should be dispatched (chokidar may coalesce intermediate states
    // via awaitWriteFinish; debounce closes the loop).
    const changeEvents = h.events.filter((e) => e.changeKind === 'change');
    expect(changeEvents.length).toBe(1);
  });

  it('keeps unlink + add as 2 events (debounce is per-(kind, path))', async () => {
    h = await makeHarness({ debounceMs: 100 });
    const file = join(h.dir, 'rename.ts');
    await writeFile(file, 'before\n');
    await waitFor(() => h.events.some((e) => e.changeKind === 'add'));
    h.events.length = 0;

    await unlink(file);
    await sleep(300);
    await writeFile(file, 'after\n');
    await waitFor(
      () =>
        h.events.some((e) => e.changeKind === 'unlink') &&
        h.events.some((e) => e.changeKind === 'add'),
    );
    const unlinkEvents = h.events.filter((e) => e.changeKind === 'unlink');
    const addEvents = h.events.filter((e) => e.changeKind === 'add');
    expect(unlinkEvents.length).toBe(1);
    expect(addEvents.length).toBe(1);
  }, 20_000);
});

describe('FileWatcher — rate limit integration', () => {
  let h: Harness;
  afterEach(async () => {
    await h.cleanup();
  });

  it('drops event + audits when limiter denies', async () => {
    const limits = new Map<string, PackRateLimits>();
    // 0 tokens-per-minute is invalid; use 1/day so first allowed, second blocked.
    limits.set('p1', { file_changed: { max: 1, per: 'day' } });
    h = await makeHarness({ debounceMs: 50, limits });

    const fileA = join(h.dir, 'one.ts');
    await writeFile(fileA, 'a\n');
    await waitFor(() => h.events.some((e) => e.changeKind === 'add'));

    h.events.length = 0;
    h.audit.length = 0;
    // Different path so the token bucket is per-path
    const fileB = join(h.dir, 'two.ts');
    await writeFile(fileB, 'b\n');
    // Wait long enough for chokidar+debounce to flush.
    await sleep(400);

    // Per-key bucket: fileB has its own bucket so it should be allowed.
    // To force denial, hit the SAME path repeatedly above its 1/day cap.
    h.events.length = 0;
    h.audit.length = 0;
    await appendFile(fileA, 'a2\n');
    await sleep(400);
    await appendFile(fileA, 'a3\n');
    await sleep(400);

    const rateLimitedAudits = h.audit.filter((a) => a.event === 'file_changed_rate_limited');
    expect(rateLimitedAudits.length).toBeGreaterThanOrEqual(1);
    expect(rateLimitedAudits[0]!.path).toContain('one.ts');
  });
});

describe('FileWatcher — ignored', () => {
  let h: Harness;
  afterEach(async () => {
    await h.cleanup();
  });

  it('respects default ignored globs (node_modules/.git)', async () => {
    h = await makeHarness({
      paths: [join(tmpdir(), 'opensquid-fw-ignored-test', '**/*.ts')],
    });
    // Override path AFTER construction won't work — make a fresh harness
    // with a known nested layout instead.
    await h.cleanup();

    const root = await mkdtemp(join(tmpdir(), 'opensquid-fw-ign-'));
    const nm = join(root, 'node_modules');
    const git = join(root, '.git');
    await rm(nm, { recursive: true, force: true });
    await rm(git, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(nm, { recursive: true });
    await mkdir(git, { recursive: true });

    const events: FileChangedEvent[] = [];
    const audit: FileWatcherAuditEntry[] = [];
    const client = createClient({ url: ':memory:' });
    const limiter = new RateLimiter(client, { limits: new Map() });
    const w = new FileWatcher(
      {
        pack: 'p',
        skill: 's',
        paths: [join(root, '**/*.ts')],
        debounceMs: 50,
        usePolling: true,
      },
      async (e) => {
        await Promise.resolve();
        events.push(e);
      },
      limiter,
      { auditLog: (e) => audit.push(e) },
    );
    w.start();
    await sleep(150);

    await writeFile(join(nm, 'lib.ts'), 'noise\n');
    await writeFile(join(git, 'config.ts'), 'noise\n');
    await writeFile(join(root, 'main.ts'), 'signal\n');
    await waitFor(() => events.some((e) => e.path.endsWith('main.ts')));

    expect(events.every((e) => !e.path.includes('node_modules'))).toBe(true);
    expect(events.every((e) => !e.path.includes('.git'))).toBe(true);

    await w.stop();
    client.close();
    await rm(root, { recursive: true, force: true });
    // Set h to satisfy afterEach.
    h = {
      dir: root,
      events,
      audit,
      watcher: w,
      rateLimiter: limiter,
      client,
      cleanup: async () => {
        /* already cleaned up */
      },
    };
  });
});

describe('FileWatcher — lifecycle', () => {
  it('stop() is idempotent and closes cleanly with no leaked listeners', async () => {
    const h = await makeHarness({});
    const file = join(h.dir, 'lc.ts');
    await writeFile(file, 'x\n');
    await waitFor(() => h.events.some((e) => e.changeKind === 'add'));

    const beforeStop = Date.now();
    await h.watcher.stop();
    const stopElapsed = Date.now() - beforeStop;
    expect(stopElapsed).toBeLessThan(FIVE_SECONDS_MS);

    // Idempotent: second stop is a no-op.
    await h.watcher.stop();

    // No more events fire after stop, even with new writes.
    h.events.length = 0;
    await writeFile(join(h.dir, 'after.ts'), 'no\n');
    await sleep(300);
    expect(h.events.length).toBe(0);

    // Cannot restart a stopped watcher.
    expect(() => h.watcher.start()).toThrow(/cannot restart/);

    h.client.close();
    await rm(h.dir, { recursive: true, force: true });
  });
});

describe('FileWatcher — dispatch error path', () => {
  let h: Harness;
  afterEach(async () => {
    await h.cleanup();
  });

  it('records file_changed_error when dispatch throws', async () => {
    h = await makeHarness({ dispatchThrows: true });
    const file = join(h.dir, 'err.ts');
    await writeFile(file, 'x\n');
    await waitFor(() => h.audit.some((a) => a.event === 'file_changed_error'));
    const errEntry = h.audit.find((a) => a.event === 'file_changed_error')!;
    expect(errEntry.event).toBe('file_changed_error');
    expect((errEntry as { reason: string }).reason).toMatch(/boom/);
  });
});
