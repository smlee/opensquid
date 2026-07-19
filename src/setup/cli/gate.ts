/**
 * `opensquid gate commit|push` — the owned-boundary EXECUTE gate (GF.2 — F2 + F3 + F4).
 *
 * Invoked by the opensquid-managed git `pre-commit` / `pre-push` hooks. Instead of
 * pattern-matching tool calls (a denylist over an unbounded input — the F2/F3/F4 hole),
 * enforcement moves to the boundary git OWNS: git runs these hooks on EVERY commit/push
 * unconditionally and the gate reads the REAL changed files (ground truth — no
 * path-guessing) plus the same session FSM / phase / active-task state, and blocks there.
 *
 * Contract (total):
 *   - NON-gated repo (no `.opensquid/active.json` opting into `coding-flow`) → ALLOW (0).
 *     Never block an unrelated commit on the machine.
 *   - No changed files, or a docs-only change (flow artifacts: pre-research / spec /
 *     CHANGELOG live under docs/) → ALLOW (0).
 *   - GATED repo with code changes: FAIL CLOSED — block (2) unless the live session has an
 *     active task whose FSM reached `phases_complete` with a complete 7-phase ledger. A
 *     terminal `phases_complete` is unreachable without SCOPE (guess-audit) + AUTHOR
 *     (spec-audit) having passed, so this one check transitively enforces all three stages.
 *   - No resolvable session in a gated repo → block (cannot prove the flow ran).
 *
 * The only honest escape is `git commit --no-verify`, a single closed opt-out token a
 * narrow PreToolUse detector covers (GF.3). Session resolution out-of-band:
 * `resolveMcpSessionId` (CLAUDE_PROJECT_DIR → project-scoped pointer → global).
 *
 * Imported by: src/cli.ts (registerGate); the installed git hooks (`exec opensquid gate …`).
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Command } from 'commander';

import { stagedDiff } from '../../functions/staged_diff.js';
import { resolveEnvironments } from '../../packs/discovery.js';
import {
  readCommitGateEvidence,
  type CommitGateEvidence,
} from '../../runtime/commit_gate_evidence.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { sha256Hex } from '../../runtime/durable/run_id.js';
import { resolveProjectScopeRoot, sessionStateFile } from '../../runtime/paths.js';
import { PROTECTED_PREFIXES, isDocsOnly } from '../../runtime/protected_paths.js';
import {
  commitSubjectsSince,
  // REL.3: the shared conventional-commit predicate — single-sourced from REL.2, imported both here (the
  // commit-msg gate + the pre-push range backstop) and by REL.4's bump path. No duplicate parser.
} from '../../runtime/release/release_core.js';
import { validateConventionalMessage } from '../../runtime/release/release_semver.js';
import { readFsmStateRaw } from '../../runtime/fsm_state.js';
import { readTaskAuditCache } from '../../runtime/loop/task_audit_cache.js';
import { readSuite } from '../../runtime/loop/verification.js';
import { readActiveTask } from '../../runtime/session_state.js';
import { isComplete, readPhaseState } from '../../runtime/workflow_phases.js';

import { appendAttestation, readAttestedShas } from './attestations.js';
import { registerReaudit } from './reaudit.js';

const execFileP = promisify(execFile);
/** E0 (docs/design/v2-enforcement-implementation.md §0): the discipline packs whose presence
 *  in active.json ARMS the commit gate. Before E0 this was the literal constant `'coding-flow'`,
 *  so pinning v2 (`fullstack-flow`) made `isGatedRepo` return false and silently DISABLED the gate. */
const DISCIPLINE_PACKS = ['coding-flow', 'fullstack-flow'] as const;
type DisciplinePack = (typeof DISCIPLINE_PACKS)[number];

/** The active discipline pack, or null if none is pinned. Project-only operation: this reads the
 *  PROJECT scope's `active.json` ONLY (via `resolveProjectScopeRoot(cwd)`, which never resolves to the
 *  user/home root). The user/home scope (`~/.opensquid`) no longer arms the gate — global enforces
 *  nothing; a project with no discipline pack has no commit gate. This keeps the commit gate consulting
 *  the SAME project-only scope as the GS1 guard + the pack loaders. */
