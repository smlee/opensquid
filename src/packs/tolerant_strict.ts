/**
 * CLR.1 — the single tolerant-strict pack-config parse seam (pure; the one side
 * effect is isolated to an injected `warn` sink).
 *
 * A `.strict()` pack-config schema rejects an unknown top-level key with a
 * `ZodError` whose issues are all `code: 'unrecognized_keys'`. Before this seam
 * that error propagated through `loadActiveEntry` (re-throw, not ENOENT) up to
 * `bootstrap` → uncaught → `process.exit`: one forward/typo'd config line took
 * down the whole loop. This seam distinguishes that case DETERMINISTICALLY from
 * a genuinely-broken pack:
 *
 *   - EVERY issue is `unrecognized_keys` (the pack is otherwise valid) → WARN
 *     loudly (name the source + the unknown keys) and PROCEED with the value
 *     minus those keys (strip at each issue's `path`, re-parse the SAME strict
 *     schema — the stripped value now satisfies `.strict()`, and every default/
 *     coercion the schema applies is preserved).
 *   - ANY other failure (mixed issues, missing-required, wrong-type) → RE-THROW
 *     the original `ZodError` UNCHANGED so the existing fail-loud propagation is
 *     byte-for-byte preserved (a genuinely-broken pack still stops the loop).
 *
 * A malformed-YAML / non-Zod error never reaches here — the caller (`yaml.ts`,
 * `loader_v2.ts`) still fails loud on it before calling in. Typo-visibility is
 * PRESERVED: the key is named in the warning, never silently dropped (so this is
 * NOT a blanket `.passthrough()`/`.strip()`).
 *
 * Spec: docs/tasks/T-config-load-resilience.md §CLR.1 (wg-a02313251dfb).
 */
import { type ZodIssue, type ZodType, type ZodTypeDef } from 'zod';

/** Default warn sink — the house style (project_context.ts:161 writes `opensquid: <msg>\n` to stderr). */
const stderrWarn = (msg: string): void => void process.stderr.write(`opensquid: ${msg}\n`);

/**
 * Parse `raw` with a `.strict()` schema, tolerating ONLY unknown/forward keys.
 * See the module header for the full contract.
 *
 * `T` binds to the schema's OUTPUT type only (the third `Input` param is pinned
 * to `unknown`), so effect/transform schemas whose input and output types
 * differ (e.g. `PackV2`, a `superRefine`d object with defaults) return exactly
 * what `schema.parse(raw)` would.
 */
export function parseTolerantStrict<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  raw: unknown,
  source: string,
  warn: (msg: string) => void = stderrWarn,
): T {
  const first = schema.safeParse(raw);
  if (first.success) return first.data;

  const issues = first.error.issues;
  const allUnknown = issues.length > 0 && issues.every((i) => i.code === 'unrecognized_keys');
  if (!allUnknown) throw first.error; // genuine error → fail-loud, byte-unchanged

  const keys = issues.flatMap((i) => (i as ZodIssue & { keys: string[] }).keys);
  warn(
    `ignoring unknown config key(s) in ${source}: ${keys.map((k) => `'${k}'`).join(', ')} — ` +
      `proceeding without them (a forward/typo'd key no longer crashes the loop; fix or remove it).`,
  );

  const stripped = stripUnknownKeys(raw, issues);
  const second = schema.safeParse(stripped);
  if (!second.success) throw second.error; // defensive: any residual → fail-loud
  return second.data;
}

/**
 * Return a shallow-cloned copy of `raw` with every `unrecognized_keys` issue's
 * `keys` deleted at that issue's object `path` (top-level unknown → `path: []`;
 * a nested strict object reports a non-empty path). Only the objects on the
 * path-to-a-stripped-key are cloned; the rest is shared (the value is discarded
 * after the re-parse anyway).
 */
function stripUnknownKeys(raw: unknown, issues: readonly ZodIssue[]): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const root = shallowClone(raw);
  for (const issue of issues) {
    const keys = (issue as ZodIssue & { keys?: string[] }).keys;
    if (!keys) continue;
    const parent = descendClone(root, issue.path);
    if (parent === undefined) continue;
    for (const k of keys) delete parent[k];
  }
  return root;
}

/** Clone the objects along `path` (so deletes never mutate the caller's `raw`), returning the leaf container. */
function descendClone(
  root: Record<string, unknown>,
  path: readonly (string | number)[],
): Record<string, unknown> | undefined {
  let node: Record<string, unknown> = root;
  for (const seg of path) {
    const child = node[seg];
    if (typeof child !== 'object' || child === null) return undefined;
    const cloned = shallowClone(child);
    node[seg] = cloned;
    node = cloned;
  }
  return node;
}

function shallowClone(v: object): Record<string, unknown> {
  return Array.isArray(v)
    ? ((v as unknown[]).slice() as unknown as Record<string, unknown>)
    : { ...(v as Record<string, unknown>) };
}
