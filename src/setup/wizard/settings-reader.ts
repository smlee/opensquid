/**
 * Parser for Claude Code's `settings.json` hook block (G.2 — doctor + writer
 * share this parser so they can't drift on the JSON shape).
 *
 * Produces a flat `ParsedHookEntry[]` from the nested
 * `hooks.<EventName>[].hooks[]` shape. Each entry carries:
 *   - `event`: the Claude Code event name (PreToolUse, Stop, ...)
 *   - `type`: 'command' | 'prompt' (D9-guard prompt-type hooks aren't
 *     subprocess commands and MUST be filtered out before any spawn loop)
 *   - `command`: the command string (only set when type === 'command')
 *   - `prompt`: the prompt text (only set when type === 'prompt')
 *   - `matcher`: optional matcher (e.g. "Bash" for PreToolUse)
 *   - `opensquidMarker`: true if the inner entry carried `@opensquid: true`
 *
 * ENOENT (file doesn't exist) → returns `[]`. All other read / parse errors
 * propagate — doctor wraps them and surfaces "could not read X" notes
 * rather than crashing.
 *
 * Engine-vocabulary discipline: this file knows about Claude Code's
 * settings.json format because it's a consumer-side parser. The runtime
 * (`dispatch.ts`, `bootstrap.ts`) stays harness-agnostic.
 *
 * Imported by: `src/setup/cli/doctor.ts`. Sibling to `settings-writer.ts`
 * (writer + reader share the same JSON shape; kept in separate files because
 * the writer's projection logic is heavy and ownership-aware while the
 * reader is pure parse + flatten).
 */

import { promises as fs } from 'node:fs';

interface RawHookCommandEntry {
  type?: string;
  command?: string;
  prompt?: string;
  '@opensquid'?: boolean;
  [k: string]: unknown;
}
interface RawHookGroup {
  matcher?: string;
  hooks?: RawHookCommandEntry[];
  [k: string]: unknown;
}
interface RawSettingsJson {
  hooks?: Record<string, RawHookGroup[]>;
  [k: string]: unknown;
}

export type HookEntryType = 'command' | 'prompt';

export interface ParsedHookEntry {
  /** Claude Code event name verbatim (PreToolUse, UserPromptSubmit, ...). */
  event: string;
  /** 'command' = spawnable subprocess; 'prompt' = D9-guard inline text. */
  type: HookEntryType;
  /** Set when type === 'command'. Empty string otherwise. */
  command: string;
  /** Set when type === 'prompt'. Empty string otherwise. */
  prompt: string;
  /** Optional Claude Code matcher (tool name regex, etc.). */
  matcher: string | undefined;
  /** True if the entry carried `@opensquid: true` (writer-owned). */
  opensquidMarker: boolean;
}

/**
 * Read settings.json, return flat list of hook entries.
 *
 * ENOENT → `[]` (no file = no hooks configured here). Callers (doctor) MUST
 * still report informational note about ENOENT so the user knows it skipped
 * the project scope — that lives in the caller, not here.
 *
 * Throws on JSON parse failure: doctor catches and surfaces "could not parse
 * <path>: <err>" as a RED entry rather than crashing the CLI.
 */
export async function readSettingsHooks(settingsPath: string): Promise<ParsedHookEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const json = JSON.parse(raw) as RawSettingsJson;
  return flatten(json);
}

/** Pure flatten — exported for unit tests so they can drive the projection
 * without round-tripping to disk. */
export function flatten(json: RawSettingsJson): ParsedHookEntry[] {
  const out: ParsedHookEntry[] = [];
  const hooks = json.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const inner = group.hooks ?? [];
      for (const h of inner) {
        // Normalize the type field. Claude Code uses 'command' for
        // subprocess hooks and 'prompt' for D9-guard inline-text hooks.
        // Anything unrecognized defaults to 'command' so future-added
        // subprocess hook variants don't get silently skipped by doctor.
        const type: HookEntryType = h.type === 'prompt' ? 'prompt' : 'command';
        out.push({
          event,
          type,
          command: typeof h.command === 'string' ? h.command : '',
          prompt: typeof h.prompt === 'string' ? h.prompt : '',
          matcher: typeof group.matcher === 'string' ? group.matcher : undefined,
          opensquidMarker: h['@opensquid'] === true,
        });
      }
    }
  }
  return out;
}
