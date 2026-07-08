/**
 * Role: manual trigger of the same ensure-PR path the loop uses (no direct merge to production).
 * Context: version-control.environments from active.json; injectable seams for tests.
 * Constraints: human MERGE is the sole gate; fail-visible; no stage/rc batching in this command.
 * Output: process exit code (0 success, non-zero refusal).
 */
import type { Command } from 'commander';
import { join } from 'node:path';

import { readVersionControl } from '../../runtime/release/version_control.js';
import { ensurePr, realEnsurePrIo, type EnsurePrIo } from '../../runtime/release/ensure_pr.js';
import type { IntegrationPlan } from '../../runtime/release/version_control.js';

export interface ReleaseDeps {
  versionControl?: (cwd: string) => Promise<{ plan: IntegrationPlan } | null>;
  ensurePr?: (
    a: { base: string; head: string; title: string; body: string },
    cwd: string,
  ) => Promise<{ url: string; created: boolean }>;
  ghIo?: EnsurePrIo;
}

function fail(msg: string): number {
  process.stderr.write(`release refused: ${msg}\n`);
  return 1;
}

/**
 * Role: ensure the integration PR (staging→production or local→production) is open.
 * Context: cwd project root.
 * Constraints: requires version-control.environments; never merges; never publishes locally.
 * Output: exit code.
 */
export async function runRelease(cwd: string, deps: ReleaseDeps = {}): Promise<number> {
  const vc =
    deps.versionControl !== undefined
      ? await deps.versionControl(cwd)
      : await readVersionControl(join(cwd, '.opensquid'));
  if (vc === null) {
    return fail(
      'no version-control.environments in .opensquid/active.json — run `opensquid setup wizard version-control`',
    );
  }
  const { plan } = vc;
  const open = deps.ensurePr ?? ((a, c) => ensurePr(a, c, deps.ghIo ?? realEnsurePrIo));
  try {
    const { url, created } = await open(
      {
        base: plan.prBase,
        head: plan.prHead,
        title: `Integrate: ${plan.prHead} → ${plan.prBase}`,
        body: `Manual release trigger. Human MERGE is the sole gate; CI tags + publishes on merge.`,
      },
      cwd,
    );
    process.stdout.write(
      `${created ? 'Opened' : 'Ensured'} PR ${plan.prHead} → ${plan.prBase}: ${url}\n` +
        `Click MERGE to release to ${plan.production}.\n`,
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

export function registerRelease(program: Command): Command {
  return program
    .command('release')
    .description(
      'Ensure the integration PR (staging→production or local→production) is open; human MERGE is the sole gate',
    )
    .action(async () => {
      process.exit(await runRelease(process.cwd()));
    });
}
