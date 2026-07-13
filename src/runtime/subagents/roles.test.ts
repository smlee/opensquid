import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadRoleManifest,
  loadVerifiedRoleManifest,
  resolveContainedCwd,
  resolveManifestRole,
  sha256Hex,
  validateTaskAgainstManifest,
} from './roles.js';
import { renderSubagentRoleMarkdown } from './role_markdown.js';
import type { RoleManifest } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opensquid-subagent-roles-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedManifest(
  overrides: Partial<RoleManifest['roles'][number]> = {},
): Promise<{ manifestPath: string; manifest: RoleManifest; rolePath: string }> {
  const rolePath = join(root, 'agents', 'opensquid-source-pack-scope-architect.md');
  await mkdir(join(root, 'agents'), { recursive: true });
  const role = {
    name: 'scope-architect',
    pack: 'source-pack',
    generatedName: 'opensquid-source-pack-scope-architect',
    description: 'scope role',
    systemPrompt: '# prompt\n',
    tools: ['read', 'bash', 'grep', 'write', 'workgraph_get', 'recall', 'read_state', 'web_fetch'],
    model: 'reasoning',
    filePath: rolePath,
    contentHash: '0'.repeat(64),
    ...overrides,
  };
  const content = renderSubagentRoleMarkdown(role);
  await writeFile(role.filePath, content, 'utf8');
  const manifest: RoleManifest = {
    version: 1,
    generatedBy: 'opensquid',
    roles: [{ ...role, contentHash: sha256Hex(content) }],
  };
  const manifestPath = join(root, 'opensquid-subagent-roles.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifestPath, manifest, rolePath: role.filePath };
}

describe('subagent role manifest', () => {
  it('round-trips the manifest and resolves generated roles only', async () => {
    const { manifestPath } = await seedManifest();
    const manifest = await loadRoleManifest(manifestPath);
    await expect(
      resolveManifestRole(manifest, 'scope-architect', undefined, manifestPath),
    ).resolves.toMatchObject({
      generatedName: 'opensquid-source-pack-scope-architect',
    });
    await expect(
      resolveManifestRole(manifest, 'arbitrary-user-role', undefined, manifestPath),
    ).rejects.toThrow(/Unknown generated subagent role/);
  });

  it('rejects duplicate API names, duplicate generated names, tamper, arbitrary tools, namespace drift, and manifest hash tamper after preflight', async () => {
    const { manifestPath, rolePath, manifest } = await seedManifest();
    await writeFile(rolePath, 'tampered', 'utf8');
    await expect(
      resolveManifestRole(
        await loadRoleManifest(manifestPath),
        'scope-architect',
        undefined,
        manifestPath,
      ),
    ).rejects.toThrow(/bytes mismatch/);

    const collisionPath = join(root, 'collision.json');
    await writeFile(
      collisionPath,
      JSON.stringify({
        ...manifest,
        roles: [
          manifest.roles[0],
          {
            ...manifest.roles[0],
            name: 'scope-architect',
            generatedName: 'opensquid-source-pack-other',
            filePath: join(root, 'agents', 'opensquid-source-pack-other.md'),
          },
        ],
      }),
      'utf8',
    );
    await expect(loadRoleManifest(collisionPath)).rejects.toThrow(/duplicate role name/);

    const foreignToolsPath = join(root, 'foreign-tools.json');
    await writeFile(
      foreignToolsPath,
      JSON.stringify({
        ...manifest,
        roles: [{ ...manifest.roles[0], tools: [...manifest.roles[0]!.tools, 'spawn_subagent'] }],
      }),
      'utf8',
    );
    await expect(loadRoleManifest(foreignToolsPath)).rejects.toThrow(/unmapped or recursive tool/);

    const namespacePath = join(root, 'namespace.json');
    await writeFile(
      namespacePath,
      JSON.stringify({
        ...manifest,
        roles: [{ ...manifest.roles[0], generatedName: 'opensquid-wrong-name' }],
      }),
      'utf8',
    );
    await expect(loadRoleManifest(namespacePath)).rejects.toThrow(/namespace mismatch/);

    const tamperedRole = {
      ...manifest.roles[0]!,
      description: 'tampered role',
      systemPrompt: '# tampered\n',
      filePath: join(root, 'agents', 'opensquid-source-pack-scope-architect.md'),
    };
    const tamperedRoleContent = renderSubagentRoleMarkdown(tamperedRole);
    await writeFile(tamperedRole.filePath, tamperedRoleContent, 'utf8');
    const tamperedManifest = {
      ...manifest,
      roles: [{ ...tamperedRole, contentHash: sha256Hex(tamperedRoleContent) }],
    };
    await writeFile(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`, 'utf8');
    await expect(
      loadVerifiedRoleManifest(manifestPath, sha256Hex(`${JSON.stringify(manifest, null, 2)}\n`)),
    ).rejects.toThrow(/manifest hash mismatch/);
  });

  it('rejects path collisions, symlink escapes, and non-canonical file locations', async () => {
    const seeded = await seedManifest();
    const outside = join(root, 'outside.md');
    await writeFile(outside, renderSubagentRoleMarkdown(seeded.manifest.roles[0]!), 'utf8');
    const symlinkPath = seeded.manifest.roles[0]!.filePath;
    await rm(symlinkPath);
    await symlink(outside, symlinkPath);
    const manifest = await loadRoleManifest(seeded.manifestPath);
    await expect(
      resolveManifestRole(manifest, 'scope-architect', undefined, seeded.manifestPath),
    ).rejects.toThrow(/escapes Pi agents root/);

    const arbitraryPath = join(root, 'arbitrary.json');
    await writeFile(
      arbitraryPath,
      JSON.stringify({
        ...seeded.manifest,
        roles: [{ ...seeded.manifest.roles[0], filePath: join(root, 'elsewhere.md') }],
      }),
      'utf8',
    );
    await expect(loadRoleManifest(arbitraryPath)).rejects.toThrow(/path mismatch/);
  });
});

describe('contained cwd validation', () => {
  it('accepts the project root and contained descendants', async () => {
    const projectRoot = join(root, 'project');
    const child = join(projectRoot, 'docs');
    await mkdir(child, { recursive: true });
    await expect(resolveContainedCwd(projectRoot, undefined)).resolves.toBe(
      await realpath(projectRoot),
    );
    await expect(resolveContainedCwd(projectRoot, 'docs')).resolves.toBe(await realpath(child));
  });

  it('rejects traversal and symlink escape after realpath resolution', async () => {
    const projectRoot = join(root, 'project');
    const outside = join(root, 'outside');
    const inside = join(projectRoot, 'inside');
    const link = join(projectRoot, 'link-out');
    await mkdir(inside, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, link, 'dir');

    await expect(resolveContainedCwd(projectRoot, '../outside')).rejects.toThrow(/escapes/);
    await expect(resolveContainedCwd(projectRoot, 'link-out')).rejects.toThrow(/escapes/);
  });

  it('validates a full task against the manifest and contained cwd', async () => {
    const projectRoot = join(root, 'project');
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const { manifest, manifestPath } = await seedManifest();
    await expect(
      validateTaskAgainstManifest(
        manifest,
        projectRoot,
        {
          role: 'scope-architect',
          task: 'write docs',
          cwd: 'src',
        },
        undefined,
        manifestPath,
      ),
    ).resolves.toMatchObject({ cwd: await realpath(join(projectRoot, 'src')) });
  });
});
