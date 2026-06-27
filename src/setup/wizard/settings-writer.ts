/**
 * Idempotent writer for Claude Code's `settings.json` hook block (G.1 Part B).
 *
 * Writes opensquid's anti-drift hook entries (one per event in
 * `OPENSQUID_BIN_FOR_EVENT`: PreToolUse, PostToolUse, UserPromptSubmit, Stop,
 * SessionEnd, SessionStart) while preserving every non-opensquid hook entry
 * verbatim.
 *
 * Three recognition rules identify entries the writer OWNS (all three live in
 * `isOpensquidHookEntry` — the ONE ownership predicate, also consumed by
 * doctor's managed-filter + spawn gate and the flow-health check):
 *   1. `'@opensquid': true` marker on the inner hook entry — every entry the
 *      writer adds carries this.
 *   2. `LEGACY_OPENSQUID_PATTERN` regex — the broken ancient
 *      `node <abs>/opensquid/dist/index.js anti-drift <event>` shape (G.1).
 *   3. Bin-name basename match (`isOpensquidHookCommand`) — bare modern
 *      `opensquid-hook-*` commands written before the marker contract existed
 *      (T-FIX-WIZARD-HOOK-RECOGNITION: these used to be "preserved" as
 *      third-party, so every wizard re-run DUPLICATED every hook).
 *
 * A `.bak` snapshot is written before any mutation. The marker contract is
 * the FIRST line of defense; .bak is the last. Audit phase MUST verify
 * every opensquid-written entry carries the marker.
 *
 * Engine-vocabulary discipline: this module is the ONLY G.1 file that names
 * Claude Code's hook event types. `discovery.ts` + `bootstrap.ts` are
 * harness-agnostic.
 *
 * Imported by: src/setup/cli/hooks.ts.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

// Maps opensquid's supported Claude Code hook events to the bin entries
// declared in package.json (resolve to `dist/runtime/hooks/*.js` binaries
// that already wire `loadActivePacks` + `dispatchEvent`).
// T-POSTPUSH POSTPUSH.1 (2026-05-29) added PostToolUse; T-HANDOFF-HARDENING
// HH6.1 (2026-05-31) added SessionStart. Existing users need to re-run
// `opensquid setup` to register newly-added hooks in their settings.json.
export const OPENSQUID_BIN_FOR_EVENT = {
  PreToolUse: 'opensquid-hook-pretooluse',
  PostToolUse: 'opensquid-hook-posttooluse',
  UserPromptSubmit: 'opensquid-hook-userpromptsubmit',
  Stop: 'opensquid-hook-stop',
  SessionEnd: 'opensquid-hook-sessionend',
  // T-HANDOFF-HARDENING HH6.1 (2026-05-31) — SessionStart is the 6th entry.
  // Like POSTPUSH.1's PostToolUse, existing users must re-run `opensquid
  // setup` to register the new hook in their settings.json (the same re-run
  // reconciles any prior-added-but-uninstalled event, e.g. PostToolUse).
  SessionStart: 'opensquid-hook-sessionstart',
} as const;

export type ClaudeEvent = keyof typeof OPENSQUID_BIN_FOR_EVENT;

// T-AUDIT-SPAWN-FIX (2026-06-10): the PreToolUse hook hosts the BLOCKING
// coding-flow audits (claude -p reasoning calls measured to 268s under
// subscription contention; inner audit window 340s). Without an explicit
// timeout the host's default hook cap (≈60s) kills the hook before any audit
// can finish — fresh installs were broken out of the box. Only PreToolUse
// carries the cap; the other five events keep host defaults. Existing users
// pick it up by re-running `opensquid setup` (same convention as POSTPUSH.1).
export const PRETOOLUSE_HOOK_TIMEOUT_S = 360;

// Loose hook entry shapes — we round-trip `unknown` fields verbatim so
// unrelated third-party schema additions survive a wizard pass.
interface HookCommandEntry {
  type: string;
  command?: string;
  '@opensquid'?: boolean;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCommandEntry[];
  [k: string]: unknown;
}
interface SettingsJson {
  hooks?: Partial<Record<string, HookGroup[]>>;
  [k: string]: unknown;
}

// Legacy detector — deliberately specific to avoid false positives on
// user-authored commands that mention "opensquid" elsewhere (e.g. a custom
// audit script). Matches: `node <abs>/opensquid<...>/dist/index.js anti-drift`.
export const LEGACY_OPENSQUID_PATTERN = /node\s+\S*opensquid\S*dist\/index\.js\s+anti-drift/;

// T-FIX-WIZARD-HOOK-RECOGNITION: the ONE hook-ownership predicate, shared by
// the writer's surgery below AND doctor's managed-filter + spawn security
// gate. Ownership classification used to live in three divergent forms
// (marker+legacy here, a broader substring regex in doctor) — pre-marker
// installs carrying the bare modern bin name matched neither writer arm, so
// a wizard re-run "preserved" them as third-party and DUPLICATED every hook.
const OPENSQUID_BIN_NAMES = new Set<string>(Object.values(OPENSQUID_BIN_FOR_EVENT));

/** Is this command string one of opensquid's hook binaries (any path, any era)? */
export const isOpensquidHookCommand = (command: string): boolean => {
  if (LEGACY_OPENSQUID_PATTERN.test(command)) return true;
  const first = command.trim().split(/\s+/)[0] ?? '';
  return OPENSQUID_BIN_NAMES.has(first.slice(first.lastIndexOf('/') + 1));
};

