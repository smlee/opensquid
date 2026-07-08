/**
 * Role: thin re-export of base-refresh + semantic branch helpers for the loop.
 * Context: version-control.environments.production as the reconcile base.
 * Constraints: no mechanical auto/wg-<id>; no --ff-only reject-on-divergence.
 * Output: reconcileBase / featBranchFromTitle.
 *
 * AGF.2 rewritten: whoever's-ahead reconcile lives in release/base_refresh.ts.
 */
export {
  reconcileBase,
  realBaseRefreshIo,
  featBranchFromTitle,
  type BaseRefreshIo,
  type ReconcileResult,
} from '../release/base_refresh.js';

/**
 * @deprecated Mechanical auto/wg-<id> naming is retired (semantic env branches + feat/<slug> under parallelism).
 * Kept as a throw-away alias so any stray import fails loudly at runtime if still called.
 */
export function branchNameFor(_id: string): never {
  throw new Error(
    'branchNameFor(auto/wg-<id>) is retired — use environments.* branch names (serial) or featBranchFromTitle (parallelism)',
  );
}

/**
 * Role: refresh the configured production base before a loop pass.
 * Context: cwd + production branch name from version-control.
 * Constraints: preserve-whoever's-ahead; conflict surfaces as thrown Error.
 * Output: void (throws on conflict).
 */
export async function autoPullMain(
  cwd: string,
  remote = 'origin',
  production = 'main',
): Promise<void> {
  const { reconcileBase: reconcile, realBaseRefreshIo } =
    await import('../release/base_refresh.js');
  const result = await reconcile(cwd, production, remote, realBaseRefreshIo);
  if (result.kind === 'conflict') {
    throw new Error(
      `base-refresh conflict on ${production}: ${result.message} — human must resolve (hot-patch preserved; never auto-reset)`,
    );
  }
}
