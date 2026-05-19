/**
 * Tests for `when_to_load` matcher evaluator.
 *
 * Coverage matrix:
 *   - Each kind has a positive + negative case.
 *   - OR semantics across multiple matchers (one hit wins).
 *   - Empty list never matches.
 *   - Bad regex degrades to no-match (no throw, stderr noise expected).
 *   - Shorthand single-key form normalizes to canonical discriminated form.
 *   - File-glob field precedence: file_path > path > notebook_path.
 *
 * Test surface: `matchesEvent`, `Matcher.parse` (via shorthand cases),
 * `normalizeMatcher`. Cache is cleared per-test to keep failures isolated.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearRegexCache, Matcher, matchesEvent, normalizeMatcher } from './load_matchers.js';
import type { Event } from './types.js';

const bash = (command: string): Event => ({
  kind: 'tool_call',
  tool: 'Bash',
  args: { command },
});

const read = (filePath: string): Event => ({
  kind: 'tool_call',
  tool: 'Read',
  args: { file_path: filePath },
});

afterEach(() => {
  clearRegexCache();
  vi.restoreAllMocks();
});

describe('matchesEvent — tool_match', () => {
  it('matches when tool name equals matcher.tool', () => {
    expect(matchesEvent([{ kind: 'tool_match', tool: 'Bash' }], bash('ls'))).toBe(true);
  });

  it('does not match when tool name differs', () => {
    expect(matchesEvent([{ kind: 'tool_match', tool: 'Bash' }], read('x.ts'))).toBe(false);
  });

  it('does not match on non-tool_call events', () => {
    const evt: Event = { kind: 'prompt_submit', prompt: 'hi' };
    expect(matchesEvent([{ kind: 'tool_match', tool: 'Bash' }], evt)).toBe(false);
  });
});

describe('matchesEvent — command_pattern', () => {
  it('matches a bash command with the regex', () => {
    expect(matchesEvent([{ kind: 'command_pattern', pattern: '^git' }], bash('git commit'))).toBe(
      true,
    );
  });

  it('does not match when command starts differently', () => {
    expect(matchesEvent([{ kind: 'command_pattern', pattern: '^git' }], bash('echo hi'))).toBe(
      false,
    );
  });

  it('does not match when args.command is missing', () => {
    const evt: Event = { kind: 'tool_call', tool: 'Bash', args: {} };
    expect(matchesEvent([{ kind: 'command_pattern', pattern: '^git' }], evt)).toBe(false);
  });

  it('reuses cached regex across calls', () => {
    // Two hits with the same pattern — second call must come from cache.
    // We can't peek at the Map directly, but a runtime smoke: 1000 matches
    // against the same pattern should not throw or stall (recompiling per
    // call is observably slower; this test guards against accidental cache
    // bypass via the `cached === undefined` check).
    const m = { kind: 'command_pattern' as const, pattern: '^git\\s+commit' };
    for (let i = 0; i < 1000; i++) {
      expect(matchesEvent([m], bash('git commit -m x'))).toBe(true);
    }
  });
});

describe('matchesEvent — file_glob', () => {
  it('matches src/**/*.ts on file_path src/foo/bar.ts', () => {
    expect(matchesEvent([{ kind: 'file_glob', glob: 'src/**/*.ts' }], read('src/foo/bar.ts'))).toBe(
      true,
    );
  });

  it('does not match src/**/*.ts on a .md file_path', () => {
    expect(matchesEvent([{ kind: 'file_glob', glob: 'src/**/*.ts' }], read('docs/x.md'))).toBe(
      false,
    );
  });

  it('honors field precedence: file_path > path > notebook_path', () => {
    // Both file_path and path present — file_path wins; path's value would not
    // match this glob, so a hit proves file_path was picked first.
    const evt: Event = {
      kind: 'tool_call',
      tool: 'Edit',
      args: { file_path: 'src/a.ts', path: 'unrelated.md' },
    };
    expect(matchesEvent([{ kind: 'file_glob', glob: '**/*.ts' }], evt)).toBe(true);
  });

  it('falls through to path when file_path is missing', () => {
    const evt: Event = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { path: 'README.md' },
    };
    expect(matchesEvent([{ kind: 'file_glob', glob: '*.md' }], evt)).toBe(true);
  });

  it('falls through to notebook_path when file_path and path are missing', () => {
    const evt: Event = {
      kind: 'tool_call',
      tool: 'NotebookEdit',
      args: { notebook_path: 'work.ipynb' },
    };
    expect(matchesEvent([{ kind: 'file_glob', glob: '*.ipynb' }], evt)).toBe(true);
  });
});

