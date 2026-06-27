/**
 * T-project-context — the `<project>/.opensquid/context.md` FRONTMATTER schema.
 *
 * `context.md` is **user-authored, per-project** (every project is different —
 * pnpm vs npm, JS vs Rust, different conventions — so there is NO fixed settings
 * menu that fits all). opensquid READS it live and never overwrites it; the user
 * owns the file. Two tiers of content, because not everything can be enforced:
 *
 *   - the markdown BODY = free-form context (advisory) — injected so the agent
 *     always carries it ("this is a Rust project; use cargo; errors via Result");
 *   - the frontmatter = the user's ENFORCEABLE rules (the deterministically
 *     checkable subset), compiled to block-guards via `compileGuards`:
 *       * `forbid:` — a list of command strings to block (the approachable form);
 *       * `rules:`  — raw `Guard` objects for full control (the power form);
 *       * `package_manager:` — an optional shorthand kept for convenience/compat
 *         (expands to forbid the OTHER managers' install verbs). NOT the center
 *         of gravity — `forbid`/`rules` are the general surface.
 *
 * `.strict()`: an unknown frontmatter key fails loud (a typo must surface).
 */
import { z } from 'zod';

import { Guard } from './manifest.js';

/** The package managers the `package_manager` shorthand accepts. */
export const PackageManager = z.enum(['pnpm', 'npm', 'yarn', 'bun']);
export type PackageManager = z.infer<typeof PackageManager>;

const shape = {
  /**
   * Optional shorthand: declare the project's package manager and opensquid
   * blocks every OTHER manager's install/add verbs. Convenience for the common
   * case; equivalent to writing the same entries under `forbid`.
   */
  package_manager: PackageManager.optional(),
  /**
   * The approachable enforcement surface: command strings to block, e.g.
   * `["npm install", "yarn add", "git push --force"]`. Each is parsed to a
   * structural `command_invokes` guard (program + first subcommand) — a prose
   * mention never false-fires. For conditions a bare command can't express,
   * use `rules`.
   */
  forbid: z.array(z.string().min(1)).optional(),
  /**
   * The power surface: raw `Guard` objects (the same shape builtin packs use —
   * `{ name, detect, when, level, message, … }`), compiled verbatim by
   * `compileGuards`. For authors who need conditions beyond a flat command.
   */
  rules: z.array(Guard).optional(),
} as const;

export const ProjectContextFrontmatter = z.object(shape).strict();
export type ProjectContextFrontmatter = z.infer<typeof ProjectContextFrontmatter>;

/**
 * Loader-side LENIENT variant: strips unknown keys (zod's default object
 * behavior) instead of rejecting them. The loader parses with this + warns about
 * what it dropped, so a single typo'd key never throws into the fail-open hook
 * (`pre-tool-use.ts` main().catch → exit 0) and silently disables the discipline.
 * Authoring/tests use the strict variant above to catch typos loudly.
 */
export const ProjectContextFrontmatterLenient = z.object(shape);
