/**
 * T-project-context (write half) — detect a project's package manager.
 *
 * Source-of-truth order, most authoritative first:
 *   1. package.json `packageManager` (corepack's declared field, e.g. "pnpm@9");
 *   2. a lockfile's presence (pnpm-lock.yaml / yarn.lock / bun.lock[b] / package-lock.json).
 *
 * Returns null when nothing is detectable — the setup step then writes no
 * `package_manager` setting (there is nothing to enforce). PURE except the two
 * filesystem probes; injected `cwd` keeps it deterministic in tests.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackageManager } from '../../packs/schemas/project_context.js';

const PM_SET = new Set<PackageManager>(['pnpm', 'npm', 'yarn', 'bun']);

/** Lockfiles in detection priority (most specific first; npm last). */
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

export async function detectPackageManager(cwd: string): Promise<PackageManager | null> {
  // 1. package.json "packageManager" — the corepack-standard declaration.
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === 'string') {
      const name = pkg.packageManager.split('@')[0] as PackageManager;
      if (PM_SET.has(name)) return name;
    }
  } catch {
    /* no/unparseable package.json → fall through to lockfile probing */
  }

  // 2. lockfile presence.
  for (const [file, pm] of LOCKFILES) {
    try {
      await stat(join(cwd, file));
      return pm;
    } catch {
      /* next candidate */
    }
  }

  return null;
}