export async function activeDisciplinePack(cwd: string): Promise<DisciplinePack | null> {
  const scopeRoot = await resolveProjectScopeRoot(cwd);
  if (scopeRoot === null) return null;
  try {
    const parsed = JSON.parse(await readFile(join(scopeRoot, 'active.json'), 'utf8')) as {
      packs?: unknown;
    };
    const packs = Array.isArray(parsed.packs) ? parsed.packs : [];
    const hit = DISCIPLINE_PACKS.find((p) => packs.includes(p));
    if (hit !== undefined) return hit;
  } catch {
    /* absent/malformed project scope → not active here */
  }
  return null;
}

/** Is this invocation gated? Project-only operation: the gate arms iff the PROJECT at `cwd` pins a
 *  discipline pack in its own `.opensquid/active.json` (global enforces nothing — a repo the agent
 *  hasn't opted into is never blocked). Humans pass upstream regardless (isAgentInvocation, GDC.1). */
export async function isGatedRepo(cwd: string): Promise<boolean> {
  return (await activeDisciplinePack(cwd)) !== null;
}

/** The files a `commit` would record (staged) or a `push` would publish (HEAD vs upstream).
 *  Empty array on any git error — the caller treats "nothing to gate" as ALLOW. */
async function changedFiles(boundary: 'commit' | 'push', cwd: string): Promise<string[]> {
  const split = (s: string): string[] =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  try {
    if (boundary === 'commit') {
      const { stdout } = await execFileP('git', ['diff', '--cached', '--name-only'], { cwd });
      return split(stdout);
    }
    // push: the commits ahead of the upstream; fall back to the last commit.
    const { stdout } = await execFileP('git', ['diff', '--name-only', '@{u}..HEAD'], {
      cwd,
    }).catch(() => execFileP('git', ['diff', '--name-only', 'HEAD~1..HEAD'], { cwd }));
    return split(stdout);
  } catch {
    return [];
  }
}

/** GDC.1 — the flow protects CODE: the same boundary set the in-session write
 *  gates arm on (scope-lifecycle/skill.yaml:284 — keep the two lists in sync;
 *  the drift pin in gate.test.ts enforces it). Those matchers are deliberately
 *  loose substrings; THIS layer is "the precise boundary" (skill.yaml's own
 *  framing), so startsWith over git's repo-relative paths is the exact form.
 *  A change touching NONE of these is not the flow's subject (README, banner,
 *  docs/, LICENSE, CI config…) → allowed, attested under the existing
 *  `docs_only` wire reason (now meaning "non-code"). [] still fails closed
 *  (commitFiles' git-error contract). The predicate now lives in one home —
 *  `runtime/protected_paths.ts` — shared with the in-session `staged_docs_only`
 *  primitive so the boundary and the nudge can never diverge. Imported for local
 *  use AND re-exported because gate.test.ts's drift pin imports
 *  `PROTECTED_PREFIXES` from this module. */
export { PROTECTED_PREFIXES };

/** GDC.1 — the gate's subject is the AGENT, never the human (user directive
 *  2026-06-11: "I should be able to use the commands naturally"). Agent hosts
 *  mark their spawned shells (live-probed: Claude Code sets CLAUDECODE +
 *  AI_AGENT; codex exec sets CODEX_THREAD_ID + AI_AGENT); a human terminal
 *  sets none. Env-scrubbing evasion is the --no-verify class — policed
 *  in-session (GF.3), not here. Seam injectable for tests. */
export const AGENT_ENV_MARKERS = ['AI_AGENT', 'CLAUDECODE', 'CODEX_THREAD_ID'] as const;
export const isAgentInvocation = (env: NodeJS.ProcessEnv = process.env): boolean =>
  AGENT_ENV_MARKERS.some((m) => (env[m] ?? '') !== '');

function block(msg: string): number {
  process.stderr.write(`\n🦑 [opensquid gate] BLOCKED: ${msg}\n`);
  return 2;
}

