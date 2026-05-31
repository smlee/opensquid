#!/usr/bin/env node
/**
 * H.2 verification script — walk every dir in packs/builtin/ and call
 * loadPack() on it. Each skill's `if:` clauses are validated by the new
 * Zod refinement at load time; any unparseable clause throws and is
 * surfaced verbatim. Exits 1 if any pack fails to load.
 *
 * Reports per-pack status + per-skill names so the H.2 report can cite
 * the actual set that round-trips through the new validation path.
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPack } from '../dist/packs/loader.js';

const HERE = fileURLToPath(import.meta.url);
const BUILTIN_DIR = resolve(HERE, '../../packs/builtin');

const entries = await readdir(BUILTIN_DIR, { withFileTypes: true });
const packs = entries
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let anyFailed = false;
for (const packName of packs) {
  const packDir = join(BUILTIN_DIR, packName);
  try {
    const pack = await loadPack(packDir);
    const names = pack.skills.map((s) => s.name).sort();
    console.log(
      `[OK]   ${packName}  (${pack.skills.length} skills: ${names.join(', ') || '(none)'})`,
    );
  } catch (e) {
    anyFailed = true;
    console.log(`[FAIL] ${packName}  ${e.message}`);
  }
}

if (anyFailed) {
  process.exit(1);
}
