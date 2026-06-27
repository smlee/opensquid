/**
 * PFV2.2 — loader-v2: read a pack-format-v2 directory into a LoadedPackV2.
 *
 * Reads `<dir>/pack.yaml`, validates it with `PackV2` (fail-loud, the project Zod
 * invariant), and compiles it (`compilePackV2`) to the reused `fsm.ts` engine
 * machine + the per-state metadata the loop driver consumes. This REPLACES the
 * v1 assembly (flat skills + side-file fsm + dead `extends`/`drift_response`);
 * only the low-level read (yaml parse) is shared with the v1 path.
 *
 * Skills/guard COMPILATION wire in with the guard subsystem (GUARD.1/EXE.1);
 * the loader surfaces the raw `guards`/`messages` maps from the pack.
 *
 * Spec: loop/docs/tasks/T-fsm-actor-runtime.md §PFV2.2.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as yamlParse } from 'yaml';

import { compilePackV2, type CompiledPack } from './compile_v2.js';
import { loadSkillsDir, type SkillOutput } from './loader.js';
import { PackV2 } from './schemas/pack_v2.js';

export interface LoadedPackV2 {
  pack: PackV2;
  compiled: CompiledPack; // fsm (passes validateFsm) + per-state meta for the loop driver
  guards: Record<string, unknown>; // raw guard defs — compiled by the guard subsystem
  messages: Record<string, string>; // self-continue store: failure_type → instruction
  skills: SkillOutput[]; // the pack's skills/<name>/skill.yaml set — state-keyed bound at runtime (SKILL.1)
}

export async function loadPackV2(dir: string): Promise<LoadedPackV2> {
  const raw: unknown = yamlParse(await readFile(join(dir, 'pack.yaml'), 'utf8'));
  const pack = PackV2.parse(raw); // fail-loud on a malformed pack
  // Reuse the v1 skills/ scanner: absent dir → [] (ENOENT contract); a malformed skill.yaml throws (fail-loud).
  const skills = await loadSkillsDir(join(dir, 'skills'));
  return {
    pack,
    compiled: compilePackV2(pack),
    guards: pack.guards,
    messages: pack.messages,
    skills,
  };
}
