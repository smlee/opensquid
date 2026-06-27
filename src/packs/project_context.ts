/**
 * T-project-context — load `<project>/.opensquid/context.md` as a synthetic,
 * project-scoped `Pack`.
 *
 * The file is the lightweight per-project context+settings surface (spec:
 * docs/tasks/T-project-context.md). It carries two parts, each compiled to a
 * proven mechanism — NO new enforcement/injection engine:
 *
 *   - YAML frontmatter (typed settings) → block-guards via `compileGuards`
 *     (`guards_compiler.ts`), firing deterministically on every `tool_call`.
 *   - markdown body (prose) → an `inject_context` skill firing on
 *     `session_start` + `prompt_submit` (survives compaction; dispatch.ts:421).
 *
 * Auto-loaded (no active.json entry): absent file ⇒ `null` (no-op); malformed
 * frontmatter ⇒ THROW (fail loud, mirroring `loadActiveEntry`'s malformed-pack
 * policy). The returned Pack carries ONLY skills — no v1 guards/driftResponse on
 * the Pack object — so the dispatcher's `block_tool` default applies to the
 * compiled block-guards (verdict `level:block` ⇒ exit 2).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as yamlParse } from 'yaml';

import { resolveProjectScopeRoot } from '../runtime/paths.js';
import type { Pack } from '../runtime/types.js';

import { compileGuards } from './guards_compiler.js';
import type { Guard } from './schemas/manifest.js';
import { ProjectContextFrontmatter, type PackageManager } from './schemas/project_context.js';
import type { SkillType } from './schemas/index.js';

const CONTEXT_FILE = 'context.md';
const PACK_NAME = 'project-context';

/**
 * Per-manager install/add verbs. For a declared manager M, every OTHER manager's
 * verbs become block-guards (you declared M, so M's own verbs stay allowed). The
 * match is structural (`command_invokes` program+subcommand) — `echo "npm i"` or
 * a commit message mentioning it does NOT fire.
 */
const PM_INSTALL_VERBS: Record<PackageManager, readonly string[]> = {
  npm: ['install', 'i', 'ci', 'add'],
  yarn: ['add', 'install'],
  pnpm: ['add', 'install', 'i'],
  bun: ['add', 'install', 'i'],
};

/** Split optional leading YAML frontmatter (`---\n … \n---`) from the markdown body. */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  // Tolerate a leading BOM / blank lines before the opening fence.
  const text = raw.replace(/^﻿/, '');
  if (!/^\s*---\r?\n/.test(text)) return { frontmatter: null, body: text };
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (m === null) return { frontmatter: null, body: text }; // unterminated fence → treat all as body
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}

/** Expand the typed frontmatter settings into the `Guard[]` the compiler consumes. */
export function settingsToGuards(fm: ProjectContextFrontmatter): Guard[] {
  const guards: Guard[] = [];
  const pm = fm.package_manager;
  if (pm !== undefined) {
    for (const other of Object.keys(PM_INSTALL_VERBS) as PackageManager[]) {
      if (other === pm) continue;
      for (const verb of PM_INSTALL_VERBS[other]) {
        guards.push({
          name: `pm-no-${other}-${verb}`,
          on: 'tool_call',
          detect: { call: 'command_invokes', args: { program: other, subcommand: verb } },
          as: 'hit',
          when: 'hit',
          level: 'block',
          message:
            `BLOCKED: this project's package_manager is "${pm}" ` +
            `(declared in .opensquid/context.md). Use \`${pm}\` instead of \`${other} ${verb}\`.`,
        });
      }
    }
  }
  return guards;
}

/** Build the prose `inject_context` skill (session_start + prompt_submit). */
function buildProseSkill(prose: string): SkillType {
  return {
    name: `${PACK_NAME}/context`,
    load: 'preload', // always loaded → fires on its triggers every session/turn
    when_to_load: [],
    requires: [],
    unloads_when: [],
    triggers: [{ kind: 'session_start' }, { kind: 'prompt_submit' }],
    rules: [
      {
        id: 'inject-project-context',
        kind: 'track_check',
        requires: [],
        process: [{ call: 'project_context_inject', args: { content: prose } }],
      },
    ],
    tools: [],
  };
}

/**
 * Load the project's `context.md` as a synthetic Pack, or `null` when there is no
 * project scope / no file. Throws on malformed frontmatter or a guard-compile
 * error (fail loud — a typo'd setting must surface).
 */
export async function loadProjectContextPack(cwd: string): Promise<Pack | null> {
  const root = await resolveProjectScopeRoot(cwd);
  if (root === null) return null;

  let raw: string;
  try {
    raw = await readFile(join(root, CONTEXT_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // no file → no-op
    throw e;
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  let fm: ProjectContextFrontmatter = {};
  if (frontmatter !== null && frontmatter.trim().length > 0) {
    const parsed = yamlParse(frontmatter) as unknown;
    const result = ProjectContextFrontmatter.safeParse(parsed ?? {});
    if (!result.success) {
      throw new Error(
        `opensquid: malformed ${join(root, CONTEXT_FILE)} frontmatter: ${result.error.message}`,
      );
    }
    fm = result.data;
  }

  const skills: SkillType[] = [];

  const guards = settingsToGuards(fm);
  if (guards.length > 0) {
    const compiled = compileGuards(PACK_NAME, guards);
    if (!compiled.ok) {
      const details = compiled.errors.map((x) => `${x.guardName}: ${x.message}`).join('; ');
      throw new Error(`opensquid: ${join(root, CONTEXT_FILE)} guard compile failed: ${details}`);
    }
    if (compiled.skill.rules.length > 0) skills.push(compiled.skill);
  }

  if (body.trim().length > 0) skills.push(buildProseSkill(body.trim()));

  if (skills.length === 0) return null; // empty file → nothing to contribute

  return {
    name: PACK_NAME,
    version: '0.0.0',
    scope: 'project',
    goal: '',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills,
  };
}
