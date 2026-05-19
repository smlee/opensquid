/**
 * Emit JSON Schemas from the six pack-config Zod schemas.
 *
 * Authoritative source: Task 2.6 of `docs/tasks/phase-2-pack-format.md` +
 * memory `project_opensquid_out_of_the_box` (bundled schemas, editor hints).
 *
 * Why this exists: opensquid packs are written as YAML files. The VS Code +
 * Vim YAML language servers (`redhat.vscode-yaml`, `vim-yaml-companion`)
 * activate autocomplete + inline validation when a YAML file declares a
 * `# yaml-language-server: $schema=...` directive pointing at a JSON Schema.
 * Zod is the source of truth for shape; this script projects each Zod schema
 * into JSON Schema (draft-07 via `zod-to-json-schema`) so editors get the
 * hints for free.
 *
 * Strategy choice — `$refStrategy: 'none'`:
 *   The default `'root'` strategy hoists shared sub-shapes into `$defs`. For
 *   our six small schemas, inlining is more reader-friendly (single-file
 *   diffable JSON, no `$ref` chains for an editor to resolve). The trade-off
 *   is mild duplication when two schemas share a type — we have almost none.
 *
 * `.strict()` round-trip: Zod's `.strict()` becomes `additionalProperties:
 * false` in JSON Schema. Only the manifest schema is `.strict()` today; the
 * others are intentionally permissive (skills/models/channels/notifications/
 * drift_response have extension points). That asymmetry is preserved by
 * `zodToJsonSchema` — we just emit what Zod says.
 *
 * Output layout: `schemas/<name>.schema.json` at repo root, where:
 *   - `package.json#files` already lists `schemas` → ships in the tarball.
 *   - `prepublishOnly` (Task 2.6) regenerates before each publish so emitted
 *     files cannot drift from the Zod source.
 *   - The emitted JSON is also committed for reviewer inspection (a Zod
 *     change that perturbs schema shape shows up as a diff).
 *
 * Export shape: `emitSchemas(outDir)` returned for the unit test to drive
 * emission into a temp dir without filesystem coupling. A CLI wrapper at the
 * bottom dispatches when the script is invoked directly (`tsx
 * scripts/emit-schemas.ts`).
 *
 * Imports from: node:fs/promises, node:path, zod-to-json-schema, src/packs/schemas/.
 * Invoked by: `pnpm schemas` (manual), `pnpm prepublishOnly` (release gate),
 *             scripts/emit-schemas.test.ts (unit test).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { ChannelsConfig } from '../src/packs/schemas/channels.js';
import { DriftResponseConfig } from '../src/packs/schemas/drift_response.js';
import { Manifest } from '../src/packs/schemas/manifest.js';
import { ModelsConfig } from '../src/packs/schemas/models.js';
import { NotificationsConfig } from '../src/packs/schemas/notifications.js';
import { Skill } from '../src/packs/schemas/skill.js';

// ---------------------------------------------------------------------------
// Schema registry — the six pack-config Zod schemas.
//
// Order is alphabetical for deterministic diffs across runs. Each tuple is
// `[file-stem, Zod-schema]`; the file-stem becomes both the output filename
// (`<stem>.schema.json`) and the `name` argument to `zodToJsonSchema` (which
// places the schema under `definitions.<name>` and sets `$ref` to it).
// ---------------------------------------------------------------------------

const SCHEMAS: ReadonlyArray<readonly [string, ZodType<unknown>]> = [
  ['channels', ChannelsConfig as ZodType<unknown>],
  ['drift_response', DriftResponseConfig as ZodType<unknown>],
  ['manifest', Manifest as ZodType<unknown>],
  ['models', ModelsConfig as ZodType<unknown>],
  ['notifications', NotificationsConfig as ZodType<unknown>],
  ['skill', Skill as ZodType<unknown>],
];

// ---------------------------------------------------------------------------
// emitSchemas — write all six JSON Schemas under `outDir`.
//
// Returns the list of written paths so callers (tests, CI logs) can verify
// without re-deriving the layout. `mkdir({ recursive: true })` is idempotent
// — second runs are no-ops on the directory itself.
// ---------------------------------------------------------------------------

export async function emitSchemas(outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const [name, schema] of SCHEMAS) {
    const json = zodToJsonSchema(schema, { name, $refStrategy: 'none' });
    const path = join(outDir, `${name}.schema.json`);
    await writeFile(path, JSON.stringify(json, null, 2) + '\n', 'utf8');
    written.push(path);
  }
  return written;
}

// ---------------------------------------------------------------------------
// CLI wrapper — runs only when invoked directly (`tsx scripts/emit-schemas.ts`),
// not when imported by the unit test. The `fileURLToPath` comparison is the
// ESM equivalent of CommonJS `require.main === module`.
// ---------------------------------------------------------------------------

const isDirectInvocation =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectInvocation) {
  emitSchemas('schemas')
    .then((paths) => {
      for (const p of paths) process.stdout.write(`wrote ${p}\n`);
    })
    .catch((e: unknown) => {
      process.stderr.write(`emit-schemas failed: ${String(e)}\n`);
      process.exit(1);
    });
}
