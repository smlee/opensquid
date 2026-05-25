/**
 * `text_pattern_match` primitive — generic regex check on event text fields.
 *
 * Used by G.5's `verify-before-citing-memory` skill to scan a Stop event's
 * `assistantText` for drift-prone phrases ("per memory", "the plan is",
 * "deferred", etc.). Generic by design — the pattern list and the field
 * path are both pack-authored, so the same primitive serves any future
 * "watch event text for these phrases" skill.
 *
 * Field extraction: `text_field` supports dot notation
 * (`assistantText`, `payload.body.text`) via a null-safe traversal — a
 * missing segment yields `undefined` rather than throwing. The primitive
 * gracefully degrades to `{ matched: [], phrases: [] }` when the path
 * does not resolve to a string.
 *
 * Per-pattern execution-time cap (per G.5 spec Phase-2 lock #5): each
 * pattern's `exec` loop is bounded by 10ms wall-clock. If the loop
 * exceeds the budget we log a stderr warning and skip the remaining
 * matches for THAT pattern (other patterns continue). Word-boundary
 * patterns shouldn't hit the cap in practice; the guard is defensive
 * against future authors who might add a catastrophic-backtracking
 * regex by accident.
 *
 * Error model: returns `arg_invalid` if a regex literal is malformed.
 * Never throws — this is a runtime primitive inside a hook bin.
 *
 * Imports from: zod, ../runtime/result.js, ./registry.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { z } from 'zod';

import { err, ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

/** Maximum wall-clock budget per regex pattern. See header. */
const PER_PATTERN_BUDGET_MS = 10;

export const TextPatternMatchArgs = z
  .object({
    text_field: z.string().min(1),
    patterns: z.array(z.string()).min(1),
    case_sensitive: z.boolean().default(false),
  })
  .strict();

interface TextPatternMatchResult {
  matched: string[];
  phrases: { phrase: string; offset: number }[];
}

function extractField(event: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    return (cur as Record<string, unknown>)[key];
  }, event);
}

export const TextPatternMatch: FunctionDef<
  z.input<typeof TextPatternMatchArgs>,
  TextPatternMatchResult
> = {
  name: 'text_pattern_match',
  argSchema: TextPatternMatchArgs,
  durable: false,
  memoizable: true,
  costEstimateMs: 1,
  execute: (args, ctx) => {
    const caseSensitive = args.case_sensitive ?? false;
    const text = extractField(ctx.event, args.text_field);
    if (typeof text !== 'string') return Promise.resolve(ok({ matched: [], phrases: [] }));
    const flags = caseSensitive ? 'g' : 'gi';
    const phrases: { phrase: string; offset: number }[] = [];
    for (const pat of args.patterns) {
      let re: RegExp;
      try {
        re = new RegExp(pat, flags);
      } catch (e) {
        return Promise.resolve(
          err({
            kind: 'arg_invalid' as const,
            message: `bad regex "${pat}": ${(e as Error).message}`,
            cause: e,
          }),
        );
      }
      const start = Date.now();
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (Date.now() - start > PER_PATTERN_BUDGET_MS) {
          process.stderr.write(
            `[opensquid:text_pattern_match] WARN: pattern "${pat}" exceeded ${String(PER_PATTERN_BUDGET_MS)}ms budget; skipping remaining matches\n`,
          );
          break;
        }
        phrases.push({ phrase: m[0], offset: m.index });
        // Guard against zero-width matches that would otherwise infinite-loop.
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
    }
    return Promise.resolve(ok({ matched: phrases.map((p) => p.phrase), phrases }));
  },
};
