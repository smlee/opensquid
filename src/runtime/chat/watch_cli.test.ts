/**
 * Tests for `opensquid chat watch` argument resolution (Track T-TR, TR.1;
 * re-keyed project_uuid → UMBRELLA in T-CHAT-AS-TERMINAL CAT.1c).
 *
 * The action would block forever on the real watcher, so we inject a `watch`
 * stub (ChatWatchDeps) that captures the resolved opts and returns. Covers:
 *   - --umbrella + --platform → correct umbrella inbox file
 *   - --raw swaps the formatter; default formatter is human-readable
 *   - --mentions-only sets the filter
 *   - cwd→umbrella resolution via channels.json (members prefix)
 *   - no resolvable umbrella → stub not called, exitCode 1, stderr guidance
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxRow, WatchInboxOpts } from './watch.js';
import { registerChatWatch } from './watch_cli.js';

const sampleRow: InboxRow = {
  id: 'm',
  platform: 'telegram',
  channel: 'c',
  sender: 'a',
  sender_id: 's',
  text: 't',
  received_at: '',
  enqueued_at: '',
  mentions_bot: false,
};

describe('chat watch CLI', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedCwd: string;
  let savedExit: typeof process.exitCode;
  let stderr: string[];

  beforeEach(async () => {
    savedHome = process.env.OPENSQUID_HOME;
    savedCwd = process.cwd();
    savedExit = process.exitCode;
    home = await mkdtemp(join(tmpdir(), 'osq-chat-watch-'));
    process.env.OPENSQUID_HOME = home;
    process.exitCode = undefined;
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array): boolean => {
      stderr.push(String(s));
      return true;
    });
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = savedHome;
    process.chdir(savedCwd);
    process.exitCode = savedExit;
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function writeChannels(config: unknown): Promise<void> {
    await writeFile(join(home, 'channels.json'), JSON.stringify(config), 'utf8');
  }

  async function run(argv: string[], capture: (o: WatchInboxOpts) => void): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerChatWatch(program, {
      watch: (o) => {
        capture(o);
        return Promise.resolve();
      },
      // Don't spin up a real chokidar tail in the lifecycle test.
      startInbound: () => Promise.resolve(() => Promise.resolve()),
    });
    await program.parseAsync(['chat', 'watch', ...argv], { from: 'user' });
  }

  it('resolves --umbrella + --platform to the umbrella inbox file', async () => {
    let captured: WatchInboxOpts | undefined;
    await run(['--umbrella', 'loop', '--platform', 'discord'], (o) => {
      captured = o;
    });
    expect(captured?.inboxFile).toBe(`${home}/umbrellas/loop/inbox/discord.jsonl`);
    expect(captured?.mentionsOnly).toBe(false);
  });

  it('--raw swaps the formatter to JSON', async () => {
    let captured: WatchInboxOpts | undefined;
    await run(['--umbrella', 'loop', '--raw'], (o) => {
      captured = o;
    });
    expect(captured?.format(sampleRow)).toBe(JSON.stringify(sampleRow));
  });

  it('uses the human-readable formatter by default', async () => {
    let captured: WatchInboxOpts | undefined;
    await run(['--umbrella', 'loop'], (o) => {
      captured = o;
    });
    expect(captured?.format({ ...sampleRow, thread_id: '9', sender: 'z', text: 'q' })).toBe(
      '[tg 9] z: q',
    );
  });

  it('resolves the umbrella from channels.json members prefix (cwd walk)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'osq-member-'));
    await mkdir(cwd, { recursive: true });
    process.chdir(cwd);
    // Seed the member as the REALPATH cwd (macOS /tmp → /private/tmp), which is
    // what resolveUmbrellaForCwd compares against via process.cwd().
    await writeChannels({ v: 1, umbrellas: [{ id: 'loop', members: [process.cwd()] }] });
    let captured: WatchInboxOpts | undefined;
    await run([], (o) => {
      captured = o;
    });
    expect(captured?.inboxFile).toBe(`${home}/umbrellas/loop/inbox/telegram.jsonl`);
    await rm(cwd, { recursive: true, force: true });
  });

  it('--mentions-only sets the filter', async () => {
    let captured: WatchInboxOpts | undefined;
    await run(['--umbrella', 'loop', '--mentions-only'], (o) => {
      captured = o;
    });
    expect(captured?.mentionsOnly).toBe(true);
  });

  it('hard-fails with guidance + exit code 1 when no umbrella resolves', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'chat-cli-'));
    process.chdir(tmp); // no channels.json → no umbrella
    let called = false;
    await run([], () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('no umbrella for this cwd');
    await rm(tmp, { recursive: true, force: true });
  });
});
