/**
 * T-project-context (write half) — the SCAFFOLDER for
 * `<project>/.opensquid/context.md`.
 *
 * `context.md` is USER-authored (every project differs — there is no fixed
 * settings menu that fits all). So opensquid's only job at setup is to drop a
 * STARTER if none exists, then get out of the way: it NEVER overwrites an
 * existing file. The user owns it; the runtime re-reads it live every dispatch,
 * so edits take effect immediately and are never clobbered (which is why the
 * earlier managed-frontmatter merge is gone — there is nothing to merge when the
 * file is wholly the user's).
 *
 * The starter shows both tiers (enforceable `forbid`/`rules` + free-form body)
 * and, when the package manager is detected, seeds it as a working example.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackageManager } from '../../packs/schemas/project_context.js';

export interface ScaffoldOptions {
  /** When detected, seeded into the starter as a working `package_manager` line. */
  detectedPackageManager?: PackageManager;
}

/** PURE: the starter `context.md` body. */
export function composeStarter(opts: ScaffoldOptions): string {
  const pmLine =
    opts.detectedPackageManager !== undefined
      ? `package_manager: ${opts.detectedPackageManager}\n`
      : '';
  return (
    `---\n` +
    pmLine +
    `# Enforceable rules — blocked where opensquid hooks run (claude-code, codex).\n` +
    `# Uncomment + edit. \`forbid\` is the easy form; \`rules\` is the raw guard form.\n` +
    `# forbid:\n` +
    `#   - npm install\n` +
    `#   - git push --force\n` +
    `---\n` +
    `# project context\n` +
    `\n` +
    `Free-form notes for the agent — injected every turn. Describe what makes THIS\n` +
    `project different: language, toolchain, conventions, gotchas. This text is\n` +
    `advisory; the rules above are hard-enforced where hooks run.\n`
  );
}

/**
 * Create `<opensquidDir>/context.md` ONLY if absent (atomic tmp+rename). Returns
 * 'created' on a fresh write, or 'exists' when a file is already there — in which
 * case nothing is touched (the user's file is never overwritten).
 */
export async function scaffoldProjectContext(
  opensquidDir: string,
  opts: ScaffoldOptions = {},
): Promise<'created' | 'exists'> {
  const path = join(opensquidDir, 'context.md');

  try {
    await readFile(path, 'utf8');
    return 'exists'; // never overwrite a user-authored file
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  await mkdir(opensquidDir, { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, composeStarter(opts));
  await rename(tmp, path);
  return 'created';
}
