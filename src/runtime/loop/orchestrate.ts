/**
 * ORCH.5 — the hard-coded general orchestrator, wired live at `user-prompt-submit`.
 *
 * The one loop: read the project's declared `domain` → `classify` the prompt → `resolveRoute` (pinned/asked) →
 * `matchPacks` → ACTIVATE the chosen pack by writing `.opensquid/active.json` (consumed by the existing
 * `runV2Cartridges` supply on the next tool-call event — the LIVE path, `v2_supply.ts:48-101`). `converse` → bare;
 * `control` → orchestrator-meta (the pin/forget/set-domain ACTIONS are the tracked ORCH.9). FAIL-OPEN — a bug
 * here never breaks the hook.
 *
 * ADDITIVE + inert today: with zero `serves`-bearing packs in the catalog it returns the ZERO result, so the
 * merged hook decision is byte-identical to v1. Catalog source for the core = the ACTIVE v2 packs
 * (`loadActiveV2Cartridges`); widening it to installed-but-inactive packs is the tracked ORCH.7.
 *
 * Imports: ../classify, ../../packs/match, ../orchestrator_settings, ../../packs/schemas/pack_v2 (type).
 * Imported by: src/runtime/hooks/user-prompt-submit.ts.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { matchPacks } from '../../packs/match.js';
import { classify } from '../classify.js';
import { readSettings, resolveRoute, recordRoute } from '../orchestrator_settings.js';

import type { PackV2 } from '../../packs/schemas/pack_v2.js';

export interface OrchestrateResult {
  /** the pack added to active.json this turn (already persisted — runV2Cartridges runs it next event). */
  activatedPack?: string;
  /** additionalContext lines (e.g. the ask-on-tie nudge). */
  injections: string[];
  /** project-related + no pack → the grounded floor (ORCH.6 consumes this). */
  ground: boolean;
  /** a `control` (meta) turn — the pin/forget/set-domain handler is ORCH.9. */
  control?: boolean;
}

const INERT: OrchestrateResult = { injections: [], ground: false };

/** Dynamic activation = idempotently add `name` to `<scope>/.opensquid/active.json` (discovery.ts:253,287). */
async function activatePackInScope(scopeRoot: string, name: string): Promise<void> {
  const p = join(scopeRoot, '.opensquid', 'active.json');
  let json: { packs: string[] } = { packs: [] };
  try {
    json = JSON.parse(await readFile(p, 'utf8')) as { packs: string[] };
  } catch {
    /* ENOENT → seed a fresh active.json */
  }
  if (!Array.isArray(json.packs)) json.packs = [];
  if (json.packs.includes(name)) return; // idempotent — no churn, no race-corruption
  json.packs.push(name);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(json, null, 2));
  await rename(tmp, p);
}

/**
 * Route one prompt. Returns the ZERO result when no `serves`-bearing pack exists (today's inert state), so a
 * caller merging this into the v1 decision is a no-op.
 */
export async function orchestrate(
  projectDir: string,
  prompt: string,
  isProject: boolean,
  packs: PackV2[],
  now: string,
): Promise<OrchestrateResult> {
  try {
    const servesPacks = packs.filter((p) => p.serves !== undefined);
    if (servesPacks.length === 0) return INERT; // ADDITIVE — byte-identical merge today
    const s = await readSettings(projectDir);
    const f = classify(
      prompt,
      isProject ? { project: true, ...(s.domain ? { domain: s.domain } : {}) } : { project: false },
    );
    if (f.intent === 'converse') return { injections: [], ground: false }; // converse → BARE (never grounded)
    if (f.intent === 'control') return { injections: [], ground: false, control: true }; // meta; actions = ORCH.9

    const fm: Record<string, string> = { intent: f.intent };
    if (f.domain !== undefined) fm.domain = f.domain;
    if (f.stakes !== undefined) fm.stakes = f.stakes;
    const catalog = new Set(servesPacks.map((p) => p.name));

    const pinned = resolveRoute(s, fm, catalog);
    if (pinned !== null) {
      await activatePackInScope(projectDir, pinned);
      return { activatedPack: pinned, injections: [], ground: false };
    }
    const { pack, candidates } = matchPacks(f, servesPacks);
    if (pack !== undefined) {
      await recordRoute(projectDir, fm, pack.name, now);
      await activatePackInScope(projectDir, pack.name);
      return { activatedPack: pack.name, injections: [], ground: false };
    }
    if (candidates.length > 1 && s.policy.onTie === 'ask') {
      const names = candidates.map((c) => c.name).join(', ');
      return {
        injections: [`Multiple packs fit (${names}). Which should drive this?`],
        ground: false,
      };
    }
    return { injections: [], ground: isProject }; // no match → ground (project) or bare
  } catch (e) {
    process.stderr.write(`[orchestrate] ignored: ${String(e)}\n`); // FAIL-OPEN
    return INERT;
  }
}
