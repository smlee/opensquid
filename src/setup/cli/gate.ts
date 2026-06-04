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
import { resolveProjectScopeRoot } from '../../runtime/paths.js';
import { readFsmStateRaw } from '../../runtime/fsm_state.js';
import { readActiveTask } from '../../runtime/session_state.js';
import { isComplete, readPhaseState } from '../../runtime/workflow_phases.js';

const execFileP = promisify(execFile);
const GATED_PACK = 'coding-flow';

/** Is `cwd` inside a project whose `.opensquid/active.json` opts into the coding-flow gate? */
export async function isGatedRepo(cwd: string): Promise<boolean> {
  const scopeRoot = await resolveProjectScopeRoot(cwd);
  if (scopeRoot === null) return false;
  try {
    const raw = await readFile(join(scopeRoot, 'active.json'), 'utf8');
    const parsed = JSON.parse(raw) as { packs?: unknown };
    return Array.isArray(parsed.packs) && parsed.packs.includes(GATED_PACK);
  } catch {
    return false;
  }
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

/** A change touching ONLY `docs/` is a flow ARTIFACT (pre-research / spec / changelog) —
 *  the flow's own intermediate output, never the code the flow protects. Allowed. */
const isDocsOnly = (files: string[]): boolean =>
  files.length > 0 && files.every((f) => f.startsWith('docs/'));

function block(msg: string): number {
  process.stderr.write(`\n🦑 [opensquid gate] BLOCKED: ${msg}\n`);
  return 2;
}

/** The gate decision. Returns the process exit code (0 allow, 2 block). */
export async function runGate(boundary: 'commit' | 'push', cwd: string): Promise<number> {
  if (!(await isGatedRepo(cwd))) return 0; // unrelated repo → never block
  const files = await changedFiles(boundary, cwd);
  if (files.length === 0) return 0; // nothing to gate (amend / empty / undetermined)
  if (isDocsOnly(files)) return 0; // flow artifacts only → allow

  const sid = await resolveMcpSessionId();
  if (sid === null) {
    return block(
      `no resolvable opensquid session — cannot prove the SCOPE→AUTHOR→7-phase flow ran for ` +
        `this ${boundary}. Run inside an opensquid session, or pass --no-verify only with ` +
        `explicit authorization.`,
    );
  }
  const active = await readActiveTask(sid);
  const fsm = await readFsmStateRaw(sid, GATED_PACK);
  const phases = await readPhaseState(sid);
  const done = active !== null && fsm === 'phases_complete' && isComplete(phases, active.id);
  if (done) return 0;
  return block(
    `this ${boundary} has code changes but the active task has not completed the ` +
      `SCOPE→AUTHOR→7-phase flow (FSM=${fsm ?? 'none'}, active task=${active?.id ?? 'none'}). ` +
      `Finish the flow (log all 7 phases), or pass --no-verify only with explicit authorization.`,
  );
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
