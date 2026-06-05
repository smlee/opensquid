/**
 * check_flow_health (T-FLOW-UNSKIPPABLE FU.3 / D3) — SessionStart health assurance.
 *
 * The flow-enforcement gates only fire when (a) the opensquid hooks are actually
 * wired in `~/.claude/settings.json` and (b) a gate pack (one with an FSM, e.g.
 * `coding-flow`) is active for this umbrella. A session that started before the
 * hooks were installed, or in an umbrella with no gate pack, runs FULLY UN-GATED
 * with no signal — the F3 failure mode (a session predating the install calls NONE
 * of the hooks). This primitive, dispatched on `session_start`, READS that state
 * and returns a LOUD `inject_context` directive when enforcement is not active, so
 * the agent + user see it instead of silently drifting.
 *
 * REPORT-ONLY by necessity (sanctioned, unlike the old no_agent_loop posture): a
 * SessionStart hook cannot retro-fit a session that never loaded it, and Claude
 * Code reads hook config only at session start — so the only honest remedy is to
 * INFORM and let the user restart after `opensquid setup`. Fail-open: any read
 * error degrades to "no injection" (a health check must never block a session).
 *
 * Imports from: node:fs/promises, node:os, node:path, zod, ../runtime/result.js,
 *   ../runtime/bootstrap.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { loadActivePacks } from '../runtime/bootstrap.js';
import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

const NoArgs = z.object({}).strict();

/** The hook events opensquid wires; each must reference an `opensquid-hook-*` command. */
const REQUIRED_HOOK_EVENTS = ['PreToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'] as const;

interface CheckFlowHealthResult {
  kind: 'inject_context';
  content: string;
}

/**
 * Returns a LOUD inject_context directive when flow enforcement is NOT active for
 * this session, else null (silent when healthy). Never throws.
 */
export const CheckFlowHealth: FunctionDef<z.input<typeof NoArgs>, CheckFlowHealthResult | null> = {
  name: 'check_flow_health',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 4,
  execute: async (_args, ctx) => {
    const problems: string[] = [];

    // (a) opensquid hooks wired in settings.json — the F3 case. Honour
    // CLAUDE_CONFIG_DIR (Claude Code's config-dir override) so the path is
    // correct for non-default installs AND testable.
    try {
      const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
      const raw = await readFile(join(configDir, 'settings.json'), 'utf8');
      const settings = JSON.parse(raw) as { hooks?: Record<string, unknown> };
      const hooks = settings.hooks ?? {};
      const missing = REQUIRED_HOOK_EVENTS.filter(
        (ev) => !JSON.stringify(hooks[ev] ?? []).includes('opensquid-hook'),
      );
      if (missing.length > 0) {
        problems.push(
          `opensquid hooks are NOT wired in ~/.claude/settings.json for: ${missing.join(', ')}`,
        );
      }
    } catch {
      problems.push('could not read ~/.claude/settings.json to verify the opensquid hooks');
    }

    // (b) a gate pack (one with an FSM) is active for this umbrella.
    try {
      const packs = await loadActivePacks(ctx.sessionId);
      if (!packs.some((p) => p.fsm !== undefined)) {
        problems.push('no flow-gate pack (e.g. `coding-flow`) is active for this umbrella');
      }
    } catch {
      problems.push('could not resolve the active packs for this umbrella');
    }

    if (problems.length === 0) return ok(null); // healthy → silent

    const content =
      '⛔ FLOW ENFORCEMENT IS NOT ACTIVE — ' +
      problems.join('; ') +
      '. The SCOPE→AUTHOR→7-phase gates will NOT run this session, so work can be committed un-gated. ' +
      'Run `opensquid setup` and then RESTART this session (Claude Code wires hooks only at session start — a running session cannot self-heal).';
    return ok({ kind: 'inject_context' as const, content });
  },
};
