/**
 * `validate_worksheet` primitive (T-scope-worksheet / wg-7d649d90f26a) — the SOFT GATE's checker.
 *
 * Validates worksheet markdown CONTENT (the EFFECTIVE post-write text — at PreToolUse the file on
 * disk is still the pre-write version, so the soft gate must see `effective_content`, not the path).
 * Returns a RESULT `{ valid, error? }` — NOT a verdict. The coding-flow skill's worksheet-file capture
 * binds this `as: wsv`, then a SEPARATE `verdict` step turns `!wsv.valid` into a `level: block` (the
 * two-step gate mechanism). Keeping this a pure result lets the pack decide the drift policy.
 *
 * Imports from: zod, ../runtime/result.js, ../runtime/worksheet/parse.js, ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */
import { z } from 'zod';

import { ok } from '../runtime/result.js';
import { parseWorksheetContent } from '../runtime/worksheet/parse.js';

import type { FunctionRegistry } from './registry.js';

const Args = z.object({ content: z.string() }).strict();

export function registerValidateWorksheetFunction(registry: FunctionRegistry): void {
  registry.register({
    name: 'validate_worksheet',
    argSchema: Args,
    durable: false,
    memoizable: false,
    costEstimateMs: 3,
    execute: (args) => {
      const r = parseWorksheetContent(args.content);
      return Promise.resolve('error' in r ? ok({ valid: false, error: r.error }) : ok({ valid: true }));
    },
  });
}
