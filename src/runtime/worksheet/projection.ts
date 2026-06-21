/**
 * Worksheet LOG projection (T-scope-worksheet / wg-7d649d90f26a) — the SINGLE store-querying
 * owner. Computes each scope's `complete` + `commits` from the work-graph + 7-phase ledger + git,
 * NEVER stored (the log half is rebuilt on demand → can't drift). Consumed by
 * `birth_or_repoint_worksheet`'s in-flight-batch check AND the renderer.
 *
 * Completion is SPLIT by what the scope can resolve:
 *   - batch scope (carries `issue`)            → that work-graph issue is `closed`.
 *   - auto-born single scope (no `issue`)       → the ACTIVE track's 7-phase ledger is complete,
 *     but ONLY when projecting the active track's own worksheet (`wsPath === active worksheet-path`);
 *     for an arbitrary PAST single worksheet it falls back to a best-effort "has commits" signal
 *     (the live ledger belongs to the now-current track, not the past one).
 *
 * Imports from: node:child_process, node:util, node:path, ../paths.js, ../session_state.js,
 *   ../phase_ledger.js, ../../workgraph/store.js, ../../packs/schemas/worksheet.js.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Worksheet } from '../../packs/schemas/worksheet.js';
import { workGraphStore } from '../../workgraph/store.js';
import { OPENSQUID_HOME } from '../paths.js';
import { readPhaseLedger } from '../phase_ledger.js';
import { readActiveTask, readSessionStateValue } from '../session_state.js';

const execFileP = promisify(execFile);

/** The canonical 7 phase identifiers (the `log_phase` enum) — single-mode completion needs all of them. */
const PHASES = ['pre_research', 'learn', 'code', 'test', 'audit', 'post_research', 'fix'] as const;

export interface ScopeProjection {
  id: string;
  issue?: string | undefined;
  complete: boolean;
  commits: string[];
}

function store(): ReturnType<typeof workGraphStore> {
  return workGraphStore({
    dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
    sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
  });
}

async function commitsFor(scopeId: string): Promise<string[]> {
  return execFileP('git', ['log', '--grep', scopeId, '--oneline'])
    .then((r) => r.stdout.trim().split('\n').filter(Boolean))
    .catch(() => []);
}

/**
 * Project each scope's live status. `wsPath` is the worksheet's own path — used to decide whether the
 * single-mode active-ledger signal applies (only when it IS the active track's worksheet).
 */
export async function projectScopes(
  ws: Worksheet,
  sessionId: string,
  wsPath: string,
): Promise<ScopeProjection[]> {
  const wg = store();
  await wg.init(); // every workGraphStore caller must init before querying (createSchema + hwm)
  const activePath = (await readSessionStateValue(sessionId, 'coding-flow-worksheet-path').catch(
    () => null,
  )) as string | null;
  const active =
    ws.mode === 'single' && wsPath === activePath
      ? await readActiveTask(sessionId).catch(() => null)
      : null;

  return Promise.all(
    ws.scopes.map(async (s) => {
      const commits = await commitsFor(s.id);
      let complete = false;
      if (s.issue) {
        complete = (await wg.getIssue(s.issue).catch(() => null))?.status === 'closed'; // batch scope
      } else if (active) {
        const led = await readPhaseLedger(active.taskId ?? active.id).catch(() => null); // active single track
        const logged = new Set(led?.phases_logged ?? []);
        complete = PHASES.every((p) => logged.has(p));
      } else {
        complete = commits.length > 0; // past single worksheet: best-effort historical signal
      }
      return { id: s.id, issue: s.issue, complete, commits };
    }),
  );
}
