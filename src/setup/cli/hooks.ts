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
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveProjectScopeRoot } from '../../runtime/paths.js';
import type { EnvironmentsConfig } from '../../packs/discovery.js';

import {
  projectOpensquidHooks,
  readSettingsJson,
  writeOpensquidHooks,
  type WriteResult,
} from '../wizard/settings-writer.js';
import { installPacksSkill } from '../wizard/skill-installer.js';
import { hasBinaryOnPath, installAgentsContext } from '../wizard/install_agents_context.js';
import { detectPackageManager } from '../wizard/package_manager_detect.js';
import { scaffoldProjectContext } from '../wizard/context_writer.js';
import { installProjectContextRules } from '../wizard/install_project_context.js';
import { installEnforcementHooks } from '../wizard/enforcement_hooks.js';

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
  /** commander maps `--no-context` → `context === false` (T-project-context opt-out). */
  context?: boolean;
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
    if (flags.context !== false && flags.userOnly !== true) {
      const scopeRoot = await resolveProjectScopeRoot(r.cwd());
      if (scopeRoot !== null) {
        const pm = await detectPackageManager(dirname(scopeRoot));
        r.out(
          `  would scaffold ${join(scopeRoot, 'context.md')} if absent` +
            `${pm !== null ? ` (seed package_manager: ${pm})` : ''}; never overwrites; opt-out: --no-context\n`,
        );
      }
    }
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

  // T-project-context — scaffold <project>/.opensquid/context.md IF ABSENT (opt-out:
  // --no-context). The file is user-authored: opensquid drops a starter (seeded with
  // the detected package manager when available) and NEVER overwrites an existing
  // one — the user owns it, the runtime re-reads it live. This is the sanctioned
  // write path the agent itself cannot take (safety floor).
  if (flags.context !== false && flags.userOnly !== true) {
    const scopeRoot = await resolveProjectScopeRoot(r.cwd());
    if (scopeRoot !== null) {
      const pm = await detectPackageManager(dirname(scopeRoot));
      const result = await scaffoldProjectContext(
        scopeRoot,
        pm !== null ? { detectedPackageManager: pm } : {},
      );
      const at = join(scopeRoot, 'context.md');
      if (result === 'created')
        r.out(
          `  context: created ${at}${pm !== null ? ` (seeded package_manager: ${pm})` : ''}` +
            ` — edit it to add project rules + context\n`,
        );
      else r.out(`  context: ${at} already exists — left as-is (yours)\n`);

      // T-project-context advisory tier: render context.md into each detected harness's
      // PROJECT rules file (AGENTS.md/CLAUDE.md/.cursor/rules/…) so non-hook harnesses
      // also receive the project context. Reuses the managed-block writer (foreign-safe).
      const projectRoot = dirname(scopeRoot);
      const rep = await installProjectContextRules(projectRoot, r.home(), r.hasBinary);
      for (const w of rep.written) r.out(`  context-rules: ${w.result} ${w.harness} (${w.path})\n`);

      // T-multi-harness-enforce: wire the opensquid DENY hook (exit-2) into each detected blocking-capable
      // harness's project config (Gemini/Windsurf/Cursor/Continue/Qwen/Trae). Amp/OpenCode/Cline → manual.
      const enf = await installEnforcementHooks(projectRoot);
      for (const w of enf.written) r.out(`  enforce-hook: ${w.result} ${w.harness} (${w.path})\n`);
      if (enf.manual.length > 0) {
        r.out('  enforce-hook: manual (plugin/script) harnesses:\n');
        for (const m of enf.manual) r.out(`    [${m.harness}] ${m.note}\n`);
      }
    }
  }
}

/**
 * GF.1 (T-gitflow-integration-fix, scope-1) — the PURE elicitation merge: fold the elicited
 * `version-control.environments` block INTO an existing `active.json` object, preserving `packs`/`verifySuite`/
 * `versioning`/everything else (idempotent — re-running rewrites cleanly). `production` is REQUIRED; a
 * whitespace/empty `staging`/`local` is dropped (absent ⇒ has-stage off / local defaults to the current branch at
 * read time). Returns the NEW object (never mutates the input) — the command owns the fs read/write. PURE + testable.
 */
