/**
 * `path_exists` primitive — read-only check for files matching a basename
 * glob within a single directory, resolved relative to the event cwd.
 *
 * Powers the `scope-decomposer` skill's hard gate (Track SD): "a task/track
 * spec is being written but no `docs/research/*-pre-research-*.md` artifact
 * exists yet". Single-directory, non-recursive, NO glob dependency — it uses
 * `node:fs/promises.readdir` + a basename glob→RegExp match, because opensquid
 * pins Node `>=20` (where `fs.glob` is not stable) and ships no glob library.
 * Avoiding a new dep also keeps the license surface clean.
 *
 * Capability floor: `dir` resolves against the event cwd and MUST stay inside
 * that subtree — absolute dirs and `..` escapes are rejected with
 * `arg_invalid`. The primitive never writes, never shells out, and never reads
 * file CONTENTS (only directory entry names).
 *
 * Error model: `arg_invalid` on absolute/escaping `dir`. A missing directory
 * is NOT an error — it returns `ok({ exists: false, matches: [] })`, because
 * the gate must treat an absent `docs/research/` as "no artifact". Never throws.
 *
 * `memoizable: false` is load-bearing: disk truth changes within a session
 * (the agent creates the artifact, then the gate must see it), so a memoized
 * result would report a stale "missing" and defeat the relax-after-compliance
 * path.
 *
 * Imports from: node:fs/promises, node:path, zod, ../runtime/result.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { err, ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

export const PathExistsArgs = z
  .object({
    /** Directory to scan, relative to the resolved base. Absolute / escaping rejected. */
    dir: z.string().min(1),
    /** Basename glob: `*` (any run) and `?` (single char). Matched against entry names. */
    pattern: z.string().min(1),
    /**
     * Optional anchor: when set, resolve `dir` against the GIT REPO ROOT of this
     * file (walk up from its dirname to the nearest `.git`), NOT the event cwd.
     * Fixes the cross-repo false-block: a spec written in the planning repo
     * resolves its sibling `docs/research` correctly even when the working cwd
     * is a different (code) repo. Write/Edit always pass an absolute file_path,
     * so the anchor is reliable; falls back to cwd if no repo root is found.
     */
    base_file: z.string().min(1).optional(),
  })
  .strict();

/** Walk up from `start` to the nearest dir containing `.git`; null at fs root. */
async function repoRootOf(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    try {
      await stat(join(dir, '.git'));
      return dir;
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface PathExistsResult {
  exists: boolean;
  matches: string[];
}

/**
 * Compile a basename glob (`*`, `?`) to an anchored RegExp. All other regex
 * metacharacters are escaped first, so the only wildcards are the two glob
 * tokens. Patterns are first-party (pack YAML), single-segment, and anchored —
 * no catastrophic-backtracking surface.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export const PathExists: FunctionDef<z.input<typeof PathExistsArgs>, PathExistsResult> = {
  name: 'path_exists',
  argSchema: PathExistsArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 5,
  execute: async (args, ctx) => {
    if (isAbsolute(args.dir)) {
      return err({
        kind: 'arg_invalid' as const,
        message: `path_exists: absolute dir not allowed ("${args.dir}")`,
      });
    }
    const cwd = ctx.event.kind === 'tool_call' ? (ctx.event.cwd ?? process.cwd()) : process.cwd();
    // base_file anchors to the file's repo root (cwd-independent) — fixes the
    // cross-repo false-block where a planning-repo spec is edited from a code
    // repo's cwd and its sibling docs/research can't be found.
    let base = cwd;
    if (args.base_file !== undefined && args.base_file !== '') {
      const fileAbs = isAbsolute(args.base_file) ? args.base_file : resolve(cwd, args.base_file);
      base = (await repoRootOf(dirname(fileAbs))) ?? cwd;
    }
    const target = resolve(base, args.dir);
    const rel = relative(base, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return err({
        kind: 'arg_invalid' as const,
        message: `path_exists: dir escapes cwd subtree ("${args.dir}")`,
      });
    }
    const re = globToRegExp(args.pattern);
    let entries: string[];
    try {
      entries = await readdir(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return ok({ exists: false, matches: [] });
      }
      return err({
        kind: 'runtime' as const,
        message: `path_exists: readdir failed for "${args.dir}": ${(e as Error).message}`,
        cause: e,
      });
    }
    const matches = entries.filter((name) => re.test(name)).sort();
    return ok({ exists: matches.length > 0, matches });
  },
};
