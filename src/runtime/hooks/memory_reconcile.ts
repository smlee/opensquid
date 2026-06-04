/**
 * MAU.3 — session-boundary memory reconcile.
 *
 * Flushes a project's authored auto-memories into the long-term RAG at session
 * end (import + refresh; NO delete — the no-auto-delete axiom
 * [[memory-architecture-dual-surface-sync]]). The SessionEnd hook carries no
 * cwd, so the dir is resolved from the cwd that PreToolUse recorded per session
 * (`readSessionCwd`). Extracted from the hook bin so it's unit-testable with
 * injected deps (the bin file runs `main()` on import).
 *
 * Failure policy: FAIL-LOUD (a silent reconcile failure is the exact drift this
 * track prevents — surface it on stderr) but NEVER throw / block session end
 * (hook fail-open contract). Engine-down → loud stderr, return cleanly.
 *
 * Imports from: node:fs/promises, node:os, node:path, ../../engine/client.js,
 *   ../../setup/migrate/auto_memory_snapshot.js, ../paths.js, ../session_state.js.
 * Imported by: src/runtime/hooks/session-end.ts; memory_reconcile.test.ts.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EngineClient } from '../../engine/client.js';
import { computeMemoryDrift, renderMemoryDrift } from '../../setup/migrate/memory_drift.js';
import { snapshotAuto } from '../../setup/migrate/auto_memory_snapshot.js';
import { OPENSQUID_HOME } from '../paths.js';
import { readSessionCwd } from '../session_state.js';

/**
 * Encode a project path the way Claude Code names the auto-memory dir: every
 * `/` → `-`. Mirrors `encodeProjectPath` in `src/setup/cli/memory.ts`; inlined
 * (one line) so this module doesn't pull commander into the hook bundle.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

export interface ReconcileDeps {
  /** Defaults to `readSessionCwd` (per-session cwd recorded by PreToolUse). */
  readCwd?: (sessionId: string) => Promise<string | null>;
  /** Defaults to `~/.claude/projects`. */
  autoMemoryRoot?: string;
  /** Defaults to a real `EngineClient`. */
  engineFactory?: () => EngineClient;
  /** Defaults to `OPENSQUID_HOME()`. */
  opensquidHome?: () => string;
  /** Defaults to `process.stderr.write`. */
  stderr?: (s: string) => void;
}

export async function reconcileMemoryOnSessionEnd(
  sessionId: string,
  deps: ReconcileDeps = {},
): Promise<void> {
  const readCwd = deps.readCwd ?? readSessionCwd;
  const root = deps.autoMemoryRoot ?? join(homedir(), '.claude', 'projects');
  const engineFactory = deps.engineFactory ?? ((): EngineClient => new EngineClient());
  const home = deps.opensquidHome ?? OPENSQUID_HOME;
  const err = deps.stderr ?? ((s: string): void => void process.stderr.write(s));
  try {
    const cwd = await readCwd(sessionId);
    if (cwd === null) return; // no tool calls this session → nothing to resolve
    const autoMemDir = join(root, encodeProjectPath(cwd), 'memory');
    try {
      await stat(autoMemDir);
    } catch {
      return; // this project has no auto-memory dir → nothing to sync
    }
    const engine = engineFactory();
    try {
      const r = await snapshotAuto(autoMemDir, home(), engine);
      err(
        `opensquid: memory reconcile — imported ${String(r.imported)}, refreshed ${String(r.refreshed)}, skipped ${String(r.skipped)}, errors ${String(r.errors.length)}\n`,
      );
      // MF.1 (H1): the design's "loudly self-auditing" promise — a NON-empty drift AFTER
      // reconcile means the sync did not converge (a real bug), so surface it LOUDLY. This
      // is the automatic surface the original silent-drift failure lacked (the on-command
      // `doctor memory` check was the only one). Runs before the `finally` close (engine
      // still open); a throw here is caught by the outer catch → loud FAILED, never blocks.
      const drift = await computeMemoryDrift(autoMemDir, engine);
      if (!drift.inSync) {
        err(`opensquid: ${renderMemoryDrift(drift)} — post-reconcile drift (expected in-sync)\n`);
      }
    } finally {
      await engine.close();
    }
  } catch (e) {
    // FAIL-LOUD, never block session end.
    err(`opensquid: memory reconcile FAILED (engine down?) — ${String(e)}\n`);
  }
}