/** Is this inner hook entry opensquid-owned (marker OR command shape)? */
export const isOpensquidHookEntry = (h: HookCommandEntry): boolean =>
  h['@opensquid'] === true || (typeof h.command === 'string' && isOpensquidHookCommand(h.command));

export interface WriteResult {
  /** Number of fresh opensquid entries added — one per `OPENSQUID_BIN_FOR_EVENT` key. */
  added: number;
  /**
   * Number of groups that had opensquid-owned entries removed — wholly-owned
   * groups dropped OR owned entries excised from a mixed group (a mixed group
   * increments BOTH `replaced` and `preserved`: ours left, the group survived).
   */
  replaced: number;
  /** Number of hook groups preserved (verbatim, or minus excised owned entries). */
  preserved: number;
  /** Path to the `.bak` snapshot written before mutation. */
  backupPath: string;
}

/**
 * Pure projection — disk-untouched. Used by both the writer and `--dry-run`.
 * Input JSON is deep-cloned (JSON round-trip; safe because settings.json
 * never contains Date/Set/Map/functions), so callers' objects don't mutate.
 */
export function projectOpensquidHooks(input: SettingsJson): {
  output: SettingsJson;
  added: number;
  replaced: number;
  preserved: number;
} {
  const output = JSON.parse(JSON.stringify(input)) as SettingsJson;
  output.hooks ??= {};
  let added = 0;
  let replaced = 0;
  let preserved = 0;

  for (const event of Object.keys(OPENSQUID_BIN_FOR_EVENT) as ClaudeEvent[]) {
    const groups = (output.hooks[event] ??= []);
    // Per-ENTRY surgery (T-FIX-WIZARD-HOOK-RECOGNITION): a wholly-owned group
    // is dropped (incl. the DECLARED matcher convergence — canonical entries
    // are matcher-less; opensquid bins receive every event of their type and
    // self-filter); a MIXED group keeps its matcher + foreign siblings (the
    // module's preservation contract) with only the owned entries excised.
    const filtered: HookGroup[] = [];
    for (const group of groups) {
      const inner = group.hooks ?? [];
      const owned = inner.filter((h) => isOpensquidHookEntry(h));
      if (owned.length === 0) {
        filtered.push(group);
        preserved += 1;
        continue;
      }
      if (owned.length === inner.length) {
        replaced += 1; // wholly ours — drop; canonical append below
        continue;
      }
      // MIXED: excise ours, keep the group (matcher + foreign hooks intact).
      filtered.push({ ...group, hooks: inner.filter((h) => !isOpensquidHookEntry(h)) });
      replaced += 1; // ...for the excised owned entr(ies)
      preserved += 1; // ...for the surviving foreign group
    }
    filtered.push({
      hooks: [
        {
          type: 'command',
          command: OPENSQUID_BIN_FOR_EVENT[event],
          '@opensquid': true,
          ...(event === 'PreToolUse' ? { timeout: PRETOOLUSE_HOOK_TIMEOUT_S } : {}),
        },
      ],
    });
    added += 1;
    output.hooks[event] = filtered;
  }
  return { output, added, replaced, preserved };
}

/**
 * Write opensquid's hook entries to `settingsPath`. Creates a `.bak` snapshot
 * (`{}` if the file didn't exist). Same 2-space JSON indentation as the live
 * file so `diff <file>.bak <file>` highlights only the hook changes.
 */
export async function writeOpensquidHooks(settingsPath: string): Promise<WriteResult> {
  const input = await readSettingsJson(settingsPath);
  // A project with `.opensquid/` but no `.claude/` (first-run) has no parent dir
  // yet — create it so the `.bak` snapshot + write don't ENOENT-abort the wizard.
  await fs.mkdir(dirname(settingsPath), { recursive: true });
  const backupPath = `${settingsPath}.bak`;
  await fs.writeFile(backupPath, JSON.stringify(input, null, 2));

  const { output, added, replaced, preserved } = projectOpensquidHooks(input);
  await fs.writeFile(settingsPath, JSON.stringify(output, null, 2));

  return { added, replaced, preserved, backupPath };
}

/** ENOENT → `{}` (first-run case). All other errors propagate. */
export async function readSettingsJson(settingsPath: string): Promise<SettingsJson> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    return JSON.parse(raw) as SettingsJson;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}
