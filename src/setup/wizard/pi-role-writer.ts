import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { atomicWriteFile } from '../../runtime/atomic_write.js';
import { resolveProjectScopeRoot, resolveUserScopeRoot } from '../../runtime/paths.js';
import { piToolsForCanonical } from '../../integrations/pi/capability_catalog.js';
import { resolvePiAgentPath } from '../../integrations/pi/paths.js';
import { loadPack } from '../../packs/loader.js';
import { PackV2 } from '../../packs/schemas/pack_v2.js';
import { Team, type Team as TeamType } from '../../packs/schemas/team.js';
import type { Pack } from '../../runtime/types.js';
import {
  generatedSubagentRoleName,
  renderSubagentRoleMarkdown,
} from '../../runtime/subagents/role_markdown.js';
import type { RoleManifest, SubagentRole } from '../../runtime/subagents/types.js';
import { RoleManifestSchema } from '../../runtime/subagents/types.js';

const BUILTIN_PACKS_DIR = fileURLToPath(new URL('../../../packs/builtin/', import.meta.url));

export interface PiRoleWriterDeps {
  readText(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
  ensureDir(path: string): Promise<void>;
  writeAtomic(path: string, text: string): Promise<void>;
  writeBackup(path: string, text: string): Promise<void>;
  loadPack(dir: string): Promise<Pack>;
}

const DEFAULT_DEPS: PiRoleWriterDeps = {
  readText: (path) => readFile(path, 'utf8'),
  readDir: readdir,
  ensureDir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeAtomic: atomicWriteFile,
  writeBackup: (path, text) => writeFile(path, text, 'utf8'),
  loadPack,
};

export function resolvePiRoleManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePiAgentPath(env, 'opensquid-subagent-roles.json');
}

export interface WritePiRoleManifestResult {
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly roles: readonly SubagentRole[];
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface RolePack {
  readonly name: string;
  readonly goal: string;
  readonly description: string;
  readonly procedure?: string;
  readonly skills: Pack['skills'];
  readonly models?: Pack['models'];
  readonly team?: TeamType;
}

function describeRole(pack: RolePack, roleName: string, instructions: string | undefined): string {
  const fromInstruction = instructions
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^you are\b/i.test(line));
  return fromInstruction ?? pack.description.trim().split('\n')[0] ?? `${roleName} generated role`;
}

