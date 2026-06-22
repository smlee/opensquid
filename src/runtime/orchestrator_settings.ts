/**
 * ORCH.4 — the PROJECT-LOCAL orchestrator settings (`<project>/.opensquid/orchestrator.json`).
 *
 * Holds the project's declared `domain` (a dictionary value, read into the classifier ctx), the learned/pinned
 * `routes`, and `policy`. PROJECT-LOCAL ONLY — there is NO `~/.opensquid` variant (routing is project-specific;
 * a global preference would carry the wrong choice across repos — the user's "cannot be global" decision). The
 * only global is the hard-coded `DEFAULTS` (immutable). Absent/corrupt file → `DEFAULTS` (never throws).
 *
 * `resolveRoute` is SELF-HEALING: a route whose pack is no longer in the live catalog is skipped, so a stale
 * route never executes a dangling reference (survives the v2 shrink with ≤1 re-ask). Atomic tmp+rename writes
 * (the `workflow_phases.ts` pattern).
 *
 * Imported by: src/runtime/loop/orchestrate.ts (ORCH.5).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { DomainDict } from '../packs/schemas/pack_v2.js';

const Route = z.object({
  match: z.record(z.string(), z.string()),
  pack: z.string().min(1),
  source: z.enum(['pinned', 'asked']),
  at: z.string(),
});
export type Route = z.infer<typeof Route>;

const Settings = z.object({
  version: z.literal(1).default(1),
  // the project's declared domain — read into the classifier ctx (ORCH.5); never coined by the model.
  domain: DomainDict.optional(),
  routes: z.array(Route).default([]),
  policy: z
    .object({
      onTie: z.enum(['ask', 'first']).default('ask'),
      onLowConfidence: z.enum(['ground', 'ask']).default('ground'),
      onlineSearch: z.boolean().default(false),
    })
    .default({}),
});
export type Settings = z.infer<typeof Settings>;

/** The hard-coded immutable global default (the only "global" — code, not a mutable file). */
const DEFAULTS: Settings = Settings.parse({});

const settingsFile = (projectDir: string): string =>
  join(projectDir, '.opensquid', 'orchestrator.json');

/** Read the project's settings; absent/corrupt/over-schema → DEFAULTS (no throw). NO user-scope file exists. */
export async function readSettings(projectDir: string): Promise<Settings> {
  try {
    return Settings.parse(JSON.parse(await readFile(settingsFile(projectDir), 'utf8')));
  } catch {
    return DEFAULTS;
  }
}

/**
 * The most-specific route whose `match ⊆ facets` AND whose `pack` is still in `catalog` (self-heal: a dangling
 * route is skipped). Tie-break: most-specific → `pinned` over `asked` → newest (ISO `at` lexicographic).
 */
export function resolveRoute(
  s: Settings,
  facets: Record<string, string>,
  catalog: Set<string>,
): string | null {
  const ok = s.routes.filter(
    (r) => catalog.has(r.pack) && Object.entries(r.match).every(([k, v]) => facets[k] === v),
  );
  if (ok.length === 0) return null;
  ok.sort(
    (a, b) =>
      Object.keys(b.match).length - Object.keys(a.match).length || // most specific
      (a.source === b.source ? 0 : a.source === 'pinned' ? -1 : 1) || // pinned > asked
      b.at.localeCompare(a.at), // newest (ISO-8601 lexicographic = chronological)
  );
  return ok[0]?.pack ?? null;
}

/** Append a learned (`asked`) route and atomically persist (tmp+rename). */
export async function recordRoute(
  projectDir: string,
  match: Record<string, string>,
  pack: string,
  now: string,
): Promise<void> {
  const s = await readSettings(projectDir);
  s.routes.push({ match, pack, source: 'asked', at: now });
  const p = settingsFile(projectDir);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await rename(tmp, p);
}
