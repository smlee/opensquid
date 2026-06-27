/**
 * T-project-context (advisory tier) — write a project's context into each detected
 * harness's PROJECT-level rules file, so harnesses that DON'T run opensquid's hooks
 * still receive the project context as advisory guidance.
 *
 * Parallels install_agents_context.ts (GAC.4) but: (a) project-scoped (paths from
 * PROJECT_RULE_TARGETS, relative to the project root), (b) content is the project's
 * own context.md (not the global baseline). Reuses the proven managed-block writer
 * (foreign-preserve + .bak) for `block` targets and a dedicated file for `file`
 * targets, dedup by resolved path (AGENTS.md sharers collapse to one write).
 *
 * Advisory ONLY: this is text the agent reads. Hard enforcement (block a tool) is
 * the separate hooks tier — only the harnesses opensquid wires hooks into enforce.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse as yamlParse } from 'yaml';

import { splitFrontmatter } from '../../packs/project_context.js';
import { ProjectContextFrontmatterLenient } from '../../packs/schemas/project_context.js';

import { detectHarnessTargets, PROJECT_RULE_TARGETS } from './harness_targets.js';
import { writeManagedBlock } from './managed_block.js';

export interface ProjectRulesReport {
  written: { harness: string; path: string; result: string }[];
}

/**
 * Render `<projectRoot>/.opensquid/context.md` into the advisory body written to
 * harness rules files: the free-form prose + a plain-text summary of the declared
 * rules (package_manager / forbid / rules). Returns null when there's no context.md.
 */
export async function renderProjectRulesBody(projectRoot: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(projectRoot, '.opensquid', 'context.md'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  const lines: string[] = ['# Project context (opensquid)', ''];
  const prose = body.trim();
  if (prose.length > 0) lines.push(prose, '');

  if (frontmatter !== null && frontmatter.trim().length > 0) {
    const parsed = ProjectContextFrontmatterLenient.safeParse(yamlParse(frontmatter) ?? {});
    const fm = parsed.success ? parsed.data : {};
    const rules: string[] = [];
    if (fm.package_manager !== undefined)
      rules.push(`- Package manager: \`${fm.package_manager}\` — do not use the others.`);
    for (const cmd of fm.forbid ?? []) rules.push(`- Do not run: \`${cmd}\``);
    for (const r of fm.rules ?? []) rules.push(`- ${r.message}`);
    if (rules.length > 0) {
      lines.push('## Project rules', ...rules, '');
    }
  }

  const out = lines.join('\n').trim();
  return out.length > 0 ? out : null;
}

/**
 * Write the project context into every DETECTED harness that has a project-rules
 * target. `block` targets get a managed block (preserving the user's own rules);
 * `file` targets get a dedicated opensquid file. Dedup by resolved path.
 */
export async function installProjectContextRules(
  projectRoot: string,
  home: string,
  hasBinary: (name: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectRulesReport> {
  const body = await renderProjectRulesBody(projectRoot);
  if (body === null) return { written: [] };

  const targets = await detectHarnessTargets(home, hasBinary, platform, env);
  const report: ProjectRulesReport = { written: [] };
  const done = new Set<string>();

  for (const t of targets) {
    const pt = PROJECT_RULE_TARGETS[t.harness];
    if (pt === undefined) continue; // no authoritative project path → skip
    const path = pt.path(projectRoot);
    if (done.has(path)) {
      report.written.push({ harness: t.harness, path, result: 'deduped' });
      continue;
    }
    done.add(path);
    if (pt.kind === 'block') {
      report.written.push({
        harness: t.harness,
        path,
        result: await writeManagedBlock(path, body),
      });
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${body}\n`);
      report.written.push({ harness: t.harness, path, result: 'file' });
    }
  }
  return report;
}