function formatSkill(skill: { name: string; load: string; triggers: { kind: string }[] }): string {
  const triggers = skill.triggers.map((trigger) => trigger.kind).join(', ');
  return `- ${skill.name} (load: ${skill.load}; triggers: ${triggers})`;
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

async function readOptionalText(path: string, deps: PiRoleWriterDeps): Promise<string | undefined> {
  try {
    return await deps.readText(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function renderRoleBody(input: {
  role: SubagentRole;
  pack: RolePack;
  instructions: string | undefined;
  handoffSignal: string | undefined;
  rootSkillMd: string | undefined;
}): string {
  const { role, pack, instructions, handoffSignal, rootSkillMd } = input;
  const sections = [
    `# OpenSquid generated role: ${role.generatedName}`,
    `Source pack: ${pack.name}`,
    `Original role: ${role.name}`,
    '',
    '## Pack goal',
    pack.goal,
    '',
    '## Pack description',
    pack.description.trim(),
  ];
  if (handoffSignal !== undefined) {
    sections.push('', '## Handoff signal', handoffSignal);
  }
  if (instructions !== undefined && instructions.trim() !== '') {
    sections.push('', '## Role instructions', instructions.trim());
  }
  if (pack.procedure !== undefined && pack.procedure.trim() !== '') {
    sections.push('', '## Pack procedure', pack.procedure.trim());
  }
  if (rootSkillMd !== undefined && rootSkillMd.trim() !== '') {
    sections.push('', '## Root skill reference', rootSkillMd.trim());
  }
  if (pack.skills.length > 0) {
    sections.push('', '## Loaded pack skills', ...pack.skills.map(formatSkill));
  }
  return `${sections.join('\n')}\n`;
}

async function readPriorManifest(
  path: string,
  deps: PiRoleWriterDeps,
): Promise<RoleManifest | undefined> {
  try {
    return RoleManifestSchema.parse(JSON.parse(await deps.readText(path)) as unknown);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function resolveSourcePack(
  packByName: ReadonlyMap<string, { dir: string; pack: RolePack }>,
  declaredPack: string,
): { dir: string; pack: RolePack } | undefined {
  const exact = packByName.get(declaredPack);
  if (exact !== undefined) return exact;
  const fallbackName = declaredPack.split('/').filter(Boolean).at(-1);
  return fallbackName === undefined ? undefined : packByName.get(fallbackName);
}

async function loadRolePack(dir: string, deps: PiRoleWriterDeps): Promise<RolePack | null> {
  try {
    const pack = await deps.loadPack(dir);
    return {
      name: pack.name,
      goal: pack.goal,
      description: pack.description,
      ...(pack.procedure === undefined ? {} : { procedure: pack.procedure }),
      skills: pack.skills,
      ...(pack.models === undefined ? {} : { models: pack.models }),
      ...(pack.team === undefined ? {} : { team: pack.team }),
    };
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  let rawPack: string;
  try {
    rawPack = await deps.readText(join(dir, 'pack.yaml'));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  const pack = PackV2.parse(parseYaml(rawPack));
  const teamText = await readOptionalText(join(dir, 'team.yaml'), deps);
  const team = teamText === undefined ? undefined : Team.parse(parseYaml(teamText));
  let procedure: string | undefined;
  try {
    const files = (await deps.readDir(join(dir, 'procedure')))
      .filter((name) => name.endsWith('.md'))
      .sort();
    const sections = await Promise.all(
      files.map(
        async (name) =>
          `## ${name.replace(/\.md$/u, '')}\n\n${(await deps.readText(join(dir, 'procedure', name))).trim()}`,
      ),
    );
    if (sections.length > 0) procedure = sections.join('\n\n');
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return {
    name: pack.name,
    goal: `Execute the ${pack.name} workflow`,
    description: `Pack-owned workflow and executor authority for ${pack.name}.`,
    ...(procedure === undefined ? {} : { procedure }),
    skills: [],
    ...(team === undefined ? {} : { team }),
  };
}

async function activePackNames(
  cwd: string,
  deps: PiRoleWriterDeps,
): Promise<{ names: string[]; projectScope: string } | null> {
  const projectScope = await resolveProjectScopeRoot(cwd);
  if (projectScope === null) return null;
  const raw = JSON.parse(await deps.readText(join(projectScope, 'active.json'))) as unknown;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as { packs?: unknown }).packs)
  ) {
    throw new Error(`Pi role writer requires ${join(projectScope, 'active.json')} packs: string[]`);
  }
  const names = (raw as { packs: unknown[] }).packs;
  if (!names.every((name) => typeof name === 'string' && name.length > 0)) {
    throw new Error(`Pi role writer requires ${join(projectScope, 'active.json')} packs: string[]`);
  }
  return { names: names as string[], projectScope };
}

async function writeManagedFile(path: string, text: string, deps: PiRoleWriterDeps): Promise<void> {
  let current: string | undefined;
  try {
    current = await deps.readText(path);
  } catch (error) {
    if (isEnoent(error)) current = undefined;
    else throw error;
  }
  if (current === text) return;
  if (current !== undefined) await deps.writeBackup(`${path}.bak`, current);
  await deps.writeAtomic(path, text);
}

export async function writePiRoleManifest(
  input: {
    env?: NodeJS.ProcessEnv;
    builtinsDir?: string;
    cwd?: string;
    activePackNames?: readonly string[];
  } = {},
  deps: PiRoleWriterDeps = DEFAULT_DEPS,
): Promise<WritePiRoleManifestResult> {
  const env = input.env ?? process.env;
  const agentDir = resolvePiAgentPath(env, 'agents');
  const manifestPath = resolvePiRoleManifestPath(env);
  const builtinsDir = input.builtinsDir ?? BUILTIN_PACKS_DIR;
  const priorManifest = await readPriorManifest(manifestPath, deps);
  const priorByPath = new Map(priorManifest?.roles.map((role) => [role.filePath, role]) ?? []);
  const active =
    input.activePackNames !== undefined
      ? { names: [...input.activePackNames], projectScope: null }
      : input.cwd === undefined
        ? null
        : await activePackNames(input.cwd, deps);
  const names = active?.names ?? (await deps.readDir(builtinsDir)).sort();
  const packs: { dir: string; pack: RolePack }[] = [];
  for (const name of names) {
    const candidates = [
      ...(active?.projectScope === null || active?.projectScope === undefined
        ? []
        : [join(active.projectScope, 'packs', name)]),
      ...(active === null ? [] : [join(resolveUserScopeRoot(), 'packs', name)]),
      join(builtinsDir, name),
    ];
    let found: { dir: string; pack: RolePack } | null = null;
    for (const dir of candidates) {
      const pack = await loadRolePack(dir, deps);
      if (pack !== null) {
        found = { dir, pack };
        break;
      }
    }
    if (found === null) {
      if (active !== null) throw new Error(`Pi role writer could not resolve active pack ${name}`);
      continue; // support directories under packs/builtin are not pack declarations
    }
    packs.push(found);
  }
  const packByName = new Map(packs.map(({ dir, pack }) => [pack.name, { dir, pack }]));
  const roles: SubagentRole[] = [];
  const seenNames = new Set<string>();
  const seenGenerated = new Set<string>();

  for (const { pack: teamPack } of packs) {
    if (teamPack.team === undefined) continue;
    for (const teamRole of teamPack.team.roles) {
      if (seenNames.has(teamRole.name)) {
        throw new Error(`Pi role writer collision for role name ${teamRole.name}`);
      }
      seenNames.add(teamRole.name);
      const source = resolveSourcePack(packByName, teamRole.pack);
      if (source === undefined) {
        throw new Error(
          `Pi role writer could not resolve builtin source pack ${teamRole.pack} for role ${teamRole.name}`,
        );
      }
      const sourcePack = source.pack;
      const generatedName = generatedSubagentRoleName(sourcePack.name, teamRole.name);
      if (generatedName.endsWith('-') || seenGenerated.has(generatedName)) {
        throw new Error(`Pi role writer collision for generated role ${generatedName}`);
      }
      seenGenerated.add(generatedName);
      const rootSkillMd = await readOptionalText(join(source.dir, 'SKILL.md'), deps);
      const description = describeRole(sourcePack, teamRole.name, teamRole.instructions);
      if (teamRole.tools === undefined) {
        throw new Error(
          `Pi role ${teamRole.name} must declare explicit tools in ${teamPack.name}/team.yaml`,
        );
      }
      const tools = piToolsForCanonical(teamRole.tools);
      const filePath = join(agentDir, `${generatedName}.md`);
      const role: SubagentRole = {
        name: teamRole.name,
        pack: sourcePack.name,
        generatedName,
        description,
        systemPrompt: renderRoleBody({
          role: {
            name: teamRole.name,
            pack: sourcePack.name,
            generatedName,
            description,
            systemPrompt: '',
            tools,
            ...(teamRole.model_alias === undefined ? {} : { model: teamRole.model_alias }),
            filePath,
            contentHash: '0'.repeat(64),
          },
          pack: sourcePack,
          instructions: teamRole.instructions,
          handoffSignal: teamRole.handoff_signal,
          rootSkillMd,
        }),
        tools,
        ...(teamRole.model_alias === undefined ? {} : { model: teamRole.model_alias }),
        ...(sourcePack.models === undefined ? {} : { packModels: sourcePack.models }),
        filePath,
        contentHash: '0'.repeat(64),
      };
      const markdown = renderSubagentRoleMarkdown(role);
      const contentHash = sha256Hex(markdown);
      const finalizedRole: SubagentRole = { ...role, contentHash };
      const prior = priorByPath.get(filePath);
      const current = await readOptionalText(filePath, deps);
      if (current !== undefined) {
        const currentHash = sha256Hex(current);
        if (currentHash !== contentHash && prior?.contentHash !== currentHash) {
          throw new Error(`Pi role writer collision at ${filePath}`);
        }
      }
      roles.push(finalizedRole);
    }
  }

  if (roles.length === 0) throw new Error('Pi role writer found no OpenSquid profession roles');
  await deps.ensureDir(agentDir);
  for (const role of roles) {
    await writeManagedFile(role.filePath, renderSubagentRoleMarkdown(role), deps);
  }
  const manifest = RoleManifestSchema.parse({
    version: 1,
    generatedBy: 'opensquid',
    roles: roles.sort((left, right) => left.name.localeCompare(right.name)),
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestHash = sha256Hex(manifestText);
  await writeManagedFile(manifestPath, manifestText, deps);
  return { manifestPath, manifestHash, roles: manifest.roles };
}
