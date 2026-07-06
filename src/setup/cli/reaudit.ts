/**
 * `opensquid gate reaudit` — the LAP-RUNNABLE CODE guess-free audit-on-diff (T-deploy-commit-gate scope-4,
 * design §2.4 + §4).
 *
 * THE WEDGE IT CLOSES: the commit gate (`gate.ts`) fail-closes unless the CODE producer's EXTERNAL guess-free
 * verdict is cached under the pack-declared `auditCacheKey`, staleness-anchored on `sha256(git diff HEAD)`
 * (`codeAuditCertifiesCurrentDiff`). Interactively the `content-audit` skill produces that verdict on the
 * `log_phase(audit)` PostToolUse reaction — but a ralph lap runs with `OPENSQUID_SUBAGENT=1`, which DISABLES the
 * hooks, so the lap had NO in-band way to (re)generate the exact artifact the gate checks. It could do the work
 * honestly and still wedge at commit. This command is that missing in-band path: it runs the SAME CODE audit on
 * the CURRENT diff and writes the SAME `{verdict, subjectHash}` shape `cached_audit` writes, so an honest lap
 * clears the gate without gate-gaming.
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

import { stagedDiff } from '../../functions/staged_diff.js';
import { readRubricContent } from '../../functions/read_rubric.js';
import { loadModelsConfig } from '../../models/load_config.js';
import { resolveStrategy } from '../../models/dispatcher.js';
import { atomicWriteFile } from '../../runtime/atomic_write.js';
import {
  readCommitGateEvidence,
  type CommitGateEvidence,
} from '../../runtime/commit_gate_evidence.js';
import { sha256Hex } from '../../runtime/durable/run_id.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { sessionStateFile } from '../../runtime/paths.js';

import { activeDisciplinePack } from './gate.js';

/** The `reasoning` task-purpose alias, mirroring `content-audit/skill.yaml`'s CODE audit. Generic — not pack
 *  vocabulary; the alias is resolved from the layered models config (`loadModelsConfig`). */
const AUDIT_MODEL = 'reasoning';
/** Match the skill's `timeout_ms: 340000` so the CLI and the PostToolUse producer bound the spawn identically. */
const AUDIT_TIMEOUT_MS = 340_000;

/**
 * The CODE guess-free audit prompt — the SAME instruction the `content-audit` skill's `code-guess-free-audit`
 * rule runs (packs/builtin/fullstack-flow/skills/content-audit/skill.yaml), so the CLI and the in-session
 * producer enforce one standard. The `code` rubric is the single canonical source; the diff is the artifact.
 */
export function buildCodeAuditPrompt(rubric: string, diff: string): string {
  return (
    'You are an adversarial reviewer enforcing the GUESS-FREE CODE standard on a diff. Apply EXACTLY this ' +
    'rubric (the single canonical source, injected below):\n\n' +
    `${rubric}\n\n` +
    'Begin your response with EXACTLY one line — `VERDICT: GUESS_FREE` ONLY if the diff aligns to the ' +
    'scoped element, uses APIs per their docs (no deprecated/misused), reinvents nothing, is a full fix ' +
    '(not a band-aid, not an MVP/reduced subset), and the AUTHOR spec still holds; otherwise ' +
    '`VERDICT: UNRESOLVED` + one bullet per offending hunk. DIFF:\n\n' +
    diff
  );
}

/** The dispatch input the injected `runAudit` seam receives (mirrors `cached_audit`'s call args). */
export interface AuditDispatch {
  model: string;
  prompt: string;
  timeoutMs: number;
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
  /** The REAL adversarial audit dispatch. Returns the raw verdict text (must contain `VERDICT:`). */
  runAudit: (d: AuditDispatch) => Promise<string>;
  /** Persist the cache entry (atomic write to the session-state file). */
  write: (sid: string, key: string, entry: string) => Promise<void>;
}

const defaultReauditDeps: ReauditDeps = {
  sid: resolveMcpSessionId,
  pack: activeDisciplinePack,
  evidence: readCommitGateEvidence,
  diff: stagedDiff,
  rubric: (pack) => readRubricContent('code', pack),
  runAudit: async ({ model, prompt, timeoutMs }) => {
    // The SAME dispatch path as `cached_audit`: resolve the alias from the layered models config, then call the
    // strategy with the bounded timeout. No pack models layer needed — `reasoning` lives in the user-level config.
    const cfg = await loadModelsConfig();
    const aliasCfg = cfg[model];
    if (!aliasCfg) throw new Error(`Unknown model alias "${model}"`);
    return resolveStrategy(model, aliasCfg).call(prompt, { timeoutMs });
  },
  write: (sid, key, entry) => atomicWriteFile(sessionStateFile(sid, key), entry),
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
  const prompt = buildCodeAuditPrompt(rubric, diff);
  let verdict: string;
  try {
    verdict = await deps.runAudit({ model: AUDIT_MODEL, prompt, timeoutMs: AUDIT_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, reason: `CODE audit dispatch failed: ${String(e)}` };
  }
  // The audit must produce a real verdict; a spawn that returned no `VERDICT:` line is AUDIT-UNAVAILABLE, not a
  // pass — do NOT write it (mirrors cached_audit: only a real verdict is cached, so a retry is possible).
  if (!verdict.includes('VERDICT:')) {
    return { ok: false, reason: 'the audit returned no VERDICT: line (audit unavailable — retry)' };
  }
  // Write the EXACT shape `cached_audit` writes and the gate reads: `{hash, verdict, subjectHash}`. `subjectHash`
  // is `sha256(diff)` — the freshness anchor `codeAuditCertifiesCurrentDiff` re-derives from `git diff HEAD`.
  await deps.write(
    sid,
    ev.auditCacheKey,
    JSON.stringify({ hash: sha256Hex(prompt), verdict, subjectHash: sha256Hex(diff) }, null, 2),
  );
  return {
    ok: true,
    verdict,
    guessFree: verdict.includes('VERDICT: GUESS_FREE'),
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