/** Does the LIVE session prove a completed flow / docs-only change right now?
 *  Shared by the commit boundary (block decision) and the attest boundary (record
 *  decision) so the two can never diverge. Null = not allowed. */
/** GFR.2-hard: the CODE producer's EXTERNAL verdict text, cached under the PACK-DECLARED `auditCacheKey`
 *  (scope-4 §4a — core carries no pack-specific cache-key literal; the key comes from the active pack's evidence),
 *  or null when absent/unreadable. The text carries the findings (the UNRESOLVED bullets) the block surfaces so
 *  the agent redoes EXACTLY those (force a guided redo, not a bare refusal). */
async function readCodeAuditEntry(
  sid: string,
  auditCacheKey: string,
): Promise<{ verdict: string; subjectHash?: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(sessionStateFile(sid, auditCacheKey), 'utf8')) as {
      verdict?: unknown;
      subjectHash?: unknown;
    };
    if (typeof parsed.verdict === 'string') {
      return {
        verdict: parsed.verdict,
        ...(typeof parsed.subjectHash === 'string' ? { subjectHash: parsed.subjectHash } : {}),
      };
    }
  } catch {
    // A fresh recovery/commit process falls through to the task-durable audit cache.
  }
  try {
    return await readTaskAuditCache(sid, auditCacheKey);
  } catch {
    return null;
  }
}

async function readCodeAuditVerdict(sid: string, auditCacheKey: string): Promise<string | null> {
  return (await readCodeAuditEntry(sid, auditCacheKey))?.verdict ?? null;
}

/** GUESS_FREE iff the verdict exists AND says so. FAIL-CLOSED: absent/UNRESOLVED → false (cannot commit). */
function isGuessFree(verdict: string | null): boolean {
  return verdict?.includes('VERDICT: GUESS_FREE') ?? false;
}

/** GFR.2-hard staleness anchor: the sha256 of the diff the CODE audit certified (cached_audit `subjectHash`),
 *  or null when absent/unreadable (an audit run before the subject was recorded, or no cache). */
async function readCodeAuditSubjectHash(
  sid: string,
  auditCacheKey: string,
): Promise<string | null> {
  return (await readCodeAuditEntry(sid, auditCacheKey))?.subjectHash ?? null;
}

/** Closes the STALENESS WINDOW: a GUESS_FREE verdict only authorizes a commit if it certifies the diff being
 *  committed NOW. Re-derive `git diff HEAD` and require its sha256 to equal the audit's recorded `subjectHash`.
 *  FAIL-CLOSED: no recorded subject (a pre-anchor audit), no current diff (over-cap/empty/git error), or a
 *  mismatch (the code changed since the audit) → false → block (re-log the `audit` phase on the current diff). */
async function codeAuditCertifiesCurrentDiff(sid: string, auditCacheKey: string): Promise<boolean> {
  const recorded = await readCodeAuditSubjectHash(sid, auditCacheKey);
  if (recorded === null) return false;
  const diff = await stagedDiff(sid);
  if (diff === null) return false;
  return sha256Hex(diff) === recorded;
}

