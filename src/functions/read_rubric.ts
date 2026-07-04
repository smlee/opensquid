/**
 * `read_rubric` primitive + the bare `readRubricContent` reader (T-transfer-audit-rubric TR.A,
 * wg-2d1d8698f563).
 *
 * Single-sources EACH pack's audit rubric: the canonical criteria live IN the pack at
 * `packs/builtin/<pack>/rubric/<name>.md` (the cartridge owns its own gate; shipped via the
 * `packs/builtin` entry in package.json `files[]`), read WHOLE by name. The pack is resolved from the active
 * `ctx.packId` (v1 `coding-flow` has `{scope,author}`; v2 `fullstack-flow` has `{scope,plan,author,code}`); the
 * bare reader takes the pack EXPLICITLY (no hardcoded default). The guess/spec audits interpolate `{{rubric}}`
 * from this (de-duping the former hardcoded prompt copy — docs/lexicon.md:40), and `rubric_pre_inject` (TR.B)
 * delivers the same content to the agent before authoring. Edit a fragment → both reflect it (the audit's
 * sha256(prompt) cache invalidates because the rubric content is interpolated INTO the prompt).
 *
 * Resolution is MODULE-RELATIVE to the opensquid package (precedent: src/runtime/paths.ts,
 * src/runtime/update_check.ts use fileURLToPath(import.meta.url)) — NOT cwd / CLAUDE_PROJECT_DIR, so the
 * recurring sub-repo-vs-umbrella cwd split cannot misresolve it. Compiled to dist/functions/read_rubric.js,
 * so `../..` is the package root, where the shipped `docs/rubric/` lives.
 *
 * FAIL-LOUD: on file-miss / path-misresolve / over-cap the reader returns `null` — it NEVER throws and NEVER
 * truncates. Callers fail loud: the audit blocks via a `rubric == null` precondition (so it never runs
 * rubric-less); the injection injects nothing. (project-memory-scope-isolation: fail-loud, not silent.)
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

/** Generous sanity ceiling, well above the few-KB prose rubric; over-cap → null (never a partial read). */
const MAX_RUBRIC = 64_000;

// GENERIC RUNTIME — `name` is any rubric name (the ACTIVE pack's own gate name), NOT a closed coding-flow list:
// resolution flows through `ctx.packId` (below), so a non-coding pack's stages resolve to ITS own rubric files.
// An unknown name simply has no rubric file → the reader returns null (never a hard arg rejection).
const ReadRubricArgs = z.object({ name: z.string().min(1) }).strict();

// dist/functions/read_rubric.js → ../.. = the package root; rubrics live in `packs/builtin/<pack>/rubric/`.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Bare reader — reused by `rubric_pre_inject` (TR.B) and wrapped by the primitive below. Resolves the rubric
 * for `pack` (the ACTIVE pack — the caller passes it; there is NO hardcoded default, so the reader keys off the
 * active pack's OWN gate names, not a coding-flow list). Returns the whole fragment, or `null` on file-miss /
 * path-misresolve / over-cap. Never throws, never truncates.
 */
export async function readRubricContent(name: string, pack: string): Promise<string | null> {
  try {
    const content = await readFile(
      join(PKG_ROOT, 'packs', 'builtin', pack, 'rubric', `${name}.md`),
      'utf8',
    );
    return content.length > MAX_RUBRIC ? null : content;
  } catch {
    return null;
  }
}

export function registerReadRubric(registry: FunctionRegistry): void {
  registry.register({
    name: 'read_rubric',
    argSchema: ReadRubricArgs,
    durable: false,
    memoizable: false, // re-read each call so a rubric edit is reflected (S-C)
    costEstimateMs: 1,
    // resolve by the ACTIVE pack (ctx.packId) so v2 fullstack-flow reads ITS rubric, v1 coding-flow reads its own.
    execute: async ({ name }, ctx) => ok(await readRubricContent(name, ctx.packId)),
  });
}
