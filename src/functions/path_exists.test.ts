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

/**
 * Cross-repo anchoring via `base_file` (the scope-decomposer false-block fix):
 * a spec written in the planning repo must resolve its sibling `docs/research`
 * even when the working cwd is a DIFFERENT (code) repo. Without `base_file` the
 * check resolves against cwd and false-blocks; with it, it anchors to the spec
 * file's git-repo root.
 */
describe('path_exists base_file anchoring', () => {
  let planningRepo: string;
  let codeRepo: string;

  beforeAll(async () => {
    planningRepo = await mkdtemp(join(tmpdir(), 'path-exists-plan-'));
    codeRepo = await mkdtemp(join(tmpdir(), 'path-exists-code-'));
    // Mark each as a git repo root, then nest the spec one level deep so the
    // walk-up has to traverse to find `.git`.
    await mkdir(join(planningRepo, '.git'), { recursive: true });
    await mkdir(join(codeRepo, '.git'), { recursive: true });
    const research = join(planningRepo, 'docs', 'research');
    await mkdir(research, { recursive: true });
    await mkdir(join(planningRepo, 'docs', 'tasks'), { recursive: true });
    await writeFile(join(research, 'T-feature-pre-research-2026-05-27.md'), '# x');
  });

  afterAll(async () => {
    await rm(planningRepo, { recursive: true, force: true });
    await rm(codeRepo, { recursive: true, force: true });
  });

  it('anchors to the spec file repo root, finding research from a foreign cwd', async () => {
    const reg = freshRegistry();
    const specFile = join(planningRepo, 'docs', 'tasks', 'T-feature.md');
    const result = await reg.call(
      'path_exists',
      { dir: 'docs/research', pattern: '*-pre-research-*.md', base_file: specFile },
      // cwd is the CODE repo — without base_file this would miss the artifact.
      ctxWith(toolCallAt(codeRepo)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as PathExistsResultShape;
      expect(v.exists).toBe(true);
      expect(v.matches).toEqual(['T-feature-pre-research-2026-05-27.md']);
    }
  });

  it('reproduces the false-block WITHOUT base_file (resolves against cwd)', async () => {
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: 'docs/research', pattern: '*-pre-research-*.md' },
      // cwd is the code repo (no docs/research) → exists:false = the old bug.
      ctxWith(toolCallAt(codeRepo)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ exists: false, matches: [] });
    }
  });

  it('the un-interpolated literal "args.file_path" resolves to false (the inline-spec-block bug)', async () => {
    // T-fix-inline-spec-block-basefile: the skill used `base_file: args.file_path` BARE, which the
    // evaluator passes verbatim (only `{{name}}` interpolates) → path_exists got the literal string
    // "args.file_path", resolved it against the code-repo cwd → nonsense path → exists:false → the gate
    // false-blocked every spec write. The fix interpolates `{{targs.file_path}}` to the REAL spec path
    // (asserted true by the 'anchors to the spec file repo root' case above). This locks the contrast.
    const reg = freshRegistry();
    const result = await reg.call(
      'path_exists',
      { dir: 'docs/research', pattern: '*-pre-research-*.md', base_file: 'args.file_path' },
      ctxWith(toolCallAt(codeRepo)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as PathExistsResultShape).exists).toBe(false);
    }
  });

  it('falls back to cwd when base_file has no git-repo ancestor', async () => {
    const reg = freshRegistry();
    // base_file under a tmp dir with no `.git` anywhere up the chain → fall
    // back to cwd (the planning repo here), which DOES have docs/research.
    const orphan = await mkdtemp(join(tmpdir(), 'path-exists-orphan-'));
    try {
      const result = await reg.call(
        'path_exists',
        {
          dir: 'docs/research',
          pattern: '*-pre-research-*.md',
          base_file: join(orphan, 'stray.md'),
        },
        ctxWith(toolCallAt(planningRepo)),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const v = result.value as PathExistsResultShape;
        expect(v.exists).toBe(true);
      }
    } finally {
      await rm(orphan, { recursive: true, force: true });
    }
  });
});

interface PathExistsResultShape {
  exists: boolean;
  matches: string[];
}
