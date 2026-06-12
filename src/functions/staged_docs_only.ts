/**
 * `staged_docs_only` primitive — true iff the commit's STAGED diff is docs-only (non-code),
 * by the same `isDocsOnly` predicate the hard EXECUTE gate uses (predicate parity).
 *
 * Lets the in-session `phase-logged-before-commit` nudge MIRROR the git-owned boundary
 * (gate.ts allows docs-only commits): without this the nudge over-blocks a zero-phase
 * `docs/` commit the hard gate would pass.
 *
 * Uses FIXED-argv git (`execFile('git', ['diff','--cached','--name-only'])`) — no shell, no
 * user-controlled tokens, so it is categorically unlike `shell_exec`'s ARBITRARY command
 * string and does not reopen the shell_exec/AUTO.5 capability decision. Same mechanism
 * gate.ts (gate.ts:78) and handoff/collect.ts (:166) already ship.
 *
 * Fails TOWARD `false` (= not docs-only = the nudge STILL fires) on any error / non-tool_call
 * event / absent cwd: the advisory layer must never falsely SUPPRESS a real code-commit warning.
 *
 * Imports from: node:child_process, node:util, zod, ../runtime/result.js,
 *   ../runtime/protected_paths.js, ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring via bootstrap).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { ok } from '../runtime/result.js';
import { isDocsOnly } from '../runtime/protected_paths.js';

import type { FunctionRegistry } from './registry.js';

const execFileP = promisify(execFile);
const EmptyArgs = z.object({}).strict();

export function registerStagedDocsOnlyFunction(registry: FunctionRegistry): void {
  registry.register({
    name: 'staged_docs_only',
    argSchema: EmptyArgs,
    durable: false,
    // NOT memoizable: output depends on git/filesystem state outside the args.
    memoizable: false,
    costEstimateMs: 20,
    execute: async (_args, ctx) => {
      if (ctx.event.kind !== 'tool_call') return ok(false);
      const cwd = ctx.event.cwd;
      if (cwd === undefined || cwd === '') return ok(false);
      try {
        const { stdout } = await execFileP('git', ['diff', '--cached', '--name-only'], { cwd });
        const files = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        return ok(isDocsOnly(files));
      } catch {
        // git error / not a repo / detached → cannot prove docs-only → let the nudge fire.
        return ok(false);
      }
    },
  });
}