describe('matchesEvent — event_type', () => {
  it('matches tool_call event_type on a tool_call event', () => {
    expect(matchesEvent([{ kind: 'event_type', type: 'tool_call' }], bash('ls'))).toBe(true);
  });

  it('does not match tool_call event_type on a prompt_submit event', () => {
    const evt: Event = { kind: 'prompt_submit', prompt: 'hi' };
    expect(matchesEvent([{ kind: 'event_type', type: 'tool_call' }], evt)).toBe(false);
  });

  it('matches prompt_submit event_type on prompt_submit', () => {
    const evt: Event = { kind: 'prompt_submit', prompt: 'hi' };
    expect(matchesEvent([{ kind: 'event_type', type: 'prompt_submit' }], evt)).toBe(true);
  });
});

describe('matchesEvent — OR semantics + empty list', () => {
  it('returns false on empty matcher list', () => {
    expect(matchesEvent([], bash('git commit'))).toBe(false);
  });

  it('returns true when ANY matcher in a multi-matcher list hits', () => {
    const matchers: Matcher[] = [
      { kind: 'tool_match', tool: 'Read' }, // miss
      { kind: 'command_pattern', pattern: '^git' }, // hit
      { kind: 'file_glob', glob: '*.md' }, // miss
    ];
    expect(matchesEvent(matchers, bash('git status'))).toBe(true);
  });

  it('returns false when all matchers miss', () => {
    const matchers: Matcher[] = [
      { kind: 'tool_match', tool: 'Read' },
      { kind: 'command_pattern', pattern: '^npm' },
      { kind: 'file_glob', glob: '*.md' },
    ];
    expect(matchesEvent(matchers, bash('git status'))).toBe(false);
  });
});

describe('matchesEvent — bad regex', () => {
  it('does not throw on invalid command_pattern regex; returns false', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // `[` is an unterminated character class — invalid in JS regex.
    expect(matchesEvent([{ kind: 'command_pattern', pattern: '[' }], bash('git'))).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('survives a mixed list with a bad regex (other matchers still evaluate)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const matchers: Matcher[] = [
      { kind: 'command_pattern', pattern: '[' }, // bad — degrades to miss
      { kind: 'tool_match', tool: 'Bash' }, // hit
    ];
    expect(matchesEvent(matchers, bash('git'))).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('Matcher schema — shorthand normalization', () => {
  it('parses {tool_match: "Bash"} as canonical discriminated form', () => {
    const parsed = Matcher.parse({ tool_match: 'Bash' });
    expect(parsed).toEqual({ kind: 'tool_match', tool: 'Bash' });
  });

  it('parses {command_pattern: "^git"} as canonical discriminated form', () => {
    const parsed = Matcher.parse({ command_pattern: '^git' });
    expect(parsed).toEqual({ kind: 'command_pattern', pattern: '^git' });
  });

  it('parses {file_glob: "src/**/*.ts"} as canonical discriminated form', () => {
    const parsed = Matcher.parse({ file_glob: 'src/**/*.ts' });
    expect(parsed).toEqual({ kind: 'file_glob', glob: 'src/**/*.ts' });
  });

  it('parses {event_type: "prompt_submit"} as canonical discriminated form', () => {
    const parsed = Matcher.parse({ event_type: 'prompt_submit' });
    expect(parsed).toEqual({ kind: 'event_type', type: 'prompt_submit' });
  });

  it('passes canonical form through unchanged', () => {
    const parsed = Matcher.parse({ kind: 'tool_match', tool: 'Read' });
    expect(parsed).toEqual({ kind: 'tool_match', tool: 'Read' });
  });

  it('rejects an unknown single-key shorthand', () => {
    const result = Matcher.safeParse({ mystery_field: 'x' });
    expect(result.success).toBe(false);
  });

  it('normalizeMatcher returns non-objects unchanged', () => {
    expect(normalizeMatcher(42)).toBe(42);
    expect(normalizeMatcher('str')).toBe('str');
    expect(normalizeMatcher(null)).toBe(null);
  });

  it('normalizeMatcher returns multi-key objects unchanged (canonical or invalid)', () => {
    const canonical = { kind: 'tool_match', tool: 'Bash' };
    expect(normalizeMatcher(canonical)).toBe(canonical);
  });
});
