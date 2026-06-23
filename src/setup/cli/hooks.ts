/**
 * `opensquid setup wizard hooks` — write Claude Code hook entries.
 *
 * Two-stage wizard:
 *   1. Discover-and-preview — read existing `~/.claude/settings.json` and
 *      (when present) `<project>/.claude/settings.json`, project the
 *      proposed change, render a counts summary to stdout. If `--dry-run`
 *      was passed, exit here.
 *   2. Commit — call `writeOpensquidHooks(...)` on each target; print
 *      the resolved counters per file.
 *
 * Target selection:
 *   - user scope: ALWAYS targeted (`~/.claude/settings.json`).
 *   - project scope: targeted when `resolveProjectScopeRoot(cwd)` finds a
 *     `.opensquid/` ancestor — then `<projectRoot>/../.claude/settings.json`
 *     gets written too. Wait — `.opensquid/` lives at the project root, not
 *     `.claude/`. So we write to `dirname(projectScopeRoot)/.claude/settings.json`.
 *
 * Idempotent: re-running the command after the first pass produces a
 * byte-identical `~/.claude/settings.json` (verified by a test fixture).
 *
 * Flags:
 *   --dry-run    Render counts + projected output without writing.
 *   --user-only  Only write `~/.claude/settings.json`; skip project scope.
 *
 * Imports from: commander, node:path, ../wizard/settings-writer, ../../runtime/paths.
 * Imported by: src/cli.ts (via `registerSetupWizard`).
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveProjectScopeRoot } from '../../runtime/paths.js';

import {
  projectOpensquidHooks,
  readSettingsJson,
  writeOpensquidHooks,
  type WriteResult,
} from '../wizard/settings-writer.js';
import { installPacksSkill } from '../wizard/skill-installer.js';
import { hasBinaryOnPath, installAgentsContext } from '../wizard/install_agents_context.js';

import type { Command } from 'commander';

export interface HooksCliDeps {
  /** Test injection — override the writer. Defaults to the real impl. */
  writer?: (path: string) => Promise<WriteResult>;
  /** Test injection — override the preview reader. Defaults to the real impl. */
  reader?: (path: string) => Promise<unknown>;
  /** Test injection — override `process.cwd()`. */
  cwd?: () => string;
  /** Test injection — override `homedir()` for ~/.claude resolution. */
  home?: () => string;
  /** Test injection — override the on-PATH binary probe (GAC.4 harness detection). */
  hasBinary?: (name: string) => Promise<boolean>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface HooksCliFlags {
  dryRun?: boolean;
  userOnly?: boolean;
  /** commander maps `--no-agents` → `agents === false` (GAC.4 opt-out). */
  agents?: boolean;
}

interface ResolvedDeps {
  writer: (path: string) => Promise<WriteResult>;
  reader: (path: string) => Promise<unknown>;
  cwd: () => string;
  home: () => string;
  hasBinary: (name: string) => Promise<boolean>;
  out: (s: string) => void;
  err: (s: string) => void;
}

function buildDeps(deps: HooksCliDeps): ResolvedDeps {
  return {
    writer: deps.writer ?? writeOpensquidHooks,
    reader: deps.reader ?? readSettingsJson,
    cwd: deps.cwd ?? ((): string => process.cwd()),
    home: deps.home ?? homedir,
    hasBinary: deps.hasBinary ?? hasBinaryOnPath,
    out:
      deps.stdout ??
      ((s: string): void => {
        process.stdout.write(s);
      }),
    err:
      deps.stderr ??
      ((s: string): void => {
        process.stderr.write(s);
      }),
  };
}

/**
 * Resolve the two candidate settings.json paths. User-scope is always
 * present (file may not exist yet — `readSettingsJson` returns `{}`).
 * Project-scope is null when there's no `.opensquid/` ancestor.
 */
