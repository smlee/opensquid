/**
 * VS.1 (T-v2-skill-host) — execute the active v2 pack's SKILLS via the v1 dispatch machinery.
 *
 * THE GAP (evidence): the v2 runtime runs FSM gate states (v2_supply) but never the pack's SKILLS.
 * `compile_v2.ts:95` binds `skills: []` to gate states (only executor states bind skills, pack_v2.ts:35),
 * and `fullstack-flow` is all-gates → zero skills bound; `state_skills.ts:59` only records names; and
 * `evaluateProcess` is never called under `src/runtime/loop`. Skills execute ONLY via v1 `dispatchEvent`
 * (`dispatch.ts:340-410`) over the v1 `Pack[]`, which EXCLUDES the v2 pack. So `pause-guard` (load:preload,
 * blocks AskUserQuestion past scope) + the lens skills are 100% dormant → v2 < v1.
 *
 * THE FIX (pre-research §3, fork resolved from canonical §4.3 + load semantics): the v2 pack's skills activate
 * by their own `load`/`triggers`/`requires`/`when_to_load` (NOT executor-state binding) — exactly what
 * `dispatchEvent` already runs. So synthesize a v1 `Pack` carrying the v2 cartridge's skills + its compiled FSM
 * and run it through `dispatchEvent` (reusing trigger/requires/dynamic-load/rule-walk/verdict/drift). This makes
 * `pause-guard` (preload) execute → the pause gate goes live. FAIL-OPEN: any error never blocks.
 */
import type { LoadedPackV2 } from '../../packs/loader_v2.js';
import type { SkillOutput } from '../../packs/loader.js';
import type { FunctionRegistry } from '../../functions/registry.js';
import { dispatchEvent } from '../hooks/dispatch.js';
import type { Event } from '../types.js';
import { type Pack } from '../types.js';

export interface V2SkillHostResult {
  exitCode: 0 | 2;
  stderr: string;
  contextInjections: string[];
}

/**
 * A v1 `Pack` carrying the v2 cartridge's skills + compiled FSM. `dispatchEvent` reads only
 * name/skills/activationScope/fsm/models/procedure/driftResponse — scope/goal/etc. are unread, valid
 * placeholders satisfy the type. The compiled FSM is threaded so `pause-guard`'s `read_fsm_state` reads
 * the SAME live v2 state the gates use (keyed on the cartridge name).
 */
function synthSkillPack(loaded: LoadedPackV2, skills: SkillOutput[]): Pack {
  return {
    name: loaded.pack.name,
    version: loaded.pack.version,
    scope: 'workflow',
    goal: '',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills,
    activationScope: 'project',
    fsm: loaded.compiled.fsm,
  };
}

/** Source-code extensions a lens is relevant to (NOT docs/config/data). */
const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|vue|svelte|astro|c|cc|cpp|h|hpp|cs|kt|swift|scala|sql|css|scss|less|html)$/i;

/**
 * VS.3 — deterministic lens relevance gate (canonical §4.3 "only the lenses that fit … most work gets
 * none"; per the deterministic>probabilistic rule, a SIMPLE SIGNAL, not the embedder prefilter). `preload`
 * skills (the discipline — pause-guard) ALWAYS run; `lazy` skills (the lenses) run ONLY on a source-code
 * Write/Edit. So a Bash/Read/Grep/AskUserQuestion/Stop or a docs/config edit gets NO lens — pause-guard only.
 * (Finer per-lens domain-selection — a DB edit → data-modeling only — needs per-lens signals, a follow-up.)
 */
export function relevantSkills(skills: SkillOutput[], event: Event): SkillOutput[] {
  const args = 'args' in event ? event.args : undefined;
  const filePath = typeof args?.file_path === 'string' ? args.file_path : '';
  const isSourceEdit =
    'tool' in event &&
    (event.tool === 'Write' || event.tool === 'Edit') &&
    SOURCE_EXT.test(filePath);
  return skills.filter((s) => s.load === 'preload' || isSourceEdit);
}

/**
 * Run every active v2 cartridge's skills through `dispatchEvent` for `event`, merging the results.
 * A block from ANY cartridge wins (exitCode 2). Reuses v1's complete skill semantics; the v2 gate
 * decision (v2_supply) is computed/merged separately by the caller.
 */
export async function runV2SkillHost(
  cartridges: readonly LoadedPackV2[],
  event: Event,
  registry: FunctionRegistry,
  sessionId: string,
): Promise<V2SkillHostResult> {
  let exitCode: 0 | 2 = 0;
  const stderrParts: string[] = [];
  const contextInjections: string[] = [];
  for (const loaded of cartridges) {
    try {
      const skills = relevantSkills(loaded.skills, event);
      if (skills.length === 0) continue;
      const r = await dispatchEvent(event, [synthSkillPack(loaded, skills)], registry, sessionId);
      if (r.exitCode === 2) exitCode = 2;
      if (r.stderr.length > 0) stderrParts.push(r.stderr);
      contextInjections.push(...r.contextInjections);
    } catch (e) {
      // FAIL-OPEN: a skill-host error must never block the tool or crash the hook.
      process.stderr.write(
        `[v2-skill-host] cartridge '${loaded.pack.name}' skipped: ${String(e)}\n`,
      );
    }
  }
  return { exitCode, stderr: stderrParts.join('\n'), contextInjections };
}
