/**
 * Orchestrates the auto-memory → opensquid import (G.6).
 *
 * Reads every `*.md` (minus `MEMORY.md`, the index) in a source directory,
 * parses each via the reader, dedupes against an existing-name set, and
 * (unless `dryRun`) calls `engine.memoryCreate` per file.
 *
 * Dedup identity: the auto-memory file's frontmatter `name` field. Engine
 * `MemoryListRow` has no `name` column, so we round-trip the slug through
 * `origin.host` using the `IMPORT_HOST_PREFIX` marker. `fetchExistingImportNames`
 * pages `memory.list` once and re-extracts the slug set — caller passes that
 * set in via `opts.existingNames` so iteration is purely local.
 *
 * Scope mapping (Phase-2 lock): feedback / user / reference → user-scope;
 * project → project-scope. All imports tagged `authored_by: 'user'`
 * (auto-memory is by definition user-authored → eviction-immune).
 *
 * `fileWhitelist` is the G.7 hook hand-off: when set, only basenames in the
 * list are candidates. Undefined → all `.md` files except `MEMORY.md`.
 *
 * Imports from: node:fs, node:path, ../../engine/client.js, ./auto_memory_reader.js.
 * Imported by: setup/cli/memory.ts, auto_memory_importer.test.ts.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { EngineClient } from '../../engine/client.js';

import { readAutoMemory } from './auto_memory_reader.js';

const TYPE_TO_SCOPE: Record<string, 'user' | { project: string }> = {
  user: 'user',
  feedback: 'user',
  reference: 'user',
  project: { project: '' },
};

/** Marker that lets us re-derive the auto-memory `name` slug from the engine row. */
export const IMPORT_HOST_PREFIX = 'opensquid-import:auto-memory:';

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: { path: string; reason: string }[];
}

export interface ImportOpts {
  dryRun: boolean;
  /** Pre-fetched set of auto-memory names already present in the engine. */
  existingNames: Set<string>;
  /** G.7 snapshot hook hand-off; undefined → all .md files except MEMORY.md. */
  fileWhitelist?: string[];
}

export async function importAutoMemoryDir(
  dir: string,
  engine: EngineClient,
  opts: ImportOpts,
): Promise<ImportResult> {
  const allFiles = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const files = opts.fileWhitelist
    ? allFiles.filter((f) => opts.fileWhitelist!.includes(f))
    : allFiles;
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
  for (const file of files) {
    const path = join(dir, file);
    try {
      const parsed = await readAutoMemory(path);
      if (opts.existingNames.has(parsed.frontmatter.name)) {
        result.skipped += 1;
        continue;
      }
      if (!opts.dryRun) {
        await engine.memoryCreate({
          description: parsed.frontmatter.description,
          content: parsed.body,
          authored_by: 'user',
          scope: TYPE_TO_SCOPE[parsed.frontmatter.metadata.type] ?? 'user',
          origin: { host: `${IMPORT_HOST_PREFIX}${parsed.frontmatter.name}` },
        });
        // Track in-set so the same name twice in one run still dedupes.
        opts.existingNames.add(parsed.frontmatter.name);
      }
      result.imported += 1;
    } catch (e) {
      result.errors.push({ path, reason: (e as Error).message });
    }
  }
  return result;
}

/**
 * Pages `engine.memoryList` and returns the set of auto-memory `name`
 * slugs already present (extracted from `origin.host` via `IMPORT_HOST_PREFIX`).
 *
 * Caller is responsible for passing this to `importAutoMemoryDir` so the
 * importer stays a pure iteration loop. `dryRun` callers still want this
 * set so the preview is accurate.
 */
export async function fetchExistingImportNames(
  engine: EngineClient,
  pageSize = 200,
): Promise<Set<string>> {
  const names = new Set<string>();
  let offset = 0;
  // Cap iterations so a bug in the engine list doesn't infinite-loop here.
  for (let i = 0; i < 1000; i++) {
    const page = await engine.memoryList({ limit: pageSize, offset });
    for (const row of page.results) {
      const host = row.origin?.host;
      if (host?.startsWith(IMPORT_HOST_PREFIX)) {
        names.add(host.slice(IMPORT_HOST_PREFIX.length));
      }
    }
    if (page.returned < pageSize) break;
    offset += page.returned;
  }
  return names;
}
