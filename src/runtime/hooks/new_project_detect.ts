/**
 * T-CTX-LOOP CTX.4 (2026-05-29) — new-project detector.
 *
 * Fires inline at user-prompt-submit. Once per session — controlled by a
 * marker file at `~/.opensquid/sessions/<sid>/.new-project-checked`. When
 * the session's recorded cwd does NOT resolve to a known
 * `~/.claude/projects/<encoded-cwd>/memory/` directory (Claude Code's
 * per-project memory home), this module emits a one-paragraph
 * additionalContext line proposing the agent surface the new project +
 * route through CTX.0's verify-probe-gated `memorize` for global
 * `~/.claude/CLAUDE.md` mind-map update.
 *
 * Per `[[project-opensquid-interconnected-communication-loop]]`: the
 * cold-start LOAD position depends on the global mind-map's projects-index
 * being current; CTX.4 closes the new-project edge case.
 *
 * Imports from: node:fs/promises, node:os, node:path, ../session_state.js.
 * Imported by: src/runtime/hooks/user-prompt-submit.ts;
 *   src/runtime/hooks/new_project_detect.test.ts.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';
import { readSessionCwd } from '../session_state.js';

/** Mirror of memory_reconcile.ts:encodeProjectPath — inlined to avoid a
 *  cross-hook import that would pull memory_reconcile's engine deps. */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

/** Per-session once-marker path. */
function markerPath(sessionId: string): string {
  return join(OPENSQUID_HOME(), 'sessions', sessionId, '.new-project-checked');
}

export interface NewProjectDetectDeps {
  /** Defaults to `~/.claude/projects`. Test seam. */
  claudeProjectsRoot?: string;
  /** Defaults to `readSessionCwd`. Test seam. */
  readCwd?: (sessionId: string) => Promise<string | null>;
}

/**
 * Returns the additionalContext line to inject when a new project is
 * detected for THIS session — or `null` when (a) the once-marker exists,
 * (b) the cwd is unknown, or (c) the project's memory dir already exists.
 * Always writes the once-marker before returning (so a follow-up call in
 * the same session no-ops, regardless of outcome).
 */
export async function detectNewProject(
  sessionId: string,
  deps: NewProjectDetectDeps = {},
): Promise<string | null> {
  const marker = markerPath(sessionId);
  // Once-marker gate — best-effort read; absent → proceed.
  try {
    await stat(marker);
    return null;
  } catch {
    // ENOENT → first check this session
  }

  const cwd = await (deps.readCwd ?? readSessionCwd)(sessionId);
  // Cwd not yet recorded (no tool calls before this prompt) — write marker
  // anyway so we don't re-check every prompt; on next session the check fires
  // fresh.
  if (cwd === null) {
    await writeMarker(marker);
    return null;
  }

  const root = deps.claudeProjectsRoot ?? join(homedir(), '.claude', 'projects');
  const projectMemoryDir = join(root, encodeProjectPath(cwd), 'memory');

  let projectExists: boolean;
  try {
    await stat(projectMemoryDir);
    projectExists = true;
  } catch {
    projectExists = false;
  }

  await writeMarker(marker);

  if (projectExists) return null;

  // Compose the additionalContext line. Verbatim verify is the agent's
  // job — the proposal text routes the user through CTX.0's gate.
  return (
    `[opensquid CTX.4 — new project detected]\n` +
    `cwd: ${cwd}\n` +
    `No memory dir at ${projectMemoryDir} — Claude Code hasn't seen this project before.\n` +
    `Propose adding to the global mind-map (\`~/.claude/CLAUDE.md\`): ` +
    `path + 1-line purpose + relationships to known projects. ` +
    `Route the write through \`mcp__opensquid__memorize\` (verify-probe-gated; user must confirm verbatim).`
  );
}

async function writeMarker(path: string): Promise<void> {
  try {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '', 'utf8');
  } catch {
    // marker write is best-effort; a write failure means the next prompt
    // will re-check — not a correctness problem, just a slightly noisier
    // session if the underlying issue persists.
  }
}
