/**
 * `opensquid update` — UPD.2 of T-npm-auto-update (wg-7091e922881b).
 *
 * Detects HOW this copy of opensquid is installed and either runs the right
 * package manager or refuses with the correct manual action:
 *
 *   linked-dev   → refuse, exit 1 (an update would clobber a dev tree)
 *   npx          → nothing to update, exit 0 (`npx -y opensquid@latest` floats)
 *   local-dep    → refuse, exit 1 (update the project's dependency instead)
 *   npm-global   → `npm install -g opensquid@latest` (inherited stdio)
 *   pnpm-global  → `pnpm add -g opensquid@latest` (inherited stdio)
 *
 * `--check-only` is the UPD.1 detached refresher's entrypoint: probe the
 * registry, print current vs latest, write the cache through `refreshCache`
 * (READ-MERGE-WRITE — the notice's 24h-throttle stamp must survive).
 *
 * Auto-apply deliberately does NOT exist: updating is always a foreground
 * user-invoked command, so live-session hook-binary skew cannot happen (the
 * opt-in auto-apply + SessionStart-latch design is seeded in the work-graph
 * issue for a future track).
 *
 * Imported by: src/cli.ts.
 */

import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

import {
  CHANGELOG_URL,
  probeLatest,
  readCurrentVersion,
  refreshCache,
} from '../../runtime/update_check.js';

export type InstallMode =
  | { kind: 'linked-dev'; packageRoot: string }
  | { kind: 'npx'; packageRoot: string }
  | { kind: 'pnpm-global'; packageRoot: string }
  | { kind: 'npm-global'; packageRoot: string }
  | { kind: 'local-dep'; packageRoot: string };

export interface InstallFacts {
  /** realpath of the running package root. */
  packageRoot: string;
  /** realpath of <npm root -g>/opensquid IF it is a symlink (the npm-link
   *  target repo); null when absent or a real dir. The fact must be about
   *  THIS copy, not the machine: a prefix-installed copy on a dev machine
   *  is NOT linked-dev just because the machine has a linked entry —
   *  linked-dev iff the running copy IS the symlink's target (spiked: the
   *  temp-prefix run misclassified before this comparison existed). */
  linkedRepoRoot: string | null;
  /** realpath of `npm root -g`; null if npm absent. */
  npmGlobalRoot: string | null;
}

/** Pure classifier — all fs facts injected so tests need no real installs.
 *  Precedence is LOAD-BEARING: linked-dev FIRST (an update would clobber a
 *  dev tree — the dev machine is the live fixture), then the ephemeral /
 *  manager signatures, then the global fallthroughs. Paths are normalized
 *  to forward slashes before matching (Windows). */
export function classifyInstall(facts: InstallFacts): InstallMode {
  const p = facts.packageRoot.replaceAll('\\', '/');
  if (facts.linkedRepoRoot !== null && p === facts.linkedRepoRoot.replaceAll('\\', '/'))
    return { kind: 'linked-dev', packageRoot: p };
  if (p.includes('/_npx/')) return { kind: 'npx', packageRoot: p };
  if (p.includes('/pnpm/global/')) return { kind: 'pnpm-global', packageRoot: p };
  if (facts.npmGlobalRoot !== null && p.startsWith(facts.npmGlobalRoot.replaceAll('\\', '/')))
    return { kind: 'npm-global', packageRoot: p };
  return { kind: 'local-dep', packageRoot: p };
}

const UPDATE_COMMANDS: Record<'npm-global' | 'pnpm-global', [string, string[]]> = {
  'npm-global': ['npm', ['install', '-g', 'opensquid@latest']],
  'pnpm-global': ['pnpm', ['add', '-g', 'opensquid@latest']],
};

/** Gather the real-world facts for the classifier (the impure shell). */
export function gatherInstallFacts(): InstallFacts {
  // This file lives at <root>/{dist,src}/setup/cli/update.{js,ts} — the
  // package root is three levels up.
  let packageRoot: string;
  try {
    packageRoot = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
  } catch {
    packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
  }

  let npmGlobalRoot: string | null = null;
  try {
    const out = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 10_000 });
    const line = (out.stdout ?? '').trim();
    npmGlobalRoot = out.status === 0 && line.length > 0 ? realpathSync(line) : null;
  } catch {
    npmGlobalRoot = null;
  }

  let linkedRepoRoot: string | null = null;
  if (npmGlobalRoot !== null) {
    try {
      const entry = join(npmGlobalRoot, 'opensquid');
      if (lstatSync(entry).isSymbolicLink()) linkedRepoRoot = realpathSync(entry);
    } catch {
      linkedRepoRoot = null; // absent → not globally npm-installed
    }
  }

  return { packageRoot, linkedRepoRoot, npmGlobalRoot };
}

export function registerUpdate(program: Command): void {
  program
    .command('update')
    .description('Update opensquid to the latest published version (detects the install mode)')
    .option('--check-only', 'probe the registry + refresh the notice cache; no install')
    .action(async (opts: { checkOnly?: boolean }) => {
      const current = await readCurrentVersion();

      if (opts.checkOnly === true) {
        const latest = await probeLatest();
        if (latest === null) {
          process.stderr.write(`opensquid ${current} — registry unreachable, no check\n`);
          return;
        }
        await refreshCache(latest, new Date().toISOString());
        process.stderr.write(`opensquid ${current} — latest published: ${latest}\n`);
        return;
      }

      const mode = classifyInstall(gatherInstallFacts());
      if (mode.kind === 'linked-dev') {
        process.stderr.write(
          `opensquid update: linked dev install detected (${mode.packageRoot} is npm-linked) — ` +
            `update via git pull + pnpm build in the repo, never via the registry.\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (mode.kind === 'npx') {
        process.stderr.write(
          'opensquid update: running via npx — `npx -y opensquid@latest` always floats; nothing to update.\n',
        );
        return;
      }
      if (mode.kind === 'local-dep') {
        process.stderr.write(
          `opensquid update: installed as a project dependency (${mode.packageRoot}) — ` +
            'update it in that project (e.g. `pnpm up opensquid` / `npm update opensquid`).\n',
        );
        process.exitCode = 1;
        return;
      }

      // Probe BEFORE the spawn so old→new is printed for real (we are online
      // by definition — the PM is about to hit the registry; probe failure
      // degrades the line to the old version only, never blocks).
      const latest = await probeLatest();
      const [pm, args] = UPDATE_COMMANDS[mode.kind];
      const r = spawnSync(pm, args, { stdio: 'inherit' });
      process.exitCode = r.status ?? 1;
      if (r.status === 0) {
        const delta = latest !== null ? `${current} → ${latest}` : `was ${current}`;
        process.stderr.write(
          `opensquid updated (${delta}). If hook surfaces changed, run \`opensquid doctor hooks\`. ` +
            `Changelog: ${CHANGELOG_URL}\n`,
        );
      }
      // Deliberately NOTHING after the spawn that imports more code — the PM
      // may have just replaced this process's own dist on disk.
    });
}
