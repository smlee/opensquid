/**
 * Idempotent writer for Claude Code's `settings.json` hook block (G.1 Part B).
 *
 * Writes opensquid's 4 anti-drift hook entries (PreToolUse, UserPromptSubmit,
 * Stop, SessionEnd) while preserving every non-opensquid hook entry verbatim.
 *
 * Two recognition rules identify entries the writer OWNS:
 *   1. `'@opensquid': true` marker on the inner hook entry — every entry the
 *      writer adds carries this; it's the ONLY contract that protects
 *      third-party entries from getting wiped on subsequent wizard runs.
 *   2. `LEGACY_OPENSQUID_PATTERN` regex — recognises the broken
 *      `node <abs>/opensquid/dist/index.js anti-drift <event>` shape that
 *      currently lives in `~/.claude/settings.json` (the very bug G.1 fixes).
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

// Maps opensquid's 4 supported Claude Code hook events to the bin entries
// declared in package.json (resolve to `dist/runtime/hooks/*.js` binaries
// that already wire `loadActivePacks` + `dispatchEvent`).
export const OPENSQUID_BIN_FOR_EVENT = {
  PreToolUse: 'opensquid-hook-pretooluse',
  UserPromptSubmit: 'opensquid-hook-userpromptsubmit',
  Stop: 'opensquid-hook-stop',
  SessionEnd: 'opensquid-hook-sessionend',
} as const;

export type ClaudeEvent = keyof typeof OPENSQUID_BIN_FOR_EVENT;

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

export interface WriteResult {
  /** Number of fresh opensquid entries added across all 4 events. Always 4. */
  added: number;
  /** Number of legacy / prior @opensquid entries removed (replaced). */
  replaced: number;
  /** Number of non-opensquid hook groups preserved verbatim. */
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
    // Drop any group whose inner hooks include an opensquid-owned entry
    // (by marker or legacy regex). Preserve everything else verbatim.
    const filtered: HookGroup[] = [];
    for (const group of groups) {
      const isOpensquidGroup = (group.hooks ?? []).some(
        (h) =>
          h['@opensquid'] === true ||
          (typeof h.command === 'string' && LEGACY_OPENSQUID_PATTERN.test(h.command)),
      );
      if (isOpensquidGroup) {
        replaced += 1;
      } else {
        filtered.push(group);
        preserved += 1;
      }
    }
    filtered.push({
      hooks: [{ type: 'command', command: OPENSQUID_BIN_FOR_EVENT[event], '@opensquid': true }],
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