export async function commitAllowedNow(
  sid: string | null,
  files: string[],
  env: NodeJS.ProcessEnv = process.env,
  ev: CommitGateEvidence | null = null,
  pack: DisciplinePack = 'coding-flow',
): Promise<{ allowed: true; reason: 'docs_only' | 'flow_complete' | 'human' } | null> {
  // GDC.1: the gate's subject is the AGENT — a human terminal (no host marker
  // env) uses git naturally; the attestation trail still records provenance.
  if (!isAgentInvocation(env)) return { allowed: true, reason: 'human' };
  if (isDocsOnly(files)) return { allowed: true, reason: 'docs_only' };
  if (sid === null) return null;
  // scope-4 (§4): a headless ralph lap disables the AP.1 mirror, so active-task.json is absent — resolve the
  // driven item from OPENSQUID_ITEM_ID (threaded via `env`, injectable) so the gate's readActiveTask resolves.
  const active = await readActiveTask(sid, env.OPENSQUID_ITEM_ID);
  if (active === null) return null;
  const phases = await readPhaseState(sid);
  // scope-4 (§4a): the PACK-DECLARED evidence path. A pack that declares `commit_gate` evidence (v2
  // `fullstack-flow`) gates on the CODE guess-free verdict (staleness-anchored) cached under its OWN
  // `auditCacheKey` + the 7-phase ledger — core carries no pack-specific cache-key literal. A pack that declares no
  // evidence (v1 `coding-flow`, `ev === null`) keeps the session-FSM check.
  // E0: the ledger is the agent-controllable completion signal (matching v1's `phases_complete` intent);
  // gating on the FSM reaching `deploy` would over-block while the stage gates only ADVISE at PostToolUse.
  if (ev !== null) {
    // GFR.2-hard: a code commit requires the 7-phase ledger (when the pack requires it) AND the CODE producer's
    // EXTERNAL guess-free verdict AND that the verdict certifies the CURRENT diff (staleness window) — so
    // guess-free BINDS at the git boundary (PostToolUse is too late to block; the FSM gates only advise).
    // FAIL-CLOSED: an unaudited, non-GUESS_FREE, or since-changed code change cannot be committed.
    // scope-5 (§5.4) belt-and-suspenders: when the pack declares `requireSuiteGreen`, the gate ALSO independently
    // requires the DEPLOY verification-suite record (scope-1's `readSuite`, keyed by the active task) to be green —
    // so even a commit that bypassed the DEPLOY driver cannot land on a red suite. FAIL-CLOSED: an unrecorded suite
    // (null) is NOT green. The suite RECORD is the single source of truth (one writer, two readers: the DEPLOY
    // driver via deploy_evidence + this gate); core names no suite command literal (design §4a).
    const suiteOk = !ev.requireSuiteGreen || (await readSuite(sid, active.id)) === true;
    return (!ev.requirePhaseLedger || isComplete(phases, active.id)) &&
      isGuessFree(await readCodeAuditVerdict(sid, ev.auditCacheKey)) &&
      (await codeAuditCertifiesCurrentDiff(sid, ev.auditCacheKey)) &&
      suiteOk
      ? { allowed: true, reason: 'flow_complete' }
      : null;
  }
  const fsm = await readFsmStateRaw(sid, pack);
  const done = fsm === 'phases_complete' && isComplete(phases, active.id);
  return done ? { allowed: true, reason: 'flow_complete' } : null;
}