export function mergeEnvironmentsBlock(
  existing: Record<string, unknown>,
  values: { production: string; staging?: string; local?: string },
): Record<string, unknown> {
  const environments: EnvironmentsConfig = { production: values.production.trim() };
  if (values.staging !== undefined && values.staging.trim().length > 0)
    environments.staging = values.staging.trim();
  if (values.local !== undefined && values.local.trim().length > 0)
    environments.local = values.local.trim();
  const priorVc =
    typeof existing['version-control'] === 'object' && existing['version-control'] !== null
      ? (existing['version-control'] as Record<string, unknown>)
      : {};
  return { ...existing, 'version-control': { ...priorVc, environments } };
}

/** GF.1 — the install-time elicitation write-through: read the scope's `active.json`, merge the elicited
 *  environments block, write it back. Automation-safe: under `OPENSQUID_AUTOMATION` the on-disk block is NEVER
 *  clobbered (a headless run keeps the configured project as-is). Returns 'written' | 'skipped-automation'. */
export async function writeEnvironmentsElicitation(
  scopeRoot: string,
  values: { production: string; staging?: string; local?: string },
): Promise<'written' | 'skipped-automation'> {
  if (process.env.OPENSQUID_AUTOMATION === '1') return 'skipped-automation';
  const path = join(scopeRoot, 'active.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    existing = {}; // absent/malformed ⇒ start fresh (the writer creates a well-formed block)
  }
  const next = mergeEnvironmentsBlock(existing, values);
  await fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return 'written';
}

/**
 * Register the `wizard hooks` subcommand under the supplied `setup` parent.
 * Returns the wizard subgroup so callers can chain additional wizards.
 */
export function registerSetupWizard(setup: Command, deps: HooksCliDeps = {}): Command {
  const wizard = setup.command('wizard').description('Setup wizards (multi-step config writers)');

  // GF.1 (scope-1) — elicit + write the CONFIG-DRIVEN git-flow `version-control.environments` block. Presence of
  // `--staging` is the has-stage toggle (no `enabled` flag); `--production` is required; `--local` defaults to the
  // current branch at read time when omitted. Idempotent (re-running rewrites cleanly, current values as defaults);
  // under OPENSQUID_AUTOMATION the on-disk block is never clobbered.
  wizard
    .command('environments')
    .description(
      'Elicit + write the config-driven git-flow branches (version-control.environments) into active.json',
    )
    .requiredOption(
      '--production <branch>',
      'the production branch (PR base + reconcile base) — REQUIRED',
    )
    .option('--staging <branch>', 'the staging branch (presence = has-stage; omit for no-stage)')
    .option('--local <branch>', 'the serial landing branch (default: the current branch)')
    .action(async (opts: { production: string; staging?: string; local?: string }) => {
      const r = buildDeps(deps);
      const scopeRoot = await resolveProjectScopeRoot(r.cwd());
      if (scopeRoot === null) {
        r.err('no project .opensquid scope found (run `opensquid setup` first)\n');
        process.exitCode = 1;
        return;
      }
      const result = await writeEnvironmentsElicitation(scopeRoot, opts);
      if (result === 'skipped-automation')
        r.out('  environments: skipped (OPENSQUID_AUTOMATION — on-disk block kept)\n');
      else
        r.out(
          `  environments: wrote version-control.environments to ${join(scopeRoot, 'active.json')}\n`,
        );
    });

  wizard
    .command('hooks')
    .description("Write opensquid's 4 anti-drift hook entries into Claude Code settings.json")
    .option('--dry-run', 'preview the projected changes without writing any file', false)
    .option('--user-only', 'skip the project-scope settings.json even when one is detected', false)
    .option(
      '--no-agents',
      'skip installing the global agent-context baseline into detected harnesses',
    )
    .option(
      '--no-context',
      'skip scaffolding <project>/.opensquid/context.md from the detected package manager',
    )
    .action(async (flags: HooksCliFlags) => {
      await runHooksWizard(flags, deps);
    });

  return wizard;
}
