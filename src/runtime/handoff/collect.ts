/**
 * T-AUTO-HANDOFF — deterministic state collection (the dump IS the handoff).
 *
 * Reads EVERY resumable-state source for a session from DISK (user-locked:
 * "hand-off needs all the information"; generators read disk state, never a
 * session's narrative — the 2026-06-10 "v4 on disk" false-claim precedent).
 * Every probe is bounded: a missing/corrupt source renders as an
 * `<unreadable: …>` marker instead of aborting — totality over completeness.
 *
 * Imports from: node:crypto, node:fs/promises, node:child_process,
 *   ../paths.js, ../session_state.js, ../phase_ledger.js,
 *   ../../channels/routing.js, ../../workgraph/store.js.
 * Imported by: handoff/index.ts, handoff/render.ts (types).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { loadChannelsConfig } from '../../channels/routing.js';
import { workGraphStore } from '../../workgraph/store.js';
import { readPhaseLedger } from '../phase_ledger.js';
import {
  OPENSQUID_HOME,
  resolveProjectScopeRoot,
  sessionLogFile,
  sessionStateFile,
} from '../paths.js';
import { type ActiveTask, readActiveTask } from '../session_state.js';

const execFileP = promisify(execFile);

export interface HandoffArtifact {
  kind: 'pre_research' | 'spec';
  path: string;
  sha8: string | null;
}

export interface HandoffGitRepo {
  repo: string;
  statusShort: string;
  unpushed: string;
}

export interface HandoffState {
  sessionId: string;
  generatedAt: string;
  cwd: string;
  umbrellaRoot: string;
  fsm: Record<string, unknown> | string;
  activeTask: ActiveTask | null | string;
  phaseSet: Record<string, unknown> | string;
  phaseLedger: { phase: string; note: string }[] | string;
  guessAuditHead: string;
  specAuditHead: string;
  spawnLedgerTail: string[];
  attestationsTail: string[];
  artifacts: HandoffArtifact[];
  git: HandoffGitRepo[];
  openIssues: { id: string; title: string }[] | string;
}

async function bounded<T>(probe: () => Promise<T>): Promise<T | string> {
  try {
    return await probe();
  } catch (e) {
    return `<unreadable: ${e instanceof Error ? e.message : String(e)}>`;
  }
}

async function readJsonState(
  sessionId: string,
  key: string,
): Promise<Record<string, unknown> | string> {
  return bounded(
    async () =>
      JSON.parse(await readFile(sessionStateFile(sessionId, key), 'utf8')) as Record<
        string,
        unknown
      >,
  );
}

/** First N chars of a cached audit verdict (or an absent/unreadable marker). */
async function auditHead(sessionId: string, key: string, n = 600): Promise<string> {
  const parsed = await readJsonState(sessionId, key);
  if (typeof parsed === 'string') return parsed; // <unreadable: …>
  const verdict = (parsed as { verdict?: unknown }).verdict;
  return typeof verdict === 'string' ? verdict.slice(0, n) : '<no verdict field>';
}

async function tailLines(path: string, n: number): Promise<string[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.trim().split('\n').slice(-n);
  } catch {
    return [];
  }
}

/** A tracked artifact path + its content hash (null when unreadable — the
 *  successor then knows the artifact is NOT on disk, the 87ccd846 lesson). */
async function artifactOf(
  sessionId: string,
  key: string,
  kind: HandoffArtifact['kind'],
): Promise<HandoffArtifact | null> {
  const parsed = await readJsonState(sessionId, key);
  if (typeof parsed !== 'string' && typeof parsed === 'object' && parsed !== null) {
    // state files store the bare path as a JSON string; readJsonState parses it
  }
  const path = typeof parsed === 'string' && !parsed.startsWith('<unreadable') ? parsed : null;
  const fromJson = typeof parsed === 'string' ? null : parsed;
  const p = path ?? (typeof fromJson === 'string' ? fromJson : null);
  // A blank/whitespace path (e.g. a key cleared on the scope_start re-arm,
  // wg-4c48ef1b9969) is semantically "no artifact" — NOT a broken one.
  if (p === null || p.trim() === '') return null;
  try {
    const sha8 = createHash('sha256')
      .update(await readFile(p, 'utf8'))
      .digest('hex')
      .slice(0, 8);
    return { kind, path: p, sha8 };
  } catch {
    return { kind, path: p, sha8: null };
  }
}

/** The umbrella ROOT for a cwd: pick the umbrella ROW by longest member
 *  prefix (correct row when rows nest), then return that row's SHORTEST
 *  member containing the cwd — the umbrella root, not the sub-repo (live
 *  spike finding: loop lists both `…/loop` and `…/loop/opensquid` as
 *  members; docs + MEMORY.md belong at the loop root). Falls back to cwd. */
