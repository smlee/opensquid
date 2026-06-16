/**
 * PT.2 (T-packs-slash-command) — install the shipped `/packs` Claude Code skill.
 *
 * Claude Code surfaces a slash command from a file at `<home>/.claude/skills/
 * <dir>/SKILL.md`, where the DIRECTORY name is the command (not the frontmatter
 * `name:`) and file-presence alone is sufficient — no registration step
 * (https://code.claude.com/docs/en/skills.md §discovery). opensquid already
 * writes `~/.claude/settings.json` (hooks) + `~/.claude.json` (MCP) in the setup
 * wizard; this adds exactly one bounded write target: `.../skills/packs/SKILL.md`.
 *
 * Discipline mirrors settings-writer: back up an existing file before overwrite,
 * mkdir -p the target, idempotent (re-copy the same shipped source). Touches
 * ONLY the `packs` skill — never any sibling skill.
 */

import { copyFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InstallSkillResult {
  /** Absolute path written. */
  written: string;
  /** Set when an existing SKILL.md was moved aside before overwrite. */
  backupPath?: string;
  /** True when `<home>/.claude/skills/` did NOT exist and we created it — Claude
   *  Code needs one restart to start watching a brand-new top-level skills dir
   *  (skills.md §discovery); an EXISTING dir picks up the file live. */
  createdSkillsDir: boolean;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/**
 * Resolve the shipped source `claude-skills/packs/SKILL.md` relative to this
 * module's compiled location (mirrors `runtime/paths.ts` resolveBuiltinScopeRoot):
 *   dist/setup/wizard/skill-installer.js → dist/setup/wizard → … → <npm-root>
 *   → <npm-root>/claude-skills/packs/SKILL.md
 */
function shippedPacksSkill(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'claude-skills', 'packs', 'SKILL.md');
}

/**
 * Install the `/packs` skill into `<home>/.claude/skills/packs/SKILL.md`.
 * Idempotent + backup-before-overwrite. Returns the path written, any backup,
 * and whether the top-level skills dir had to be created (restart hint).
 */
export async function installPacksSkill(home: string): Promise<InstallSkillResult> {
  const skillsDir = join(home, '.claude', 'skills');
  const dest = join(skillsDir, 'packs', 'SKILL.md');

  const createdSkillsDir = !(await exists(skillsDir));

  let backupPath: string | undefined;
  if (await exists(dest)) {
    backupPath = `${dest}.bak.${String(process.pid)}`;
    await rename(dest, backupPath);
  }

  await mkdir(dirname(dest), { recursive: true });
  await copyFile(shippedPacksSkill(), dest);

  return {
    written: dest,
    createdSkillsDir,
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}
