/**
 * `opensquid gate reaudit` — the LAP-RUNNABLE CODE guess-free audit-on-diff (T-deploy-commit-gate scope-4,
 * design §2.4 + §4).
 *
 * THE WEDGE IT CLOSES: the commit gate (`gate.ts`) fail-closes unless the CODE producer's EXTERNAL guess-free
 * verdict is cached under the pack-declared `auditCacheKey`, staleness-anchored on `sha256(git diff HEAD)`
 * (`codeAuditCertifiesCurrentDiff`). The `content-audit` skill produces that verdict on the `log_phase(audit)`
 * PostToolUse reaction. (Premise corrected by T-in-lap-gating scope-4: a ralph lap now runs FULLY hooked —
 * recursion-only `OPENSQUID_LOOP_LAP`, NOT `OPENSQUID_SUBAGENT` — so that PostToolUse reaction now DOES fire
 * in-lap; the lap thus HAS an in-band audit path. This command stays a valid EXPLICIT CLI path — for a human, or a
 * belt-and-suspenders re-run — that runs the SAME CODE audit on the CURRENT diff and writes the SAME
 * `{verdict, subjectHash}` shape `cached_audit` writes, so an honest producer clears the gate without gate-gaming.
 * Whether reaudit is still LOAD-BEARING inside a lap now that hooks are live is a tracked RE-EXAMINE, T-in-lap-gating
 * §4 OUT — NOT a retirement done here.)
 *
 * ANTI-SELF-GRADING (the whole point): the verdict comes from a REAL adversarial model dispatch on the REAL diff
 * (the `reasoning` alias, mirroring `cached_audit`), and the freshness anchor is `sha256(diff)` — a lap CANNOT
 * fabricate a passing verdict for an un-audited or since-changed diff. A verdict for an old diff is rejected as
 * stale by the gate exactly as before.
 *
 * CORE vs PACK (design §4a): this carries NO fullstack-flow vocabulary. The cache KEY comes from the active
 * pack's declared `commit_gate.audit_cache_key` (`readCommitGateEvidence`); the rubric is resolved by pack id
 * (`readRubricContent('code', pack)`); the model alias (`reasoning`) is generic. A pack that declares no
 * commit-gate evidence (v1 `coding-flow`) has no lap-runnable CODE audit — `reaudit` reports that and exits.
 *
 * SEAM: the model dispatch is injected (`ReauditDeps.runAudit`) so tests exercise the write/anchor logic without
 * spawning a model — the same dependency-injection discipline as `deploy_evidence.ts` / `staged_diff.ts`.
 *
 * Imported by: src/setup/cli/gate.ts (registerGate wires the `reaudit` subcommand).
 */

import type { Command } from 'commander';

import {
  materializePackAuditPolicy,
  type MaterializedAuditPolicy,
} from '../../functions/audit_policy.js';
import { stagedDiff } from '../../functions/staged_diff.js';
import { readRubricContent } from '../../functions/read_rubric.js';
import {
  readCommitGateEvidence,
  type CommitGateEvidence,
} from '../../runtime/commit_gate_evidence.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { loadActivePacksForDispatch } from '../../runtime/bootstrap.js';
import { readSessionCwd } from '../../runtime/session_state.js';
import { auditVerdictMatchesPass } from '../../runtime/loop/audit_evidence.js';

import { dispatchCachedAudit } from '../../functions/cached_audit.js';

import { activeDisciplinePack } from './gate.js';

export { materializePackAuditPolicy } from '../../functions/audit_policy.js';
export type { MaterializedAuditPolicy } from '../../functions/audit_policy.js';

/** The dispatch input the injected `runAudit` seam receives. */
export interface AuditDispatch extends MaterializedAuditPolicy {
  sessionId: string;
  packId: string;
  subject: string;
}

/** Injectable dependencies — tests pass pure stubs; defaults resolve the live session + dispatch the model. */
export interface ReauditDeps {
  /** The live opensquid session id (CLAUDE_PROJECT_DIR → project pointer → global), or null when unresolvable. */
  sid: () => Promise<string | null>;
  /** The active discipline pack pinned at `cwd`, or null when none. */
  pack: (cwd: string) => Promise<string | null>;
  /** The pack-declared commit-gate evidence (the `auditCacheKey`), or null when the pack declares none (v1). */
  evidence: (pack: string) => Promise<CommitGateEvidence | null>;
  /** The uncommitted diff (`git diff HEAD`) the audit reviews, or null (nothing to audit / over-cap / error). */
  diff: (sid: string) => Promise<string | null>;
  /** The pack's CODE rubric, or null when absent/over-cap (fail-loud — no rubric ⇒ no audit ⇒ gate blocks). */
  rubric: (pack: string) => Promise<string | null>;
  /** Materialize the active pack's complete validated audit policy; core duplicates no schema/default. */
  policy: (
    sid: string,
    pack: string,
    auditCacheKey: string,
    rubric: string,
    diff: string,
  ) => Promise<MaterializedAuditPolicy | null>;
  /** The REAL canonical cached-audit dispatch. It owns cache persistence and returns the aggregate verdict. */
  runAudit: (d: AuditDispatch) => Promise<string>;
}

