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

import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { OPENSQUID_HOME, resolveProjectScopeRoot, sessionStateFile } from '../../runtime/paths.js';
import { PROTECTED_PREFIXES, isDocsOnly } from '../../runtime/protected_paths.js';
import { readFsmStateRaw } from '../../runtime/fsm_state.js';
import { readActiveTask } from '../../runtime/session_state.js';
import { isComplete, readPhaseState } from '../../runtime/workflow_phases.js';

import { appendAttestation, readAttestedShas } from './attestations.js';

const execFileP = promisify(execFile);
/** E0 (docs/design/v2-enforcement-implementation.md §0): the discipline packs whose presence
 *  in active.json ARMS the commit gate. Before E0 this was the literal constant `'coding-flow'`,
 *  so pinning v2 (`fullstack-flow`) made `isGatedRepo` return false and silently DISABLED the gate. */
const DISCIPLINE_PACKS = ['coding-flow', 'fullstack-flow'] as const;
type DisciplinePack = (typeof DISCIPLINE_PACKS)[number];

/** The active discipline pack (user scope then project scope), or null if none is pinned. */
export async function activeDisciplinePack(cwd: string): Promise<DisciplinePack | null> {
  const candidates: string[] = [join(OPENSQUID_HOME(), 'active.json')];
  const scopeRoot = await resolveProjectScopeRoot(cwd);
  if (scopeRoot !== null) candidates.push(join(scopeRoot, 'active.json'));
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { packs?: unknown };
      const packs = Array.isArray(parsed.packs) ? parsed.packs : [];
      const hit = DISCIPLINE_PACKS.find((p) => packs.includes(p));
      if (hit !== undefined) return hit;
    } catch {
      /* absent/malformed scope → not active here */
    }
  }
  return null;
}

/** GDC.2 — is this invocation gated? The gate binds to the AGENT, not to a
 *  location (user directive 2026-06-11: "all agents in any harness; git on
 *  the terminal behaves normally"): `coding-flow` in the USER scope
 *  (~/.opensquid/active.json — the agent's own config) gates the agent in
 *  EVERY repo; a project-scope opt-in still works too (e.g. a team gating
 *  one repo for all agents). Humans pass upstream regardless
 *  (isAgentInvocation, GDC.1). */
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
/** GFR.2-hard: the fullstack-flow CODE producer's EXTERNAL verdict (`fullstack-flow-code-audit-cache`) must be
 *  `VERDICT: GUESS_FREE` for a code commit. Reads the flat `{verdict}` cache; absent / non-GUESS_FREE / any
 *  read error → false (FAIL-CLOSED — an unaudited or guessed code change cannot be committed). */
async function codeAuditGuessFree(sid: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await readFile(sessionStateFile(sid, 'fullstack-flow-code-audit-cache'), 'utf8'),
    ) as { verdict?: unknown };
    return typeof parsed.verdict === 'string' && parsed.verdict.includes('VERDICT: GUESS_FREE');
  } catch {
    return false;
  }
}

export async function commitAllowedNow(
  sid: string | null,
  files: string[],
  env: NodeJS.ProcessEnv = process.env,
  pack: DisciplinePack = 'coding-flow',
): Promise<{ allowed: true; reason: 'docs_only' | 'flow_complete' | 'human' } | null> {
  // GDC.1: the gate's subject is the AGENT — a human terminal (no host marker
  // env) uses git naturally; the attestation trail still records provenance.
  if (!isAgentInvocation(env)) return { allowed: true, reason: 'human' };
  if (isDocsOnly(files)) return { allowed: true, reason: 'docs_only' };
  if (sid === null) return null;
  const active = await readActiveTask(sid);
  if (active === null) return null;
  const phases = await readPhaseState(sid);
  // E0: v2 `fullstack-flow` gates on the 7-phase LEDGER for the active task — the
  // agent-controllable completion signal (matching v1's `phases_complete` intent).
  // Gating on the FSM reaching `deploy` would over-block while the stage gates only
  // ADVISE at PostToolUse (that tightening is E1/E4). v1 keeps the session-FSM check.
  if (pack === 'fullstack-flow') {
    // GFR.2-hard: a code commit requires BOTH the 7-phase ledger AND the CODE producer's EXTERNAL guess-free
    // verdict — so guess-free BINDS at the git boundary (PostToolUse is too late to block; the FSM gates only
    // advise). FAIL-CLOSED: an unaudited or non-GUESS_FREE code change cannot be committed.
    return isComplete(phases, active.id) && (await codeAuditGuessFree(sid))
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
  const verdict = await commitAllowedNow(sid, files, env, pack);
  if (verdict !== null) return 0;
  if (sid === null) {
    return block(
      `no resolvable opensquid session — cannot prove the SCOPE→AUTHOR→7-phase flow ran for ` +
        `this ${boundary}. Run inside an opensquid session, or pass --no-verify only with ` +
        `explicit authorization.`,
    );
  }
  const active = await readActiveTask(sid);
  const fsm = await readFsmStateRaw(sid, pack);
  // GFR.2-hard: if the 7-phase flow IS complete, the block is the CODE guess-free audit, not the flow —
  // give the precise reason rather than the misleading "finish the flow".
  if (pack === 'fullstack-flow' && active !== null && isComplete(await readPhaseState(sid), active.id)) {
    return block(
      `this ${boundary} has code changes but the CODE guess-free audit is not VERDICT: GUESS_FREE ` +
        `(fullstack-flow-code-audit-cache). The external code audit must pass before commit — resolve its ` +
        `findings and let it re-run (re-log the audit phase), or pass --no-verify only with explicit authorization.`,
    );
  }
  return block(
    `this ${boundary} has code changes but the active task has not completed the ` +
      `SCOPE→AUTHOR→7-phase flow (FSM=${fsm ?? 'none'}, active task=${active?.id ?? 'none'}). ` +
      `Finish the flow (log all 7 phases), or pass --no-verify only with explicit authorization.`,
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
    const verdict = await commitAllowedNow(sid, files, env, pack);
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
    .command('attest')
    .description(
      'post-commit: record flow provenance for HEAD (also run manually after amend/rebase)',
    )
    .action(async () => {
      process.exit(await runAttest(process.cwd()));
    });
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
