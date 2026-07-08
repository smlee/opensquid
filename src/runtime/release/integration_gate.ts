/**
 * Role: per-item consistency gate — SHIPPED iff the configured integration landed.
 * Context: IntegrationPlan, item commit sha, injectable git + stage + pr seams.
 * Constraints: fail-visible (never swallow); per-item commit identity; no production-merge required.
 * Output: IntegrationGateResult.
 */
import type { IntegrationPlan } from './version_control.js';
import type { StageIo } from './stage_integration.js';
import type { GhIo } from './stage_pr.js';
import { ensurePr } from './ensure_pr.js';
import { mergeToStage } from './stage_integration.js';

export type IntegrationGateResult =
  | { ok: true; target: string; itemCommit: string; prUrl: string }
  | { ok: false; reason: string };

/** Injectable checks — pure in tests. */
export interface GateIo {
  /** True when `commit` is reachable from `ref` (ancestor or equal). */
  isReachable: (commit: string, ref: string, cwd: string) => Promise<boolean>;
  revParse: (ref: string, cwd: string) => Promise<string>;
}

/**
 * Role: verify a durable item-owned commit is on the configured target.
 * Context: itemCommit (from the drive), target branch tip after integration.
 * Constraints: item commit identity only — not a globally pristine tree.
 * Output: boolean.
 */
export async function itemCommitOnTarget(
  itemCommit: string,
  targetRef: string,
  cwd: string,
  io: GateIo,
): Promise<boolean> {
  if (itemCommit.trim() === '') return false;
  return io.isReachable(itemCommit, targetRef, cwd);
}

export interface IntegrateItemOpts {
  plan: IntegrationPlan;
  /** HEAD (or deploy commit) produced by the item's drive — the per-item identity. */
  itemCommit: string;
  cwd: string;
  /** When hasStaging, merge item/local into staging in staging's own context. */
  stageIo?: StageIo;
  /** Optional rc tag when integrating to staging (null → skip tag). */
  rcTag?: string | null;
  ghIo: GhIo;
  gateIo: GateIo;
  prTitle?: string;
  prBody?: string;
  /**
   * Source ref to merge into staging when hasStaging.
   * Serial: typically `local` (items commit there). Parallel later: feat/<slug>.
   */
  sourceRef?: string;
}

/**
 * Role: config-driven, fail-visible integration for one shipped item.
 * Context: plan + itemCommit + seams.
 * Constraints: staging path only when plan.hasStaging; auto-PR always ensured; failures return ok:false.
 * Output: IntegrationGateResult.
 */
export async function integrateItem(opts: IntegrateItemOpts): Promise<IntegrationGateResult> {
  const { plan, itemCommit, cwd, ghIo, gateIo } = opts;
  if (itemCommit.trim() === '') {
    return { ok: false, reason: 'integration-failed: empty item commit (no durable commit)' };
  }

  if (plan.hasStaging && plan.staging !== undefined) {
    if (opts.stageIo === undefined) {
      return { ok: false, reason: 'integration-failed: stageIo required when staging is configured' };
    }
    const source = opts.sourceRef ?? plan.local;
    const { integrated } = await mergeToStage({
      sourceBranch: source,
      stagingBranch: plan.staging,
      rcTag: opts.rcTag ?? null,
      mainRoot: cwd,
      io: opts.stageIo,
    });
    if (!integrated) {
      return {
        ok: false,
        reason: `integration-failed: merge of ${source} into ${plan.staging} did not integrate`,
      };
    }
  }

  // Consistency: item commit reachable on the configured target.
  const onTarget = await itemCommitOnTarget(itemCommit, plan.target, cwd, gateIo);
  if (!onTarget) {
    // Direct path (no staging): item should already be on local after DEPLOY commit.
    // If the pack committed but we're checking wrong ref, still fail-visible.
    return {
      ok: false,
      reason: `integration-failed: item commit ${itemCommit.slice(0, 12)} not reachable on ${plan.target}`,
    };
  }

  try {
    const { url } = await ensurePr(
      {
        base: plan.prBase,
        head: plan.prHead,
        title: opts.prTitle ?? `Integrate: ${plan.prHead} → ${plan.prBase}`,
        body:
          opts.prBody ??
          `Automated integration PR. Human MERGE is the sole gate; CI tags + publishes on merge.`,
      },
      cwd,
      ghIo,
    );
    return { ok: true, target: plan.target, itemCommit, prUrl: url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `integration-failed: auto-PR — ${message}` };
  }
}
