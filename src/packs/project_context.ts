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
import {
  ProjectContextFrontmatter,
  ProjectContextFrontmatterLenient,
  type PackageManager,
} from './schemas/project_context.js';
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

/** A guard name fragment: lowercase alnum + hyphens (matches the Guard name schema). */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse one `forbid:` command string into a structural block-guard. The first
 * token is the program; the next NON-flag token (if any) is the subcommand
 * (`"npm install"` → program npm + subcommand install; `"npm"` → any npm). Flags
 * are ignored here — for flag/refspec conditions an author uses raw `rules:`.
 * Index keeps the guard name unique even if two entries slugify the same.
 */
function forbidToGuard(command: string, index: number): Guard {
  const tokens = command.trim().split(/\s+/);
  const program = tokens[0] ?? '';
  const subcommand = tokens.slice(1).find((t) => !t.startsWith('-'));
  return {
    name: `forbid-${index}-${slug(command)}`.slice(0, 80),
    on: 'tool_call',
    detect: {
      call: 'command_invokes',
      args: { program, ...(subcommand !== undefined ? { subcommand } : {}) },
    },
    as: 'hit',
    when: 'hit',
    level: 'block',
    message:
      `BLOCKED: \`${command}\` is forbidden in this project ` +
      `(declared in .opensquid/context.md).`,
  };
}

/**
 * Expand the user-authored frontmatter into the `Guard[]` the compiler consumes —
 * the union of three surfaces: `package_manager` shorthand, `forbid` commands,
 * and raw `rules`. All three compile through the same `compileGuards`.
 */
export function settingsToGuards(fm: ProjectContextFrontmatter): Guard[] {
  const guards: Guard[] = [];

  // 1. package_manager shorthand → block the OTHER managers' install/add verbs.
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

  // 2. forbid → one structural command guard per entry (the approachable surface).
  for (const [i, command] of (fm.forbid ?? []).entries()) {
    guards.push(forbidToGuard(command, i));
  }

  // 3. rules → raw user-authored Guards, verbatim (the power surface).
  guards.push(...(fm.rules ?? []));

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

/** Surface a non-fatal context.md problem to stderr (the hook's warn channel). */
function warn(message: string): void {
  process.stderr.write(`opensquid: ${message}\n`);
}

/**
 * Load the project's `context.md` as a synthetic Pack, or `null` when there is no
 * project scope / no file / nothing usable.
 *
 * RESILIENT BY DESIGN — it NEVER throws on a user `context.md`. The pre-tool-use
 * hook is fail-open (`main().catch → exit 0`), so a throw here would silently
 * disable EVERY guard for that event, not just this file. So a malformed file
 * degrades + warns instead: an unknown/typo'd key is stripped (valid keys still
 * load), unparseable YAML or a bad value drops the frontmatter to nothing (the
 * prose body still loads), and a guard-compile error skips the guards (prose
 * still loads). A user mistake can warn — it must never switch the discipline off.
 */
export async function loadProjectContextPack(cwd: string): Promise<Pack | null> {
  const root = await resolveProjectScopeRoot(cwd);
  if (root === null) return null;
  const file = join(root, CONTEXT_FILE);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // no file → no-op
    warn(`could not read ${file} (${String(e)}) — skipping project context`);
    return null;
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  let fm: ProjectContextFrontmatter = {};
  if (frontmatter !== null && frontmatter.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = yamlParse(frontmatter);
    } catch (e) {
      warn(`${file}: unparseable YAML frontmatter — ignoring it (${String(e)})`);
      parsed = undefined;
    }
    if (parsed !== undefined && parsed !== null) {
      const strict = ProjectContextFrontmatter.safeParse(parsed);
      if (strict.success) {
        fm = strict.data;
      } else {
        // Degrade: strip unknown keys + keep what validates; a bad VALUE drops all.
        const lenient = ProjectContextFrontmatterLenient.safeParse(parsed);
        fm = lenient.success ? lenient.data : {};
        warn(
          `${file}: ${strict.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` +
            ` — ignoring the invalid setting(s), loading the rest`,
        );
      }
    }
  }

  const skills: SkillType[] = [];

  const guards = settingsToGuards(fm);
  if (guards.length > 0) {
    const compiled = compileGuards(PACK_NAME, guards);
    if (!compiled.ok) {
      const details = compiled.errors.map((x) => `${x.guardName}: ${x.message}`).join('; ');
      warn(`${file}: guard compile failed (${details}) — skipping rules, keeping context`);
    } else if (compiled.skill.rules.length > 0) {
      skills.push(compiled.skill);
    }
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
