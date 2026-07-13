import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { findPiCapability } from '../../integrations/pi/capability_catalog.js';
import { generatedSubagentRoleName, renderSubagentRoleMarkdown } from './role_markdown.js';
import {
  type RoleManifest,
  RoleManifestSchema,
  type SubagentRole,
  type SubagentTask,
  type ValidatedSubagentTask,
} from './types.js';

export interface RoleFsDeps {
  readText(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
}

const DEFAULT_DEPS: RoleFsDeps = {
  readText: (path) => readFile(path, 'utf8'),
  realpath,
};

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function containsPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function assertCanonicalRoleMetadata(role: SubagentRole): void {
  const expectedGeneratedName = generatedSubagentRoleName(role.pack, role.name);
  if (role.generatedName !== expectedGeneratedName) {
    throw new Error(
      `Role manifest namespace mismatch for ${role.name}: expected ${expectedGeneratedName}, found ${role.generatedName}`,
    );
  }
  const tools = new Set(role.tools);
  if (tools.size !== role.tools.length) {
    throw new Error(`Role manifest collision: duplicate tool authority in ${role.generatedName}`);
  }
  for (const tool of tools) {
    if (findPiCapability(tool) === undefined || tool === 'spawn_subagent') {
      throw new Error(
        `Role manifest has unmapped or recursive tool ${tool} in ${role.generatedName}`,
      );
    }
  }
}

function expectedRoleFilePath(manifestPath: string, role: SubagentRole): string {
  return join(resolve(dirname(manifestPath), 'agents'), `${role.generatedName}.md`);
}

function validateLoadedRoleManifest(manifestPath: string, text: string): RoleManifest {
  const parsed = JSON.parse(text) as unknown;
  const manifest = RoleManifestSchema.parse(parsed);
  const byName = new Set<string>();
  const byGeneratedName = new Set<string>();
  for (const role of manifest.roles) {
    if (byName.has(role.name)) {
      throw new Error(`Role manifest collision: duplicate role name ${role.name}`);
    }
    byName.add(role.name);
    if (byGeneratedName.has(role.generatedName)) {
      throw new Error(`Role manifest collision: duplicate generatedName ${role.generatedName}`);
    }
    byGeneratedName.add(role.generatedName);
    assertCanonicalRoleMetadata(role);
    if (resolve(role.filePath) !== expectedRoleFilePath(manifestPath, role)) {
      throw new Error(`Role manifest path mismatch for ${role.generatedName}`);
    }
  }
  return manifest;
}

export async function loadRoleManifest(
  manifestPath: string,
  deps: RoleFsDeps = DEFAULT_DEPS,
): Promise<RoleManifest> {
  return validateLoadedRoleManifest(manifestPath, await deps.readText(manifestPath));
}

export async function loadVerifiedRoleManifest(
  manifestPath: string,
  expectedHash: string,
  deps: RoleFsDeps = DEFAULT_DEPS,
): Promise<RoleManifest> {
  const text = await deps.readText(manifestPath);
  const actualHash = sha256Hex(text);
  if (actualHash !== expectedHash) {
    throw new Error(`Role manifest hash mismatch for ${manifestPath}`);
  }
  return validateLoadedRoleManifest(manifestPath, text);
}

export async function validateManifestRoleFile(
  role: SubagentRole,
  deps: RoleFsDeps = DEFAULT_DEPS,
  manifestPath?: string,
): Promise<void> {
  if (manifestPath !== undefined) {
    const lexicalAgentsRoot = resolve(dirname(manifestPath), 'agents');
    const lexicalRolePath = expectedRoleFilePath(manifestPath, role);
    if (resolve(role.filePath) !== lexicalRolePath) {
      throw new Error(`Role manifest path mismatch for ${role.generatedName}`);
    }
    const [realAgentsRoot, realRolePath] = await Promise.all([
      deps.realpath(lexicalAgentsRoot),
      deps.realpath(role.filePath),
    ]);
    if (!containsPath(realAgentsRoot, realRolePath)) {
      throw new Error(`Role manifest path escapes Pi agents root for ${role.generatedName}`);
    }
  }
  const content = await deps.readText(role.filePath);
  const expected = renderSubagentRoleMarkdown(role);
  if (content !== expected) {
    throw new Error(`Role manifest bytes mismatch for ${role.name}`);
  }
  const actual = sha256Hex(content);
  if (actual !== role.contentHash) {
    throw new Error(`Role manifest hash mismatch for ${role.name}`);
  }
}

export async function resolveManifestRole(
  manifest: RoleManifest,
  roleName: string,
  deps: RoleFsDeps = DEFAULT_DEPS,
  manifestPath?: string,
): Promise<SubagentRole> {
  const role = manifest.roles.find((entry) => entry.name === roleName);
  if (role === undefined) throw new Error(`Unknown generated subagent role: ${roleName}`);
  await validateManifestRoleFile(role, deps, manifestPath);
  return role;
}

export async function resolveContainedCwd(
  projectRoot: string,
  requestedCwd: string | undefined,
  deps: RoleFsDeps = DEFAULT_DEPS,
): Promise<string> {
  const realRoot = await deps.realpath(projectRoot);
  const absolute = requestedCwd === undefined ? realRoot : resolve(realRoot, requestedCwd);
  const realCandidate = await deps.realpath(absolute);
  if (!containsPath(realRoot, realCandidate)) {
    throw new Error(`Subagent cwd escapes project root: ${requestedCwd ?? realCandidate}`);
  }
  return realCandidate;
}

export async function validateTaskAgainstManifest(
  manifest: RoleManifest,
  projectRoot: string,
  task: SubagentTask,
  deps: RoleFsDeps = DEFAULT_DEPS,
  manifestPath?: string,
): Promise<ValidatedSubagentTask> {
  const role = await resolveManifestRole(manifest, task.role, deps, manifestPath);
  const cwd = await resolveContainedCwd(projectRoot, task.cwd, deps);
  return Object.freeze({ role, task: task.task, cwd });
}
