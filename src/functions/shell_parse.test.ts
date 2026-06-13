/**
 * Tests for `shell_parse` (GM.1, wg-52e57e2ed252) — the quote-aware tokenizer + the
 * `commandInvokes` git-invocation predicate that replaces the raw-string `match_command`
 * git matchers.
 *
 * The false-fire corpus is the contract: the three documented live false-fires
 * (grep pattern / echo arg / quoted subprocess prompt) MUST be FALSE; real git
 * invocations (incl. compound, basename, -C/-c globals, -n/--amend/--no-verify flags)
 * MUST be TRUE; `git push -n` MUST be FALSE for verify-skip (`-n` is --dry-run for push).
 */

import { describe, expect, it } from 'vitest';

import { commandInvokes, tokenizeShell } from './shell_parse.js';

describe('tokenizeShell', () => {
  it('splits a compound command on unquoted && and keeps a quoted value as one token', () => {
    expect(tokenizeShell('cd /r && git commit -m "a b"')).toEqual([
      ['cd', '/r'],
      ['git', 'commit', '-m', 'a b'],
    ]);
  });

  it('does NOT split on an operator inside quotes', () => {
    expect(tokenizeShell('echo "a && b"')).toEqual([['echo', 'a && b']]);
    expect(tokenizeShell('echo "x | y"')).toEqual([['echo', 'x | y']]);
  });

  it('keeps a quoted grep pattern as a single argument', () => {
    expect(tokenizeShell('grep -n "git commit" f')).toEqual([['grep', '-n', 'git commit', 'f']]);
  });

  it('splits a pipeline into segments', () => {
    expect(tokenizeShell('cat x | grep y')).toEqual([
      ['cat', 'x'],
      ['grep', 'y'],
    ]);
  });

  it('honors single quotes as literal and backslash escapes', () => {
    expect(tokenizeShell("echo 'a b'")).toEqual([['echo', 'a b']]);
    expect(tokenizeShell('echo a\\ b')).toEqual([['echo', 'a b']]);
  });

  it('returns [] for empty / non-string / over-long input', () => {
    expect(tokenizeShell('')).toEqual([]);
    // @ts-expect-error — exercising the non-string guard
    expect(tokenizeShell(undefined)).toEqual([]);
    expect(tokenizeShell('x'.repeat(10_001))).toEqual([]);
  });

  it('is deterministic (same input → same output)', () => {
    const cmd = 'cd /r && git -C /r commit -m "x"';
    expect(tokenizeShell(cmd)).toEqual(tokenizeShell(cmd));
  });
});

describe('commandInvokes — the false-fires that MUST NOT match', () => {
  const q = { program: 'git', subcommand: 'commit' };
  it('grep pattern mentioning git commit → false', () => {
    expect(commandInvokes('grep -n "git commit" file', q)).toBe(false);
  });
  it('echo arg mentioning git commit → false', () => {
    expect(commandInvokes('echo "git commit"', q)).toBe(false);
  });
  it('quoted subprocess prompt mentioning git commit → false', () => {
    expect(commandInvokes('claude -p "do a git commit thing"', q)).toBe(false);
  });
});

describe('commandInvokes — real git commit invocations that MUST match', () => {
  const q = { program: 'git', subcommand: 'commit' };
  it('bare git commit', () => {
    expect(commandInvokes('git commit', q)).toBe(true);
  });
  it('compound cd && git commit', () => {
    expect(commandInvokes('cd x && git commit -m "y"', q)).toBe(true);
  });
  it('git invoked by absolute path (basename match)', () => {
    expect(commandInvokes('/usr/bin/git commit', q)).toBe(true);
  });
  it('git -C <path> commit (separate-value global skipped)', () => {
    expect(commandInvokes('git -C /r commit', q)).toBe(true);
  });
  it('git -c k=v commit (separate-value global skipped)', () => {
    expect(commandInvokes('git -c user.name=x commit', q)).toBe(true);
  });
});

describe('commandInvokes — flag detection', () => {
  it('git commit -n matches the verify-skip flag set', () => {
    expect(
      commandInvokes('git commit -n', {
        program: 'git',
        subcommand: 'commit',
        flagAny: ['--no-verify', '-n'],
      }),
    ).toBe(true);
  });
  it('git commit --no-verify matches', () => {
    expect(
      commandInvokes('git commit --no-verify', {
        program: 'git',
        subcommand: 'commit',
        flagAny: ['--no-verify', '-n'],
      }),
    ).toBe(true);
  });
  it('git commit --amend matches the amend flag', () => {
    expect(
      commandInvokes('git commit --amend', {
        program: 'git',
        subcommand: 'commit',
        flagAny: ['--amend'],
      }),
    ).toBe(true);
  });
  it('git commit -an matches -n inside a short-flag cluster', () => {
    expect(
      commandInvokes('git commit -an -m "x"', {
        program: 'git',
        subcommand: 'commit',
        flagAny: ['-n'],
      }),
    ).toBe(true);
  });
  it('git push -n is NOT a verify-skip (push -n is --dry-run)', () => {
    expect(
      commandInvokes('git push -n', {
        program: 'git',
        subcommand: 'push',
        flagAny: ['--no-verify'],
      }),
    ).toBe(false);
  });
  it('git push --no-verify matches', () => {
    expect(
      commandInvokes('git push --no-verify origin main', {
        program: 'git',
        subcommand: 'push',
        flagAny: ['--no-verify'],
      }),
    ).toBe(true);
  });
  it('a plain git commit does NOT match a flag query', () => {
    expect(
      commandInvokes('git commit -m "x"', {
        program: 'git',
        subcommand: 'commit',
        flagAny: ['--amend'],
      }),
    ).toBe(false);
  });
});

describe('commandInvokes — subcommand discrimination', () => {
  it('git status is not git commit', () => {
    expect(commandInvokes('git status', { program: 'git', subcommand: 'commit' })).toBe(false);
  });
  it('program-only query matches any git invocation', () => {
    expect(commandInvokes('git log', { program: 'git' })).toBe(true);
  });
});
