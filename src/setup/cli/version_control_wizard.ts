/**
 * Role: elicit version-control.environments at setup and write active.json.
 * Context: project .opensquid scope; @clack/prompts for interactive input.
 * Constraints: production required; staging optional (empty = no stage); local defaults to production.
 * Output: written path + resolved block.
 */
import { text, intro, outro, isCancel, cancel, note } from '@clack/prompts';
import { join } from 'node:path';
import type { Command } from 'commander';

import {
  resolveEnvironments,
  writeVersionControl,
  type VersionControlBlock,
} from '../../runtime/release/version_control.js';
import { resolveLocalStoreDir } from '../../runtime/paths.js';

export interface VersionControlWizardDeps {
  cwd?: string;
  /** Non-interactive test inject: skip prompts, use these values. */
  values?: {
    production: string;
    staging?: string;
    local?: string;
    versionPrefix?: string;
  };
}

export async function runVersionControlWizard(
  deps: VersionControlWizardDeps = {},
): Promise<{ written: string; block: VersionControlBlock }> {
  const cwd = deps.cwd ?? process.cwd();
  // Prefer existing project store; otherwise create `<cwd>/.opensquid` (first-time setup).
  let scopeRoot: string;
  try {
    scopeRoot = await resolveLocalStoreDir(cwd);
  } catch {
    scopeRoot = join(cwd, '.opensquid');
  }

  let production: string;
  let staging: string;
  let local: string;
  let versionPrefix: string;

  if (deps.values !== undefined) {
    production = deps.values.production;
    staging = deps.values.staging ?? '';
    local = deps.values.local ?? '';
    versionPrefix = deps.values.versionPrefix ?? '0.5';
  } else {
    intro('OpenSquid version-control environments');
    const p = await text({
      message: 'production branch (trunk — human merge gate)',
      placeholder: 'main',
      defaultValue: 'main',
      validate: (v) => (v.trim().length === 0 ? 'production is required' : undefined),
    });
    if (isCancel(p)) {
      cancel('setup cancelled');
      process.exit(0);
    }
    production = String(p).trim();

    const s = await text({
      message: 'staging branch (optional protection layer — leave empty for no stage)',
      placeholder: 'stage',
      defaultValue: '',
    });
    if (isCancel(s)) {
      cancel('setup cancelled');
      process.exit(0);
    }
    staging = String(s).trim();

    const l = await text({
      message: 'local branch (serial work base — empty defaults to production)',
      placeholder: production,
      defaultValue: '',
    });
    if (isCancel(l)) {
      cancel('setup cancelled');
      process.exit(0);
    }
    local = String(l).trim();

    const pref = await text({
      message: 'locked versioning prefix (major.minor the loop never bumps past patch)',
      placeholder: '0.5',
      defaultValue: '0.5',
    });
    if (isCancel(pref)) {
      cancel('setup cancelled');
      process.exit(0);
    }
    versionPrefix = String(pref).trim() || '0.5';
  }

  const environments = {
    production,
    ...(staging === '' ? {} : { staging }),
    ...(local === '' ? {} : { local }),
  };
  const resolved = resolveEnvironments(environments);
  if (!resolved.ok) {
    throw new Error(resolved.reason);
  }

  const block: VersionControlBlock = {
    environments,
    versioning: {
      strategy: 'locked-prefix',
      prefix: versionPrefix,
      bump: 'patch-per-release',
    },
  };
  await writeVersionControl(scopeRoot, block);

  const planNote =
    resolved.environments.staging !== undefined
      ? `has-stage: work on ${resolved.environments.local} → land on ${resolved.environments.staging} → PR → ${resolved.environments.production}`
      : `no-stage: work on ${resolved.environments.local} → PR → ${resolved.environments.production}`;

  if (deps.values === undefined) {
    note(planNote, 'deterministic route');
    outro(`wrote ${join(scopeRoot, 'active.json')}`);
  }

  return { written: join(scopeRoot, 'active.json'), block };
}

export function registerVersionControlWizard(wizard: Command): Command {
  wizard
    .command('version-control')
    .description(
      'Elicit version-control.environments (production/staging/local) into project active.json',
    )
    .action(async () => {
      await runVersionControlWizard();
    });
  return wizard;
}
