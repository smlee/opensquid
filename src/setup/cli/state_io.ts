/**
 * Shared state-I/O helpers for the CLI's `*_state.ts` files (T-SIC).
 *
 * Four helpers consolidate four patterns previously reimplemented across
 * webhooks_state, permissions_state, triggers_state, schedule_state
 * (full inventory + duplication shape in T-state-io-consolidate
 * pre-research §1 + §2):
 *
 *   - writeKeyedYamlList — atomic `mkdir + tmp + writeFile + rename` for
 *     a YAML file whose root is `{ <key>: [...items] }`. Empty-list
 *     branch emits the literal `${key}: []\n` (T-SIC L9 — byte-preserves
 *     the existing on-disk format; `yaml.stringify` emits the same bytes
 *     without a trailing newline, so we hand-craft to match).
 *   - readKeyedYamlList — read the same shape with ENOENT default +
 *     bespoke error label (T-SIC L4) + per-row TypeGuard predicate
 *     (T-SIC L3, drops invalid rows silently — matches the existing
 *     posture across all five sites).
 *   - appendJsonlEntry — `mkdir + appendFile` for JSON-line audit logs.
 *   - readJsonlEntries — read JSONL with ENOENT default + silent
 *     malformed-line skip (T-SIC L11 — schedule_state.readHistory's
 *     previous strict-throw is normalized to silent-skip to match
 *     permissions_state.readAuditEntries; verified no test relied on
 *     the throw).
 *
 * Imports from: node:fs/promises, node:path, yaml.
 * Imported by: webhooks_state.ts, permissions_state.ts, triggers_state.ts,
 *   schedule_state.ts + state_io.test.ts.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * Atomic keyed-YAML-list write. The body is `{ [key]: [...items] }`
 * serialized via `yaml.stringify`, OR the literal `${key}: []\n` when
 * `items` is empty (T-SIC L9 — byte-preserves the existing on-disk
 * format).
 *
 * Atomicity contract: write to `${path}.tmp` first, then `rename` onto
 * `path`. The `tmp` file lives in the SAME directory so the rename
 * stays on one filesystem (POSIX atomicity guarantee). Concurrent CLI
 * invocations are not serialized here — callers MUST pass the FULL
 * desired list (per the existing JSDoc convention on writeWebhooksFile
 * et al.).
 */
export async function writeKeyedYamlList<T>(
  path: string,
  key: string,
  items: readonly T[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = items.length === 0 ? `${key}: []\n` : stringifyYaml({ [key]: [...items] });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

/**
 * Read a YAML mapping with a single list key.
 *
 * Returns `defaultValue` (default `[]`) on ENOENT, an empty root mapping,
 * or a missing key. Throws a `${label}`-prefixed error on malformed YAML,
 * the root not being a mapping, or the key not being a list. `predicate`
 * filters per-row to the validated `T` shape; rows that fail the
 * predicate are dropped silently (matches every existing call site's
 * posture — drift on a single row mustn't break the whole CLI verb).
 */
export async function readKeyedYamlList<T>(
  path: string,
  key: string,
  label: string,
  predicate: (v: unknown) => v is T,
  defaultValue: T[] = [],
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultValue;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(
      `${label} is malformed (${path}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (parsed === null || parsed === undefined) return defaultValue;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a mapping (${path})`);
  }
  const list = (parsed as Record<string, unknown>)[key];
  if (list === undefined) return defaultValue;
  if (!Array.isArray(list)) {
    throw new Error(`${label}: \`${key}\` must be a list (${path})`);
  }
  return list.filter(predicate);
}

/** Append one JSON-encoded entry as a newline-terminated line. `mkdir -p` first. */
export async function appendJsonlEntry(path: string, entry: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Read JSONL, skipping malformed lines silently. ENOENT → `[]`.
 *
 * T-SIC L11 NOTE: the previous `schedule_state.readHistory` posture was
 * `.map(line => JSON.parse(line))` which throws on the first malformed
 * line. This helper instead skips malformed lines (matches the previous
 * `permissions_state.readAuditEntries` posture). Verified no test relied
 * on the strict-throw; the user-facing improvement is that a single
 * corrupted line can't break the whole CLI verb.
 */
export async function readJsonlEntries<T = unknown>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip malformed line — don't fail the whole CLI verb on one bad row */
    }
  }
  return out;
}