/** The commit shas a push would publish (upstream gap; single-commit fallback). */
async function outgoingShas(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP('git', ['rev-list', '@{u}..HEAD'], { cwd }).catch(() =>
      execFileP('git', ['rev-list', 'HEAD~1..HEAD'], { cwd }),
    );
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The files one commit touches. Empty on any git error (→ NOT docs-only → fail closed). */
async function commitFiles(cwd: string, sha: string): Promise<string[]> {
  try {
    // --root: a root commit has no parent — without it diff-tree prints nothing and
    // the commit would silently become unattestable.
    const { stdout } = await execFileP(
      'git',
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha],
      { cwd },
    );
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The gate decision. Returns the process exit code (0 allow, 2 block). */
export async function runGate(
  boundary: 'commit' | 'push',
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const pack = await activeDisciplinePack(cwd);
  if (pack === null) return 0; // no discipline pack pinned → never block
  // REL.3 pre-push backstop: range-validate the pushed commits' conventional-commit format (defense-in-depth
  // behind the commit-msg hook). Runs even for a docs-only push — the format check is orthogonal to the flow gate.
  if (boundary === 'push') {
    const backstop = await runPushMessageBackstop(cwd, env);
    if (backstop !== 0) return backstop;
  }
  const files = await changedFiles(boundary, cwd);
  if (files.length === 0) return 0; // nothing to gate (amend / empty / undetermined)
  if (isDocsOnly(files)) return 0; // flow artifacts only → allow

  // PGB.2 — push: accept when EVERY outgoing commit carries provenance (an attestation
  // recorded when its commit passed the commit boundary, or a docs-only diff). This is
  // what lets a fresh session push commits flow-authored in a PRIOR session without
  // weakening fail-closed: an unattested code commit still needs the live-session proof
  // below. Strictly more permissive than the session check alone, never less.
  if (boundary === 'push') {
    const scopeRoot = await resolveProjectScopeRoot(cwd);
    if (scopeRoot !== null) {
      const outgoing = await outgoingShas(cwd);
      if (outgoing.length > 0) {
        const attested = await readAttestedShas(scopeRoot);
        const covered = await Promise.all(
          outgoing.map(async (sha) => attested.has(sha) || isDocsOnly(await commitFiles(cwd, sha))),
        );
        if (covered.every(Boolean)) return 0;
      }
    }
  }

  // GDC.1 tail REORDER: commitAllowedNow decides FIRST (the human branch must
  // dominate — a human on a fresh machine has NO resolvable session and was
  // blocked by the old early sid-null check, the most natural human case);
  // the no-session block below is agent-only by construction.
  const sid = await resolveMcpSessionId();
  // scope-4 (§4a): resolve the pack-DECLARED commit-gate evidence (null for v1 `coding-flow`, which keeps the
  // session-FSM path). Core reads whatever the active pack declares — no pack-specific cache-key literal here.
  const ev = await readCommitGateEvidence(pack);
  const verdict = await commitAllowedNow(sid, files, env, ev, pack);
  if (verdict !== null) return 0;
  if (sid === null) {
    return block(
      `no resolvable opensquid session — cannot prove the SCOPE→AUTHOR→7-phase flow ran for ` +
        `this ${boundary}. Run inside an opensquid session, or pass --no-verify only with ` +
        `explicit authorization.`,
    );
  }
  const active = await readActiveTask(sid, env.OPENSQUID_ITEM_ID); // scope-4: headless-lap item fallback
  const fsm = await readFsmStateRaw(sid, pack);
  // GFR.2-hard: if the 7-phase flow IS complete, the block is the CODE guess-free audit, not the flow —
  // give the precise reason rather than the misleading "finish the flow".
  if (ev !== null && active !== null && isComplete(await readPhaseState(sid), active.id)) {
    const verdict = await readCodeAuditVerdict(sid, ev.auditCacheKey);
    // STALENESS branch: the verdict IS GUESS_FREE but it certified a DIFFERENT diff (the code changed since the
    // audit). The fix is mechanical — re-run the audit on the current diff — not a content redo, so say so.
    if (isGuessFree(verdict) && !(await codeAuditCertifiesCurrentDiff(sid, ev.auditCacheKey))) {
      return block(
        `this ${boundary} is GUESS_FREE but the audit certified a DIFFERENT diff — the code changed since the ` +
          `CODE audit ran (staleness window). Re-log the \`audit\` phase to re-run the audit on the CURRENT ` +
          `diff, then retry. (Or pass --no-verify only with explicit authorization.)`,
      );
    }
    // scope-5 (§5.4) SUITE backstop: the CODE audit IS satisfied (GUESS_FREE + certifies the current diff), but the
    // pack-declared suite requirement is not met — the repo-wide verification suite is not recorded green. Surface
    // THAT precise, mechanical reason (run the suite) rather than the audit-redo one. Core names no suite command.
    if (
      isGuessFree(verdict) &&
      ev.requireSuiteGreen &&
      (await readSuite(sid, active.id)) !== true
    ) {
      return block(
        `this ${boundary} has a GUESS_FREE, current-diff CODE audit but the project verification suite is not ` +
          `recorded green — the commit gate independently requires suite-green (belt-and-suspenders, design §5.4), ` +
          `so a commit that bypassed the DEPLOY driver still cannot land on a red suite. Run the project ` +
          `verification suite, fix any red, then retry. (\`--no-verify\` is a human-only override, never your unblock.)`,
      );
    }
    const findings =
      verdict ??
      '(no verdict yet — log/re-log the `audit` phase to run the CODE audit, then retry)';
    // Force a GUIDED redo: surface the exact findings so the agent fixes those, re-logs audit → re-audit →
    // loop until GUESS_FREE (the self-continue pattern), rather than a bare refusal.
    return block(
      `this ${boundary} has code changes but the CODE guess-free audit is not VERDICT: GUESS_FREE — the ` +
        `procedure is NOT complete (this is information, not a wall to route around). REDO the flagged work ` +
        `properly, then re-log the \`audit\` phase to re-run the audit ON THE ARTIFACT — repeat until GUESS_FREE. ` +
        `Re-logging \`audit\` WITHOUT fixing the work just re-surfaces these findings; \`--no-verify\` is a ` +
        `human-only override, never your unblock.\n\nCODE audit findings:\n${findings}`,
    );
  }
  return block(
    `this ${boundary} has code changes but the active task has not completed the ` +
      `SCOPE→AUTHOR→7-phase flow (FSM=${fsm ?? 'none'}, active task=${active?.id ?? 'none'}). ` +
      `GENUINELY complete each of the 7 phases, THEN log it — the content-audit re-derives each from the ` +
      `artifact, so a phase logged-but-not-done fails the audit, it does not pass the gate. \`--no-verify\` is a ` +
      `human-only override, never your unblock.`,
  );
}

/** HEAD's sha, or null when it cannot be resolved (unborn branch, not a repo). */
async function headSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** PGB.2 — the attest boundary (post-commit hook + `opensquid gate attest` CLI):
 *  record provenance for HEAD when the live session can prove it RIGHT NOW. Never
 *  blocks, never throws — recording is best-effort; an unattested commit simply
 *  falls back to the session check at push time (fail-closed preserved). */
export async function runAttest(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const pack = await activeDisciplinePack(cwd);
    if (pack === null) return 0;
    const scopeRoot = await resolveProjectScopeRoot(cwd);
    const sha = await headSha(cwd);
    if (scopeRoot === null || sha === null) return 0;
    const files = await commitFiles(cwd, sha);
    if (files.length === 0) return 0; // empty/merge/undetermined → nothing to attest
    const sid = await resolveMcpSessionId();
    const ev = await readCommitGateEvidence(pack);
    const verdict = await commitAllowedNow(sid, files, env, ev, pack);
    if (verdict !== null) {
      await appendAttestation(scopeRoot, {
        sha,
        ...verdict,
        session: sid ?? 'none',
        at: new Date().toISOString(),
      });
    }
    return 0;
  } catch {
    return 0; // best-effort contract: attest never breaks a commit
  }
}

/** REL.3 (T-opensquid-release-flow) — the conventional-commit format gate. Fail-CLOSED but SCOPED exactly like
 *  `commitAllowedNow`: a NON-gated repo or a HUMAN invocation ALWAYS passes (0) — a human's natural commit is never
 *  format-blocked (the GDC.1 subject-is-the-agent invariant). A non-parsing message in a gated AGENT commit blocks
 *  (2), because auto-versioning (REL.2's `bumpLevel`) needs the message to parse. git's comment lines (`#`) and the
 *  `--verbose`/`commit.status` scissors diff are stripped — only the subject is validated. */
export async function runCommitMsgGate(
  msgfile: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!(await isGatedRepo(cwd))) return 0;
  if (!isAgentInvocation(env)) return 0; // humans commit naturally (GDC.1)
  const raw = await readFile(msgfile, 'utf8').catch(() => '');
  const message = raw
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();
  if (message === '') return 0; // empty message → git aborts the commit itself; nothing to gate
  if (validateConventionalMessage(message)) return 0;
  return block(
    `commit message is not a conventional commit (type(scope): subject). Auto-versioning needs it. ` +
      `Got: ${message.split('\n')[0]}`,
  );
}