export async function umbrellaRootFor(cwd: string): Promise<string> {
  try {
    const cfg = await loadChannelsConfig();
    if (cfg !== null) {
      let bestRow: { members: string[] } | null = null;
      let bestLen = -1;
      for (const u of cfg.umbrellas) {
        for (const m of u.members) {
          if ((cwd === m || cwd.startsWith(`${m}/`)) && m.length > bestLen) {
            bestRow = u;
            bestLen = m.length;
          }
        }
      }
      if (bestRow !== null) {
        let root: string | null = null;
        for (const m of bestRow.members) {
          if ((cwd === m || cwd.startsWith(`${m}/`)) && (root === null || m.length < root.length)) {
            root = m;
          }
        }
        if (root !== null) return root;
      }
    }
  } catch {
    /* fall through */
  }
  return cwd;
}

async function gitRepo(dir: string): Promise<HandoffGitRepo | null> {
  try {
    const { stdout: status } = await execFileP('git', ['status', '--short'], {
      cwd: dir,
      timeout: 10_000,
    });
    let unpushed = '';
    try {
      const { stdout } = await execFileP('git', ['log', '--oneline', '@{u}..'], {
        cwd: dir,
        timeout: 10_000,
      });
      unpushed = stdout.trim();
    } catch {
      unpushed = '<no upstream>';
    }
    return { repo: dir, statusShort: status.trimEnd(), unpushed };
  } catch {
    return null; // not a git repo / git unavailable — skip silently
  }
}

export async function collectHandoffState(sessionId: string, cwd: string): Promise<HandoffState> {
  const umbrellaRoot = await umbrellaRootFor(cwd);

  const activeRaw = await bounded(async () => readActiveTask(sessionId));
  const activeTask = activeRaw;
  const taskId =
    activeTask !== null && typeof activeTask === 'object' ? (activeTask.taskId ?? null) : null;

  const phaseLedger: HandoffState['phaseLedger'] =
    taskId === null
      ? '<no active task>'
      : await bounded(async () => {
          const ledger = await readPhaseLedger(taskId);
          return ledger.entries.map((e) => ({
            phase: e.phase,
            note: typeof e.note === 'string' ? e.note : '',
          }));
        });

  const artifacts = (
    await Promise.all([
      artifactOf(sessionId, 'coding-flow-pre-research-path', 'pre_research'),
      artifactOf(sessionId, 'coding-flow-spec-path', 'spec'),
    ])
  ).filter((a): a is HandoffArtifact => a !== null);

  // Git sweep: umbrella members (when channels.json names them) else just cwd.
  const memberDirs = new Set<string>([umbrellaRoot]);
  try {
    const cfg = await loadChannelsConfig();
    for (const u of cfg?.umbrellas ?? []) {
      for (const m of u.members) {
        if (m === umbrellaRoot || m.startsWith(`${umbrellaRoot}/`)) memberDirs.add(m);
      }
    }
  } catch {
    /* cwd-only sweep */
  }
  // Known sub-repos: direct children of the umbrella root that are git repos
  // are NOT auto-discovered (bounded sweep) — members + root only.
  const git = (await Promise.all([...memberDirs].map(gitRepo))).filter(
    (g): g is HandoffGitRepo => g !== null,
  );

  const scopeRoot = await resolveProjectScopeRoot(cwd);
  const attestationsTail =
    scopeRoot === null ? [] : await tailLines(join(scopeRoot, 'attestations.jsonl'), 5);

  const openIssues = await bounded(async () => {
    const store = workGraphStore({
      dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
      sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
    });
    await store.init();
    const issues = await store.listIssues();
    return issues.filter((i) => i.status !== 'closed').map((i) => ({ id: i.id, title: i.title }));
  });

  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    cwd,
    umbrellaRoot,
    fsm: await readJsonState(sessionId, 'fsm-coding-flow'),
    activeTask,
    phaseSet: await readJsonState(sessionId, 'workflow.phases_logged'),
    phaseLedger,
    guessAuditHead: await auditHead(sessionId, 'coding-flow-guess-audit-cache'),
    specAuditHead: await auditHead(sessionId, 'coding-flow-spec-audit-cache'),
    spawnLedgerTail: await tailLines(sessionLogFile(sessionId, 'audit-spawn-ledger'), 5),
    attestationsTail,
    artifacts,
    git,
    openIssues,
  };
}

/** Stable doc path for a session's handover — keyed on sid ONLY (AHO.3:
 *  date-keying minted a second doc for the same session across midnight and
 *  broke the tier-3 staleness probe; generatedAt rides inside the doc). */
export function handoverDocPath(umbrellaRoot: string, sessionId: string): string {
  return join(umbrellaRoot, 'docs', `handover-session-${sessionId.slice(0, 8)}-auto.md`);
}

/** Re-export for callers building ids/labels. */
export function shortSid(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export { basename as _basename };