const defaultReauditDeps: ReauditDeps = {
  sid: resolveMcpSessionId,
  pack: activeDisciplinePack,
  evidence: readCommitGateEvidence,
  diff: stagedDiff,
  rubric: (pack) => readRubricContent('code', pack),
  policy: async (sid, pack, auditCacheKey, rubric, diff) => {
    const cwd = await readSessionCwd(sid);
    return cwd === null
      ? null
      : materializePackAuditPolicy(
          await loadActivePacksForDispatch(sid, cwd),
          pack,
          auditCacheKey,
          rubric,
          diff,
        );
  },
  runAudit: async ({
    model,
    lenses,
    timeoutMs,
    sessionId,
    packId,
    cacheKey,
    subject,
    passVerdict,
    failVerdict,
  }) => {
    const result = await dispatchCachedAudit(
      {
        cache_key: cacheKey,
        model,
        lenses,
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
        pass_verdict: passVerdict,
        fail_verdict: failVerdict,
        subject,
      },
      {
        event: { kind: 'stop', assistantText: '' },
        bindings: new Map(),
        sessionId,
        packId,
      },
    );
    if (!result.ok) throw new Error(result.error.message);
    if (typeof result.value !== 'string')
      throw new Error('cached_audit returned a non-string result');
    return result.value;
  },
};

/** The outcome of a reaudit run — a typed result the CLI renders (never throws to the caller). */
export type ReauditResult =
  | { ok: true; verdict: string; guessFree: boolean; cacheKey: string }
  | { ok: false; reason: string };

/**
 * Run the CODE guess-free audit on the current diff and write the gate's exact artifact. Total (never throws):
 * every failure class resolves to `{ ok: false, reason }` so the CLI can print a precise message and exit 1.
 */
export async function runReaudit(
  cwd: string,
  deps: ReauditDeps = defaultReauditDeps,
): Promise<ReauditResult> {
  const pack = await deps.pack(cwd);
  if (pack === null) {
    return { ok: false, reason: 'no discipline pack pinned in this project — nothing to audit' };
  }
  const ev = await deps.evidence(pack);
  if (ev === null) {
    return {
      ok: false,
      reason: `pack "${pack}" declares no commit_gate evidence — it has no lap-runnable CODE audit (v1 pack)`,
    };
  }
  const sid = await deps.sid();
  if (sid === null) {
    return {
      ok: false,
      reason: 'no resolvable opensquid session — run inside an opensquid session',
    };
  }
  const diff = await deps.diff(sid);
  if (diff === null) {
    return {
      ok: false,
      reason: 'no diff to audit (nothing uncommitted vs HEAD, or the diff is over the audit cap)',
    };
  }
  const rubric = await deps.rubric(pack);
  if (rubric === null) {
    return {
      ok: false,
      reason: `pack "${pack}" has no readable CODE rubric — cannot audit (fail-loud)`,
    };
  }
  const policy = await deps.policy(sid, pack, ev.auditCacheKey, rubric, diff);
  if (policy === null) {
    return {
      ok: false,
      reason: `pack "${pack}" has no valid parallel CODE audit lenses for ${ev.auditCacheKey}`,
    };
  }
  let verdict: string;
  try {
    verdict = await deps.runAudit({
      ...policy,
      sessionId: sid,
      packId: pack,
      subject: policy.subject,
    });
  } catch (e) {
    return { ok: false, reason: `CODE audit dispatch failed: ${String(e)}` };
  }
  // The audit must produce a real verdict; a spawn that returned no `VERDICT:` line is AUDIT-UNAVAILABLE, not a
  // pass — do NOT write it (mirrors cached_audit: only a real verdict is cached, so a retry is possible).
  const firstLine = verdict.split(/\r?\n/u, 1)[0] ?? '';
  if (!/^VERDICT: [A-Z][A-Z_]*$/u.test(firstLine)) {
    return {
      ok: false,
      reason: 'the audit returned no leading VERDICT: line (audit unavailable — retry)',
    };
  }
  // `runAudit` is the canonical cached_audit dispatch: it has already persisted the exact session/task cache
  // artifact, ledger, partial evidence, subject freshness anchor, and aggregate verdict. Reaudit is only an
  // adapter from active-pack policy + current diff into that one owner; it never recreates the cache datum.
  return {
    ok: true,
    verdict,
    guessFree: auditVerdictMatchesPass(firstLine, policy.passVerdict),
    cacheKey: ev.auditCacheKey,
  };
}

/** Wire the `reaudit` subcommand onto the `gate` command group (called from registerGate). */
export function registerReaudit(gate: Command): void {
  gate
    .command('reaudit')
    .description(
      'run the CODE guess-free audit on the current diff and write the commit-gate audit cache (lap-runnable)',
    )
    .action(async () => {
      const res = await runReaudit(process.cwd());
      if (!res.ok) {
        process.stderr.write(`🦑 [opensquid gate reaudit] ${res.reason}\n`);
        process.exit(1);
      }
      const line1 = res.guessFree
        ? `🦑 [opensquid gate reaudit] GUESS_FREE — cached under ${res.cacheKey}; the commit gate will pass for this diff.`
        : `🦑 [opensquid gate reaudit] NOT GUESS_FREE — findings below; fix them, then re-run reaudit.`;
      process.stdout.write(`${line1}\n\n${res.verdict}\n`);
      process.exit(res.guessFree ? 0 : 2);
    });
}