/** REL.3 pre-push backstop (defense-in-depth behind the commit-msg hook): range-validate the pushed commits'
 *  subjects (`@{u}..HEAD`), blocking a push that carries a non-conventional commit. SCOPED to gated agent pushes;
 *  tolerant of a missing upstream (a brand-new branch → can't range → don't block). Merge commits (`Merge …`) are
 *  skipped — they never run commit-msg and are not release-classified by `bumpLevel`. NOT retro-validation: the
 *  range is the delta being pushed, not the branch's whole history. Returns 0 (allow) or 2 (block). */
async function runPushMessageBackstop(cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  if (!isAgentInvocation(env)) return 0; // humans push naturally (GDC.1)
  let subjects: string[];
  try {
    subjects = await commitSubjectsSince('@{u}', cwd); // throws when there is no upstream → tolerated below
  } catch {
    return 0; // no resolvable range (new branch / detached) → nothing to backstop
  }
  const offending = subjects.find(
    (s) => !s.startsWith('Merge ') && !validateConventionalMessage(s),
  );
  if (offending === undefined) return 0;
  return block(
    `pre-push backstop: a pushed commit's message is not a conventional commit (auto-versioning needs it). ` +
      `Got: ${offending}`,
  );
}

/** Resolve and verify the serial DEPLOY branch from the existing environment SSOT. Null means unconfigured,
 * detached, or the checkout disagrees with the configured local branch — every case fails closed at DEPLOY. */