export async function resolveTargets(deps: {
  cwd: () => string;
  home: () => string;
}): Promise<{ user: string; project: string | null }> {
  const user = join(deps.home(), '.claude', 'settings.json');
  const projectScopeRoot = await resolveProjectScopeRoot(deps.cwd());
  // `.opensquid/` and `.claude/` are siblings under the project root.
  // `projectScopeRoot` is the path TO `<project>/.opensquid`; its parent
  // is the project root itself.
  const project =
    projectScopeRoot === null ? null : join(dirname(projectScopeRoot), '.claude', 'settings.json');
  return { user, project };
}

/**
 * Run the hooks wizard. Pulled out of the commander action so tests can
 * call it directly without spinning a Command tree.
 */
export async function runHooksWizard(flags: HooksCliFlags, deps: HooksCliDeps = {}): Promise<void> {
  const r = buildDeps(deps);
  const targets = await resolveTargets({ cwd: r.cwd, home: r.home });

  const paths: string[] = [targets.user];
  if (targets.project !== null && flags.userOnly !== true) paths.push(targets.project);

  if (flags.dryRun === true) {
    r.out('opensquid setup wizard hooks — DRY RUN (no files written)\n');
    for (const p of paths) {
      const input = (await r.reader(p)) as Parameters<typeof projectOpensquidHooks>[0];
      const { added, replaced, preserved } = projectOpensquidHooks(input);
      r.out(
        `  ${p}: would add ${String(added)}, replace ${String(replaced)}, preserve ${String(
          preserved,
        )} hook group(s)\n`,
      );
    }
    r.out(
      `  would install the /packs skill → ${join(r.home(), '.claude', 'skills', 'packs', 'SKILL.md')}\n`,
    );
    if (flags.agents !== false)
      r.out(
        '  would install the agent-context baseline into detected harnesses (opt-out: --no-agents)\n',
      );
    return;
  }

  r.out('opensquid setup wizard hooks — writing entries\n');
  for (const p of paths) {
    const result = await r.writer(p);
    r.out(
      `  ${p}: added ${String(result.added)}, replaced ${String(result.replaced)}, preserved ${String(
        result.preserved,
      )} hook group(s) (backup: ${result.backupPath})\n`,
    );
  }

  // PT.2 — install the /packs slash command (one bounded ~/.claude/skills write).
  const skill = await installPacksSkill(r.home());
  r.out(
    `  installed /packs skill → ${skill.written}` +
      (skill.backupPath !== undefined ? ` (backup: ${skill.backupPath})` : '') +
      (skill.createdSkillsDir ? ' — restart Claude once so it watches the new skills dir' : '') +
      '\n',
  );

  // GAC.4 — auto-install the global agent-context baseline into every detected harness (opt-out: --no-agents).
  if (flags.agents !== false) {
    const rep = await installAgentsContext(r.home(), r.hasBinary);
    for (const w of rep.written) r.out(`  agents: ${w.result} ${w.harness} (${w.path})\n`);
    if (rep.manual.length > 0) {
      r.out('  agents: manual harnesses — paste this into their global rules:\n');
      for (const m of rep.manual) r.out(`    [${m.harness}]\n${m.block}\n`);
    }
  }
}

/**
 * Register the `wizard hooks` subcommand under the supplied `setup` parent.
 * Returns the wizard subgroup so callers can chain additional wizards.
 */
export function registerSetupWizard(setup: Command, deps: HooksCliDeps = {}): Command {
  const wizard = setup.command('wizard').description('Setup wizards (multi-step config writers)');

  wizard
    .command('hooks')
    .description("Write opensquid's 4 anti-drift hook entries into Claude Code settings.json")
    .option('--dry-run', 'preview the projected changes without writing any file', false)
    .option('--user-only', 'skip the project-scope settings.json even when one is detected', false)
    .option(
      '--no-agents',
      'skip installing the global agent-context baseline into detected harnesses',
    )
    .action(async (flags: HooksCliFlags) => {
      await runHooksWizard(flags, deps);
    });

  return wizard;
}
