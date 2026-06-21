/**
 * Zod schema for the scope WORKSHEET — the per-track anti-drift checkpoint artifact
 * (T-scope-worksheet / wg-7d649d90f26a).
 *
 * The worksheet is the AUTHORED plan (its single writable home) + a PROJECTED log
 * (rendered from work-graph + ledger + git, never stored). This schema validates ONLY
 * the authored block (`mode`/`parent`/`order`/`scopes`); the log half is computed by
 * `src/runtime/worksheet/projection.ts`, never persisted.
 *
 * Two first-class modes:
 *   - `single` (the common case): exactly ONE scope, AUTO-BORN at the pre-research write
 *     (its scope has no `issue` — completion derives from the active track's 7-phase ledger).
 *   - `batch`: ≥2 scopes, user-authored ahead of scope_start; every scope carries a
 *     work-graph `issue` (completion = that issue closed). `order` is a permutation of the
 *     scope ids and drives sequencing.
 *
 * Completeness is NOT enforced here — that stays the AUTHOR gate's job (`rubric/author.md`
 * rule 3(b)/rule 2). The worksheet only records the plan + (elsewhere) renders the log.
 *
 * `.strict()` is intentional (mirrors `manifest.ts`): a typo like `modee:` fails loud at
 * the soft gate rather than silently defaulting. Imports zod only.
 * Imported by: src/packs/schemas/index.ts, src/runtime/worksheet/parse.ts.
 */
import { z } from 'zod';

export const WorksheetScope = z
  .object({
    /** Scope id; for a track it is the pre-research slug `T-<slug>`. */
    id: z.string().min(1),
    /** Work-graph issue id. REQUIRED for a batch scope (completion = issue closed);
     *  absent for an auto-born single scope (completion = the active track's ledger). */
    issue: z.string().min(1).optional(),
    summary: z.string().min(1),
  })
  .strict();
export type WorksheetScope = z.infer<typeof WorksheetScope>;

export const Worksheet = z
  .object({
    mode: z.enum(['single', 'batch']).default('single'),
    /** The umbrella issue this batch belongs to (optional). */
    parent: z.string().optional(),
    order: z.array(z.string().min(1)).default([]),
    scopes: z.array(WorksheetScope).default([]),
  })
  .strict()
  // mode invariants:
  //   single ⇒ EXACTLY ONE scope, and `order` is just its id.
  //   batch  ⇒ ≥2 scopes, EVERY scope carries an `issue`, and `order` is a PERMUTATION of
  //            the scope ids (set-equality — no dups, no missing; length-equality is too weak).
  .refine(
    (w) => {
      const ids = w.scopes.map((s) => s.id);
      if (w.mode === 'single')
        return ids.length === 1 && w.order.length === 1 && w.order[0] === ids[0];
      return (
        ids.length >= 2 &&
        w.scopes.every((s) => !!s.issue) &&
        new Set(w.order).size === w.order.length &&
        w.order.length === ids.length &&
        ids.every((id) => w.order.includes(id))
      );
    },
    {
      message:
        'worksheet: single ⇒ exactly 1 scope with order=[its id]; batch ⇒ ≥2 scopes (each with an `issue`) and `order` a permutation of their ids',
    },
  );
export type Worksheet = z.infer<typeof Worksheet>;