export async function configuredLocalBranch(cwd: string): Promise<string | null> {
  const scopeRoot = await resolveProjectScopeRoot(cwd);
  if (scopeRoot === null) return null;
  const env = await resolveEnvironments(scopeRoot);
  if (env === null) return null;
  try {
    const { stdout } = await execFileP('git', ['branch', '--show-current'], { cwd });
    const current = stdout.trim();
    return current !== '' && current === env.local ? current : null;
  } catch {
    return null;
  }
}

/** Resolve the git work-tree root for `cwd`, or null if not in a repo. */
export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function registerGate(program: Command): void {
  const gate = program
    .command('gate')
    .description('Owned-boundary workflow gate invoked by the git pre-commit / pre-push hooks');
  gate
    .command('commit')
    .description('pre-commit: block a code commit that has not completed the coding-flow')
    .action(async () => {
      process.exit(await runGate('commit', process.cwd()));
    });
  gate
    .command('push')
    .description('pre-push: block a push whose commits have not completed the coding-flow')
    .action(async () => {
      process.exit(await runGate('push', process.cwd()));
    });
  gate
    .command('branch')
    .description('print the verified configured semantic local branch for serial DEPLOY')
    .action(async () => {
      const branch = await configuredLocalBranch(process.cwd());
      if (branch === null) {
        process.stderr.write(
          'opensquid gate branch: checkout does not match version-control.environments.local\n',
        );
        process.exit(1);
      }
      process.stdout.write(`${branch}\n`);
    });
  gate
    .command('attest')
    .description(
      'post-commit: record flow provenance for HEAD (also run manually after amend/rebase)',
    )
    .action(async () => {
      process.exit(await runAttest(process.cwd()));
    });
  // REL.3 — commit-msg: block a commit whose message is not a conventional commit (auto-versioning input).
  gate
    .command('commit-msg')
    .description(
      'commit-msg: block a commit whose message is not a conventional commit (auto-versioning input)',
    )
    .argument('<msgfile>', 'path to the git COMMIT_EDITMSG file (git passes it as $1)')
    .action(async (msgfile: string) => {
      process.exit(await runCommitMsgGate(msgfile, process.cwd()));
    });
  // scope-4 (§2.4): the LAP-RUNNABLE CODE audit-on-diff — regenerate the exact artifact the commit gate checks,
  // so an honest headless lap (hooks disabled) clears the gate without gate-gaming.
  registerReaudit(gate);
  gate
    .command('install')
    .description('install the opensquid pre-commit + pre-push hooks into the current git repo')
    .action(async () => {
      const { installGitHooks } = await import('../wizard/git-hooks.js');
      const root = await gitRoot(process.cwd());
      if (root === null) {
        process.stderr.write('opensquid gate install: not inside a git work tree\n');
        process.exit(1);
      }
      const res = await installGitHooks(root);
      for (const h of res) process.stdout.write(`[${h.state}] ${h.name}\n`);
    });
}
