/**
 * YAML parser layer — schema-validating wrapper around the `yaml` v2 npm
 * package's Document API.
 *
 * Two reasons we go through `parseDocument` (not the lighter `parse`):
 *   1. Comment preservation. The setup UI (`docs/opensquid-real-design.md`
 *      §"Setup UI/UX") needs to write a user's edits back to YAML without
 *      shredding their comments — that requires the Document round-trip.
 *   2. Structured error surface. `Document.errors` is a discriminated list of
 *      lint codes (DUPLICATE_KEY, MISSING_CHAR, BAD_INDENT, …), each carrying
 *      a `linePos`. We forward those messages verbatim so callers can blame
 *      the right line.
 *
 * Validation is enforced via Zod (Task 2.1) — never via raw `JSON.parse` —
 * so this module is the single load boundary for YAML. Schemas accept
 * `unknown` input (per Zod's design) so `Document.toJSON()`'s `unknown`
 * return type drops in without a cast.
 *
 * Risk note from spec §"Task 2.2 / Risk callouts": `strict: true` does NOT
 * universally guard duplicate-key detection across yaml v2 patch versions.
 * Probe at `dup_check` (post-research) on yaml@2.9.0 confirms that the
 * installed version DOES raise `DUPLICATE_KEY` under `strict: true`, so no
 * separate detector is needed today. If a future pinned version regresses,
 * add `uniqueKeys: true` (orthogonal flag that forces the check); both
 * options are kept in scope by yaml v2's option model.
 *
 * Imports from: node:fs/promises, yaml, zod (type only).
 * Imported by: src/packs/loader.ts (Task 2.3), setup UI write-back paths.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { parseDocument, type Document } from 'yaml';
import { ZodError, type z } from 'zod';

import { parseTolerantStrict } from './tolerant_strict.js';

// ---------------------------------------------------------------------------
// Public return shape
//
// `data` is the Zod-validated, fully-defaulted JS shape — what runtime code
// consumes. `document` is the raw Document.Parsed handle — what setup UI
// code holds onto for in-place edits + round-trip writeback. Callers that
// only need the data can ignore `document`; callers that need both get them
// in one parse pass (no double-parsing).
// ---------------------------------------------------------------------------

export interface ParsedYaml<T> {
  data: T;
  document: Document.Parsed;
}

// ---------------------------------------------------------------------------
// Parse YAML file
//
// Two failure modes, both surface the source path so caller doesn't have to
// re-thread it:
//   1. YAML-level errors (syntax, duplicate keys) → all `doc.errors` joined.
//   2. Schema-level errors (shape mismatch) → Zod's `.message` (carries
//      field path).
//
// We intentionally throw plain `Error` (not custom subclasses) — Task 2.3's
// loader is the layer that introduces structured `PackLoadError` for the
// runtime to translate into setup-UI-friendly messages.
// ---------------------------------------------------------------------------

export async function parseYamlFile<T>(path: string, schema: z.ZodType<T>): Promise<ParsedYaml<T>> {
  const raw = await readFile(path, 'utf8');
  return parseYamlString(raw, schema, path);
}

// ---------------------------------------------------------------------------
// Parse YAML string (in-memory)
//
// Lifted out of `parseYamlFile` so tests + future stdin/network paths can
// validate raw text without touching the filesystem. `ctx` is the source
// label that appears in thrown error messages — file path, "<stdin>",
// "<test-input>", whatever the caller wants the user to see.
// ---------------------------------------------------------------------------

export function parseYamlString<T>(
  raw: string,
  schema: z.ZodType<T>,
  ctx = '<inline>',
): ParsedYaml<T> {
  const doc = parseDocument(raw, { strict: true });

  if (doc.errors.length > 0) {
    const msg = doc.errors.map((e) => e.message).join('; ');
    throw new Error(`YAML parse errors in ${ctx}: ${msg}`);
  }

  // Route the schema step through the tolerant-strict seam: an unknown/forward top-level key warns + strips
  // (no longer takes down the loop); a genuine schema error re-throws a ZodError, re-wrapped in today's
  // `Schema validation failed for <ctx>` message so the source label + genuine-error surface are preserved.
  try {
    const data = parseTolerantStrict(schema, doc.toJSON(), ctx);
    return { data, document: doc };
  } catch (e) {
    if (e instanceof ZodError) {
      throw new Error(`Schema validation failed for ${ctx}: ${e.message}`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Serialize a Document back to disk
//
// Round-trip path for the setup UI: parse → mutate `doc.contents` via the
// Document API → write. Using `doc.toString()` (not `stringify(doc.toJSON())`)
// is what preserves comments + key ordering + anchor/tag info.
// ---------------------------------------------------------------------------

export async function serializeYamlDocument(path: string, doc: Document.Parsed): Promise<void> {
  await writeFile(path, doc.toString(), 'utf8');
}
