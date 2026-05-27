/**
 * Tests for `opensquid chat watch` argument resolution (Track T-TR, TR.1).
 *
 * The action would block forever on the real watcher, so we inject a `watch`
 * stub (ChatWatchDeps) that captures the resolved opts and returns. Covers:
 *   - --project-uuid + --platform → correct inbox file
 *   - --raw swaps the formatter; default formatter is human-readable
 *   - --mentions-only sets the filter
 *   - OPENSQUID_PROJECT_UUID env resolution
 *   - no resolvable UUID → stub not called, exitCode 1, stderr guidance
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxRow, WatchInboxOpts } from './watch.js';
import { registerChatWatch } from './watch_cli.js';

const HOME = '/tmp/osq-chat-watch-test-home';
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
  let savedHome: string | undefined;
  let savedUuid: string | undefined;
  let savedCwd: string;
  let savedExit: typeof process.exitCode;
  let stderr: string[];

  beforeEach(() => {
    savedHome = process.env.OPENSQUID_HOME;
    savedUuid = process.env.OPENSQUID_PROJECT_UUID;
    savedCwd = process.cwd();
    savedExit = process.exitCode;
    process.env.OPENSQUID_HOME = HOME;
    delete process.env.OPENSQUID_PROJECT_UUID;
    process.exitCode = undefined;
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array): boolean => {
      stderr.push(String(s));
      return true;
    });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = savedHome;
    if (savedUuid === undefined) delete process.env.OPENSQUID_PROJECT_UUID;
    else process.env.OPENSQUID_PROJECT_UUID = savedUuid;
    process.chdir(savedCwd);
    process.exitCode = savedExit;
    vi.restoreAllMocks();
  });

  async function run(argv: string[], capture: (o: WatchInboxOpts) => void): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerChatWatch(program, {
      watch: (o) => {
        capture(o);
        return Promise.resolve();
      },
    });
    await program.parseAsync(['chat', 'watch', ...argv], { from: 'user' });
  }

  it('resolves --project-uuid + --platform to the inbox file', async () => {
    let captured: WatchInboxOpts | undefined;
    await run(['--project-uuid', 'proj-X', '--platform', 'discord'], (o) => {
      captured = o;
    });
    expect(captured?.inboxFile).toBe(`${HOME}/projects/proj-X/inbox/discord.jsonl`);
    expect(captured?.mentionsOnly).toBe(false);
  });

  it('--raw swaps the formatter to JSON', async () => {
    let captured: WatchInboxOpts | undefined;
    await run(['--project-uuid', 'p', '--raw'], (o) => {
      captured = o;
    });
    expect(captured?.format(sampleRow)).toBe(JSON.stringify(sampleRow));
  });

  it('uses the human-readable formatter by default', async () => {
    let captured: WatchInboxOpts | undefined;
    await run(['--project-uuid', 'p'], (o) => {
      captured = o;
    });
    expect(captured?.format({ ...sampleRow, thread_id: '9', sender: 'z', text: 'q' })).toBe(
      '[tg 9] z: q',
    );
  });

  it('resolves the UUID from OPENSQUID_PROJECT_UUID when no flag is given', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'env-uuid';
    let captured: WatchInboxOpts | undefined;
    await run([], (o) => {
      captured = o;
    });
    expect(captured?.inboxFile).toBe(`${HOME}/projects/env-uuid/inbox/telegram.jsonl`);
  });

  it('--mentions-only sets the filter', async () => {
    let captured: WatchInboxOpts | undefined;
    await run(['--project-uuid', 'p', '--mentions-only'], (o) => {
      captured = o;
    });
    expect(captured?.mentionsOnly).toBe(true);
  });

  it('hard-fails with guidance + exit code 1 when no UUID resolves', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'chat-cli-'));
    process.chdir(tmp); // no .opensquid/project.json up-tree
    let called = false;
    await run([], () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('no project UUID');
    await rm(tmp, { recursive: true, force: true });
  });
});
