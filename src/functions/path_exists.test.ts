/**
 * Tests for `path_exists` primitive (Track SD.1).
 *
 * Coverage per spec test fixtures:
 *   - pattern matches an existing file → exists:true + basenames
 *   - pattern matches nothing → exists:false
 *   - missing directory (ENOENT) → exists:false (NOT an error)
 *   - absolute dir → arg_invalid
 *   - `..`-escaping dir → arg_invalid
 *   - two-wildcard pattern `*-pre-research-*.md` selects the right subset
 *   - non-tool_call event → falls back to process.cwd(), no throw
 *   - empty dir/pattern → arg_invalid (Zod min(1))
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Event } from '../runtime/event.js';

import { PathExists } from './path_exists.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

function freshRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  reg.register(PathExists);
  return reg;
}

function ctxWith(event: Event): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 'test-session',
    packId: 'test-pack',
  };
}

function toolCallAt(cwd: string): Event {
  return { kind: 'tool_call', tool: 'Write', args: {}, cwd };
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'path-exists-'));
  const research = join(root, 'docs', 'research');
  await mkdir(research, { recursive: true });
  await writeFile(join(research, 'T-foo-pre-research-2026-05-26.md'), '# foo');
  await writeFile(join(research, 'T-bar-pre-research-2026-05-25.md'), '# bar');
  await writeFile(join(research, 'unrelated-notes.md'), '# notes');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('path_exists', () => {
  it('finds files matching a two-wildcard basename glob', async () => {
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: 'docs/research', pattern: '*-pre-research-*.md' },
      ctxWith(toolCallAt(root)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as PathExistsResultShape;
      expect(v.exists).toBe(true);
      expect(v.matches).toEqual([
        'T-bar-pre-research-2026-05-25.md',
        'T-foo-pre-research-2026-05-26.md',
      ]);
    }
  });

  it('returns exists:false when nothing matches', async () => {
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: 'docs/research', pattern: 'nope-*.txt' },
      ctxWith(toolCallAt(root)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as PathExistsResultShape;
      expect(v).toEqual({ exists: false, matches: [] });
    }
  });

  it('treats a missing directory as exists:false (not an error)', async () => {
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: 'docs/does-not-exist', pattern: '*.md' },
      ctxWith(toolCallAt(root)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ exists: false, matches: [] });
    }
  });

  it('rejects an absolute dir with arg_invalid', async () => {
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: '/etc', pattern: 'passwd' },
      ctxWith(toolCallAt(root)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('rejects a `..`-escaping dir with arg_invalid', async () => {
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: '../../../etc', pattern: '*' },
      ctxWith(toolCallAt(root)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('falls back to process.cwd() on a non-tool_call event without throwing', async () => {
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: 'docs/research', pattern: '*-pre-research-*.md' },
      ctxWith({ kind: 'prompt_submit', prompt: 'hello' }),
    );
    // process.cwd() during tests is the repo root, not the tmp fixture, so the
    // tmp artifacts are NOT found — the point is it resolves + returns cleanly.
    expect(result.ok).toBe(true);
  });

  it('rejects an empty dir argument (Zod min(1))', async () => {
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: '', pattern: '*' },
      ctxWith(toolCallAt(root)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });
});

interface PathExistsResultShape {
  exists: boolean;
  matches: string[];
}
