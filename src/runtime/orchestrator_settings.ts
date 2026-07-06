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
  // The STANDING code-write grant for the doc-only orchestrator guard (GS1). A CONFIG VALUE (single owner:
  // this file) — NOT the retired `.opensquid/allow-code-write` flag file. Flipped ONLY by the `/code-write`
  // command via a SERVER-SIDE CLI write (`setAllowCodeWrite`); an agent Edit of orchestrator.json is
  // guard-blocked (DANGEROUS substrate-edit), so the toggle must stay a CLI operation. Default OFF (locked).
  allow_code_write: z.boolean().default(false),
  policy: z
    .object({
      onTie: z.enum(['ask', 'first']).default('ask'),
      onLowConfidence: z.enum(['ground', 'ask']).default('ground'),
      onlineSearch: z.boolean().default(false),
    })
    .default({}),
});
export type Settings = z.infer<typeof Settings>;

const settingsFile = (projectDir: string): string =>
  join(projectDir, '.opensquid', 'orchestrator.json');

/**
 * Read the project's settings; absent/corrupt/over-schema → a FRESH default (no throw). NO user-scope file exists.
 * MUST return a fresh object each call (`Settings.parse({})`, not a shared const) — callers mutate `s.routes`, so a
 * shared default reference would accumulate routes across reads (the only "global" is the immutable code default).
 */
export async function readSettings(projectDir: string): Promise<Settings> {
  try {
    return Settings.parse(JSON.parse(await readFile(settingsFile(projectDir), 'utf8')));
  } catch {
    return Settings.parse({});
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

/** Atomically persist the settings (tmp+rename) — the shared writer for record/pin/set/forget. */
async function writeSettings(projectDir: string, s: Settings): Promise<void> {
  const p = settingsFile(projectDir);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await rename(tmp, p);
}

const sameMatch = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
};

/** Append a learned (`asked`) route and atomically persist. */
export async function recordRoute(
  projectDir: string,
  match: Record<string, string>,
  pack: string,
  now: string,
): Promise<void> {
  const s = await readSettings(projectDir);
  s.routes.push({ match, pack, source: 'asked', at: now });
  await writeSettings(projectDir, s);
}

// ORCH.9 — the `control` writers (the deterministic surface behind `opensquid orchestrator …`).

/** Set the project's declared domain (a dictionary value the classifier ctx reads). */
export async function setProjectDomain(projectDir: string, domain: DomainDict): Promise<void> {
  const s = await readSettings(projectDir);
  s.domain = domain;
  await writeSettings(projectDir, s);
}

/** Pin a route (`source:'pinned'`, beats `asked`); replaces any existing pinned route with the same match. */
export async function pinRoute(
  projectDir: string,
  match: Record<string, string>,
  pack: string,
  now: string,
): Promise<void> {
  const s = await readSettings(projectDir);
  s.routes = s.routes.filter((r) => !(r.source === 'pinned' && sameMatch(r.match, match)));
  s.routes.push({ match, pack, source: 'pinned', at: now });
  await writeSettings(projectDir, s);
}

/** Remove ALL routes (asked or pinned) that point at `pack`. */
export async function forgetRoute(projectDir: string, pack: string): Promise<void> {
  const s = await readSettings(projectDir);
  s.routes = s.routes.filter((r) => r.pack !== pack);
  await writeSettings(projectDir, s);
}

/**
 * Set the project's standing code-write grant (the doc-only orchestrator guard's "unless"). SERVER-SIDE ONLY —
 * run by the `/code-write` CLI, never an agent Edit (an agent write of orchestrator.json is guard-blocked).
 * Preserves every other setting (read-modify-write via the atomic tmp+rename `writeSettings`).
 */
export async function setAllowCodeWrite(projectDir: string, on: boolean): Promise<void> {
  const s = await readSettings(projectDir);
  s.allow_code_write = on;
  await writeSettings(projectDir, s);
}
