/**
 * Trigger state + pack enumeration helpers for CLI.1.
 *
 * Split out of `triggers.ts` (file-size budget). Three concerns:
 *
 *   1. `readDisabledSet` / `writeDisabledSet` — load + atomically rewrite
 *      `~/.opensquid/trigger_state.yaml`. Malformed yaml throws (no silent
 *      fail-open).
 *   2. `enumeratePacks` — walk a packs directory (default
 *      `~/.opensquid/packs/`) and `loadPack` each subdir, skipping
 *      dotfiles + non-dirs.
 *   3. `buildRows` / `resolveTrigger` — flatten `pack.skills[].triggers[]`
 *      into rows + lookup-by-id.
 *
 * Trigger id format (locked): `<pack>:<skill>:<kind>:<index>`.
 *
 * Imports from: node:fs/promises, yaml, packs/loader, runtime/paths,
 *   runtime/types.
 * Imported by: src/setup/cli/triggers.ts.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { loadPack } from '../../packs/loader.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';

import { readKeyedYamlList, writeKeyedYamlList } from './state_io.js';

import type { Pack, Trigger } from '../../runtime/types.js';

export interface TriggerRow {
  id: string;
  pack: string;
  skill: string;
  kind: Trigger['kind'];
  index: number;
  filter: string;
  enabled: boolean;
}

export const defaultPacksDir = (): string => join(OPENSQUID_HOME(), 'packs');
export const defaultStatePath = (): string => join(OPENSQUID_HOME(), 'trigger_state.yaml');

const isString = (v: unknown): v is string => typeof v === 'string';

export async function readDisabledSet(statePath: string): Promise<Set<string>> {
  return new Set(
    await readKeyedYamlList<string>(statePath, 'disabled', 'trigger_state.yaml', isString),
  );
}

export async function writeDisabledSet(statePath: string, disabled: Set<string>): Promise<void> {
  return writeKeyedYamlList(statePath, 'disabled', [...disabled].sort());
}

export async function enumeratePacks(packsDir: string): Promise<Pack[]> {
  let entries: string[];
  try {
    entries = await readdir(packsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  entries.sort();
  const packs: Pack[] = [];
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const dir = join(packsDir, e);
    let st;
    try {
      st = await stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    packs.push(await loadPack(dir));
  }
  return packs;
}

function filterSummary(t: Trigger): string {
  switch (t.kind) {
    case 'schedule':
      return t.cron !== undefined ? `cron=${t.cron}` : '';
    case 'webhook':
      return t.path !== undefined ? `path=${t.path}` : '';
    case 'inbound_channel':
      return t.channel !== undefined ? `channel=${t.channel}` : '';
    case 'file_changed':
      return t.paths !== undefined && t.paths.length > 0 ? `paths=${t.paths.join(',')}` : '';
    default:
      return '';
  }
}

function rowFor(
  pack: Pack,
  skill: Pack['skills'][number],
  index: number,
  disabled: Set<string>,
): TriggerRow {
  const trigger = skill.triggers[index]!;
  const id = `${pack.name}:${skill.name}:${trigger.kind}:${String(index)}`;
  return {
    id,
    pack: pack.name,
    skill: skill.name,
    kind: trigger.kind,
    index,
    filter: filterSummary(trigger),
    enabled: !disabled.has(id),
  };
}

export async function buildRows(opts: {
  packsDir?: string;
  statePath?: string;
}): Promise<TriggerRow[]> {
  const [packs, disabled] = await Promise.all([
    enumeratePacks(opts.packsDir ?? defaultPacksDir()),
    readDisabledSet(opts.statePath ?? defaultStatePath()),
  ]);
  const rows: TriggerRow[] = [];
  for (const pack of packs) {
    for (const skill of pack.skills) {
      skill.triggers.forEach((_t, i) => rows.push(rowFor(pack, skill, i, disabled)));
    }
  }
  return rows;
}

export async function resolveTrigger(
  id: string,
  opts: { packsDir?: string; statePath?: string },
): Promise<{ row: TriggerRow; trigger: Trigger } | null> {
  const packs = await enumeratePacks(opts.packsDir ?? defaultPacksDir());
  const disabled = await readDisabledSet(opts.statePath ?? defaultStatePath());
  for (const pack of packs) {
    for (const skill of pack.skills) {
      for (let i = 0; i < skill.triggers.length; i += 1) {
        const trigger = skill.triggers[i]!;
        const candidate = `${pack.name}:${skill.name}:${trigger.kind}:${String(i)}`;
        if (candidate === id) return { row: rowFor(pack, skill, i, disabled), trigger };
      }
    }
  }
  return null;
}
