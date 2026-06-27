/**
 * T-project-context — the `<project>/.opensquid/context.md` FRONTMATTER schema.
 *
 * A lightweight, per-project context + settings file: YAML frontmatter (typed
 * settings, validated here) + a markdown body (free-form prose, injected). The
 * settings expand to deterministic block-guards (loader: `project_context.ts`);
 * the body is surfaced via `inject_context`. NOT a pack — no manifest/active.json
 * boilerplate; auto-loaded as a synthetic project-scoped pack when present.
 *
 * `.strict()`: an unknown frontmatter key is a fail-loud error (a typo'd setting
 * must surface, not silently no-op). Extend by adding NAMED settings here + a row
 * in the loader's expansion table — never a raw guard passthrough (out of scope:
 * the ask was "a setting", not a guard-authoring surface).
 */
import { z } from 'zod';

/** The package managers a project may declare. */
export const PackageManager = z.enum(['pnpm', 'npm', 'yarn', 'bun']);
export type PackageManager = z.infer<typeof PackageManager>;

export const ProjectContextFrontmatter = z
  .object({
    /**
     * The project's package manager. Expands (loader) to block-guards on EVERY
     * OTHER manager's install/add verbs — e.g. `pnpm` blocks `npm install`,
     * `npm i`, `npm ci`, `npm add`, `yarn add`, `bun add`. Structural match via
     * `command_invokes` (program+subcommand) — no false-fire on a prose mention.
     */
    package_manager: PackageManager.optional(),
  })
  .strict();
export type ProjectContextFrontmatter = z.infer<typeof ProjectContextFrontmatter>;
