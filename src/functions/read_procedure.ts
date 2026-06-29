/**
 * `read_procedure` primitive + the bare `readProcedureContent` reader — the per-stage, on-demand procedure
 * loader for v2 stage-instruction injection.
 *
 * NEED-TO-KNOW BY DESIGN (not a monolith): each stage's operating instructions live in their OWN file at
 * `packs/builtin/<pack>/procedure/<stage>.md`, read WHOLE but ONLY for the CURRENT stage. The injector
 * (`stage_inject`) reads just the active stage's file each turn — never the whole procedure — so the agent's
 * context carries only what the stage it is in requires. This mirrors `read_rubric`'s per-stage resolution
 * (one stage's rubric, on demand) rather than loading a single large `procedure.md` into context and slicing.
 *
 * Stage = the v2 FSM state name (scope|plan|author|code|deploy). The active pack is resolved from `ctx.packId`
 * (default `fullstack-flow`). Resolution is MODULE-RELATIVE to the opensquid package (precedent: read_rubric.ts,
 * runtime/paths.ts) — NOT cwd — so the recurring sub-repo-vs-umbrella cwd split cannot misresolve it.
 *
 * FAIL-LOUD: on file-miss / over-cap the reader returns `null` — it NEVER throws and NEVER truncates. A stage
 * with no procedure file (e.g. a terminal/decision state) returns `null`, which the injector treats as "no
 * injectable stage" (so it injects nothing rather than guessing).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

/** Generous ceiling, well above a per-stage prose section; over-cap → null (never a partial read). */
const MAX_PROCEDURE = 64_000;

// The v2 stage names that carry an operating procedure (the fullstack-flow FSM states the agent acts in).
const ReadProcedureArgs = z
  .object({ stage: z.enum(['scope', 'plan', 'author', 'code', 'deploy']) })
  .strict();
export type ProcedureStage = 'scope' | 'plan' | 'author' | 'code' | 'deploy';

// dist/functions/read_procedure.js → ../.. = the package root; procedures live in `packs/builtin/<pack>/procedure/`.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Bare reader — used by `stage_inject` and wrapped by the primitive below. Reads the procedure for `stage` in
 * `pack` (default `fullstack-flow`). Takes the RAW FSM-state string so the injector can pass the current state
 * directly; a state with no procedure file (terminal/decision/unknown) → `null`. Never throws, never truncates.
 */
export async function readProcedureContent(
  stage: string,
  pack = 'fullstack-flow',
): Promise<string | null> {
  try {
    const content = await readFile(
      join(PKG_ROOT, 'packs', 'builtin', pack, 'procedure', `${stage}.md`),
      'utf8',
    );
    return content.length > MAX_PROCEDURE ? null : content;
  } catch {
    return null;
  }
}

export function registerReadProcedure(registry: FunctionRegistry): void {
  registry.register({
    name: 'read_procedure',
    argSchema: ReadProcedureArgs,
    durable: false,
    memoizable: false, // re-read each call so a procedure edit is reflected
    costEstimateMs: 1,
    // resolve by the ACTIVE pack (ctx.packId) so the v2 cartridge reads ITS own per-stage procedure.
    execute: async ({ stage }, ctx) => ok(await readProcedureContent(stage, ctx.packId)),
  });
}
