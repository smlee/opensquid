/**
 * T-project-context (write half) — the managed-frontmatter writer for
 * `<project>/.opensquid/context.md`.
 *
 * The loader (`packs/project_context.ts`) reads YAML frontmatter (typed settings)
 * + a markdown body (free-form prose). This writer OWNS the frontmatter and
 * PRESERVES the body — frontmatter = opensquid-managed, body = the human's, never
 * clobbered. Mirrors `managed_block.ts`'s contract (replace owned region, keep
 * foreign, `.bak` snapshot, atomic tmp+rename, created/updated/added) but for the
 * YAML frontmatter region instead of a comment-delimited block.
 *
 * This is the sanctioned write path the agent itself cannot take (the safety
 * floor forbids an agent writing `.opensquid/`): a setup function, runnable on
 * every adopter's machine and validated by its own test — so the initial process
 * is exercised, not bypassed.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

import { splitFrontmatter } from '../../packs/project_context.js';
import type { PackageManager } from '../../packs/schemas/project_context.js';

export interface ProjectContextSettings {
  packageManager?: PackageManager;
}

const STARTER_BODY =
  '# project context\n\n' +
  '_Free-form notes for the agent (injected each turn) — conventions, where things live, gotchas._';

/** PURE: compose the new file text from existing content + the settings to set. */
export function composeContext(existing: string, settings: ProjectContextSettings): string {
  const { frontmatter, body } = splitFrontmatter(existing);
  const fm: Record<string, unknown> =
    frontmatter !== null && frontmatter.trim().length > 0
      ? ((yamlParse(frontmatter) as Record<string, unknown> | null) ?? {})
      : {};

  if (settings.packageManager !== undefined) fm.package_manager = settings.packageManager;

  const fmText = yamlStringify(fm).trim();
  const bodyText = body.trim();
  return `---\n${fmText}\n---\n${bodyText.length > 0 ? bodyText : STARTER_BODY}\n`;
}

/**
 * Write the settings into `<opensquidDir>/context.md`, preserving any prose body
 * (and any unmanaged frontmatter keys). `.bak` snapshot of the prior content;
 * atomic via tmp+rename. Returns 'created' (no prior file) | 'added' (file existed
 * with no frontmatter) | 'updated' (frontmatter replaced).
 */
export async function writeProjectContext(
  opensquidDir: string,
  settings: ProjectContextSettings,
): Promise<'created' | 'updated' | 'added'> {
  const path = join(opensquidDir, 'context.md');

  let existing = '';
  let existed = true;
  try {
    existing = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    existed = false;
  }

  const hadFrontmatter = splitFrontmatter(existing).frontmatter !== null;

  if (existed) await writeFile(`${path}.bak`, existing);
  await mkdir(opensquidDir, { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, composeContext(existing, settings));
  await rename(tmp, path);

  return !existed ? 'created' : hadFrontmatter ? 'updated' : 'added';
}
