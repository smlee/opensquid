/**
 * T-CODEX-HOST-SHELL CHS.1 — pure projection of opensquid's hook entries
 * into codex's `~/.codex/hooks.json` (the user layer).
 *
 * Codex 0.139's hook engine is deliberately Claude Code-compatible
 * (`ClaudeHooksEngine`, codex-rs/hooks/src/registry.rs): same JSON shape,
 * same stdin payload family, same permissionDecision outputs — so the shell
 * is CONFIG, not adapter code. Two codex-specific disciplines live here:
 *
 *   1. NO SessionEnd entry EVER: codex has no SessionEnd event and its Stop
 *      is TURN-scoped ("Stop run at turn scope", developers.openai.com/codex/
 *      hooks) — wiring opensquid-hook-sessionend to Stop would clear the
 *      coding-flow FSM every turn.
 *   2. ABSOLUTE bin paths: Claude Code resolves PATH for bare names
 *      (settings-writer writes them bare); codex hook spawns carry no PATH
 *      guarantee, so `resolveHookBinDir()` is a hard deliverable here.
 *
 * Idempotency = the 0.5.378 ownership discipline: `isOpensquidHookEntry`
 * (shared predicate) + per-entry surgery — re-runs replace ours, preserve
 * foreign groups byte-intact, excise ours from mixed groups keeping foreign
 * siblings.
 *
 * Imports from: node:fs, node:path, ./settings-writer.js.
 * Imported by: src/setup/cli/codex_hooks.ts, src/setup/cli/doctor.ts.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PRETOOLUSE_HOOK_TIMEOUT_S } from '../../runtime/hooks/timeouts.js';
import { OPENSQUID_BIN_FOR_EVENT, isOpensquidHookEntry } from './settings-writer.js';

/** The five codex events we wire (NO SessionEnd — see header). */
export const CODEX_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
] as const;
export type CodexEvent = (typeof CODEX_EVENTS)[number];

const TIMEOUT_S: Record<CodexEvent, number> = {
  PreToolUse: PRETOOLUSE_HOOK_TIMEOUT_S,
  PostToolUse: 60,
  UserPromptSubmit: 60,
  Stop: 60,
  SessionStart: 60,
};

/** One hook command entry — the markable shape (settings-writer's
 *  HookCommandEntry family); `@opensquid: true` marks ours. */
export interface CodexHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
  '@opensquid'?: boolean;
  [k: string]: unknown;
}
export interface CodexMatcherGroup {
  matcher?: string;
  hooks: CodexHookEntry[];
  [k: string]: unknown;
}
export interface CodexHooksFile {
  hooks?: Record<string, CodexMatcherGroup[]>;
  [k: string]: unknown; // foreign top-level keys preserved verbatim
}

/** The 0.5.378 per-entry surgery: wholly-ours group → drop; wholly-foreign →
 *  untouched; mixed → excise ours, keep foreign siblings. */
export function pruneOpensquidFromGroup(group: CodexMatcherGroup): CodexMatcherGroup | null {
  const foreign = group.hooks.filter((h) => !isOpensquidHookEntry(h));
  if (foreign.length === 0) return null;
  if (foreign.length === group.hooks.length) return group;
  return { ...group, hooks: foreign };
}

/** The dir holding the opensquid-hook-* shims: npm/pnpm install every bin of
 *  this package into ONE dir, and process.argv[1] is the running `opensquid`
 *  shim — its dirname is that dir. Throws (fail-loud; the wizard step turns
 *  it into a cancel) when the sibling shim is missing — bare names are NOT
 *  an acceptable fallback for codex (no PATH guarantee at hook spawn). */
export function resolveHookBinDir(): string {
  const dir = dirname(process.argv[1] ?? '');
  if (!existsSync(join(dir, 'opensquid-hook-pretooluse'))) {
    throw new Error(
      `codex-hooks: opensquid-hook-* shims not found beside the CLI (${dir}) — re-run npm/pnpm install/link`,
    );
  }
  return dir;
}

export interface ProjectCodexHooksResult {
  next: CodexHooksFile;
  added: number;
  replaced: number;
  preserved: number;
}

export function projectCodexHooks(input: {
  current: CodexHooksFile;
  binDir: string;
}): ProjectCodexHooksResult {
  const next: CodexHooksFile = { ...input.current, hooks: { ...(input.current.hooks ?? {}) } };
  let added = 0;
  let replaced = 0;
  let preserved = 0;
  const hooks = next.hooks ?? {};
  for (const event of CODEX_EVENTS) {
    const groups = hooks[event] ?? [];
    // Replacement is counted at the ENTRY level (did pruning remove any of
    // ours?), NOT group-drop level — the mixed-group case (ours excised,
    // foreign siblings kept) modifies a group without dropping it.
    const oursBefore = groups.reduce(
      (n, g) => n + g.hooks.filter((h) => isOpensquidHookEntry(h)).length,
      0,
    );
    const foreign = groups
      .map((g) => pruneOpensquidFromGroup(g))
      .filter((g): g is CodexMatcherGroup => g !== null);
    if (oursBefore > 0) replaced += 1;
    else added += 1;
    preserved += foreign.length;
    foreign.push({
      // codex matchers are REGEX — anchored catch-all (delta-4 anchoring
      // discipline; pinned by a fixture).
      matcher: '^.*$',
      hooks: [
        {
          type: 'command',
          command: join(input.binDir, OPENSQUID_BIN_FOR_EVENT[event]),
          timeout: TIMEOUT_S[event],
          '@opensquid': true,
        },
      ],
    });
    hooks[event] = foreign;
  }
  next.hooks = hooks;
  return { next, added, replaced, preserved };
}
