/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRoleManifest, resolveManifestRole } from '../../runtime/subagents/roles.js';
import { writePiRoleManifest } from './pi-role-writer.js';
import type { Pack, Skill } from '../../runtime/types.js';

function pack(overrides: Partial<Pack> & Pick<Pack, 'name' | 'goal' | 'description'>): Pack {
  return {
    version: '0.1.0',
    scope: 'workflow',
    skills: [],
    ...overrides,
  } as Pack;
}

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('writePiRoleManifest', () => {
  it('generates namespaced roles from the declared source pack, not the container team pack', async () => {
    const files = new Map<string, string>([['/builtin/source-pack/SKILL.md', '# source skill']]);
    const writes = new Map<string, string>();
    const deps = {
      readText: async (path: string) => {
        const value = writes.get(path) ?? files.get(path);
        if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return value;
      },
      readDir: async () => ['container-pack', 'source-pack'],
      ensureDir: async () => undefined,
      writeAtomic: async (path: string, text: string) => {
        writes.set(path, text);
      },
      writeBackup: async (path: string, text: string) => {
        writes.set(path, text);
      },
      loadPack: async (dir: string) => {
        if (dir.endsWith('container-pack')) {
          return pack({
            name: 'container-pack',
            goal: 'container goal',
            description: 'container desc',
            team: {
              name: 'scope-team',
              roles: [
                {
                  name: 'scope-architect',
                  pack: 'source-pack',
                  model_alias: 'reasoning',
                  tools: [
                    'Read',
                    'Bash',
                    'Grep',
                    'Write',
                    'mcp__opensquid__workgraph_get',
                    'mcp__opensquid__recall',
                    'mcp__opensquid__read_state',
                    'mcp__opensquid__web_fetch',
                  ],
                  handoff_signal: 'SCOPE_COMPLETE',
                  instructions: 'No tool calls outside Read + Write + Bash for docs/.',
                },
              ],
            },
          });
        }
        return pack({
          name: 'source-pack',
          goal: 'author scope artifacts',
          description: 'Source discipline pack',
          team: undefined,
          models: {
            reasoning: {
              mode: 'subscription',
              provider: 'openai',
              model: 'gpt-5',
              description: '',
              args: [],
            },
          },
          skills: [
            {
              name: 'scope-detect',
              load: 'lazy',
              requires: [],
              when_to_load: [],
              unloads_when: [],
              triggers: [{ kind: 'tool_call' }],
              rules: [],
            } satisfies Skill,
          ],
        });
      },
    };

    const result = await writePiRoleManifest(
      { env: { HOME: '/home/test' }, builtinsDir: '/builtin' },
      deps,
    );

    expect(result.manifestPath).toBe('/home/test/.pi/agent/opensquid-subagent-roles.json');
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]?.pack).toBe('source-pack');
    expect(result.roles[0]?.generatedName).toBe('opensquid-source-pack-scope-architect');
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.roles[0]?.tools).toEqual([
      'read',
      'bash',
      'grep',
      'write',
      'workgraph_get',
      'recall',
      'read_state',
      'web_fetch',
    ]);
    const roleFile = writes.get(
      '/home/test/.pi/agent/agents/opensquid-source-pack-scope-architect.md',
    );
    expect(roleFile).toContain('name: opensquid-source-pack-scope-architect');
    expect(roleFile).toContain('Source pack: source-pack');
    expect(roleFile).toContain('# source skill');
    const manifestFile = writes.get('/home/test/.pi/agent/opensquid-subagent-roles.json');
    expect(manifestFile).toContain('opensquid-source-pack-scope-architect');
    expect(manifestFile).toContain('"packModels"');
  });

  it('rejects duplicate API names, duplicate generated names, and unrelated preexisting files', async () => {
    const baseDeps = {
      readText: async (path: string) => {
        if (path === '/home/test/.pi/agent/agents/opensquid-source-pack-scope-architect.md') {
          return 'user-authored';
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readDir: async () => ['container-pack', 'source-pack'],
      ensureDir: async () => undefined,
      writeAtomic: async () => undefined,
      writeBackup: async () => undefined,
      loadPack: async (dir: string) => {
        if (dir.endsWith('source-pack')) {
          return pack({ name: 'source-pack', goal: 'g', description: 'd' });
        }
        return pack({
          name: 'container-pack',
          goal: 'g',
          description: 'd',
          team: {
            name: 't',
            roles: [
              { name: 'same role', pack: 'source-pack', model_alias: 'reasoning', tools: ['Read'] },
              { name: 'same role', pack: 'source-pack', model_alias: 'reasoning', tools: ['Read'] },
            ],
          },
        });
      },
    };

    await expect(
      writePiRoleManifest({ env: { HOME: '/home/test' }, builtinsDir: '/builtin' }, baseDeps),
    ).rejects.toThrow(/role name/);

    const generatedCollisionDeps = {
      ...baseDeps,
      loadPack: async (dir: string) => {
        if (dir.endsWith('source-pack')) {
          return pack({ name: 'source-pack', goal: 'g', description: 'd' });
        }
        return pack({
          name: 'container-pack',
          goal: 'g',
          description: 'd',
          team: {
            name: 't',
            roles: [
              { name: 'same role', pack: 'source-pack', model_alias: 'reasoning', tools: ['Read'] },
              { name: 'same-role', pack: 'source-pack', model_alias: 'reasoning', tools: ['Read'] },
            ],
          },
        });
      },
    };
    await expect(
      writePiRoleManifest(
        { env: { HOME: '/home/test' }, builtinsDir: '/builtin' },
        generatedCollisionDeps,
      ),
    ).rejects.toThrow(/generated role/);

    const fileCollisionDeps = {
      ...baseDeps,
      loadPack: async (dir: string) => {
        if (dir.endsWith('source-pack')) {
          return pack({ name: 'source-pack', goal: 'g', description: 'd' });
        }
        return pack({
          name: 'container-pack',
          goal: 'g',
          description: 'd',
          team: {
            name: 't',
            roles: [
              {
                name: 'scope-architect',
                pack: 'source-pack',
                model_alias: 'reasoning',
                tools: ['Read'],
              },
            ],
          },
        });
      },
    };
    await expect(
      writePiRoleManifest(
        { env: { HOME: '/home/test' }, builtinsDir: '/builtin' },
        fileCollisionDeps,
      ),
    ).rejects.toThrow(/collision/);
  });

  it('round-trips the actual builtin role writer in an isolated Pi dir', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opensquid-pi-role-writer-'));
    cleanup.push(home);
    const result = await writePiRoleManifest({ env: { HOME: home } });
    expect(result.roles.length).toBeGreaterThan(0);
    const manifest = await loadRoleManifest(result.manifestPath);
    const firstRole = result.roles[0]!;
    await expect(
      resolveManifestRole(manifest, firstRole.name, undefined, result.manifestPath),
    ).resolves.toMatchObject({
      generatedName: firstRole.generatedName,
    });
    const written = await readFile(firstRole.filePath, 'utf8');
    expect(written).toContain(`# OpenSquid generated role: ${firstRole.generatedName}`);
  });

  it('projects the active fullstack-flow implementation role without a model override or recursive spawn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opensquid-pi-fullstack-role-'));
    cleanup.push(home);
    const result = await writePiRoleManifest({
      env: { HOME: home },
      activePackNames: ['fullstack-flow'],
    });
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]).toMatchObject({
      name: 'fullstack-executor',
      pack: 'fullstack-flow',
      generatedName: 'opensquid-fullstack-flow-fullstack-executor',
    });
    expect(result.roles[0]?.model).toBeUndefined();
    expect(result.roles[0]?.tools).toContain('edit');
    expect(result.roles[0]?.tools).not.toContain('spawn_subagent');
  });

  it('fails loud on source-pack parse/read errors and only swallows ENOENT for optional reads', async () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const deps = {
      readText: async (path: string) => {
        if (path.endsWith('SKILL.md')) throw eacces;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readDir: async () => ['container-pack', 'source-pack'],
      ensureDir: async () => undefined,
      writeAtomic: async () => undefined,
      writeBackup: async () => undefined,
      loadPack: async (dir: string) => {
        if (dir.endsWith('source-pack')) {
          throw eacces;
        }
        return pack({
          name: 'container-pack',
          goal: 'g',
          description: 'd',
          team: {
            name: 't',
            roles: [{ name: 'r', pack: 'source-pack', model_alias: 'reasoning', tools: ['Read'] }],
          },
        });
      },
    };
    await expect(
      writePiRoleManifest({ env: { HOME: '/home/test' }, builtinsDir: '/builtin' }, deps),
    ).rejects.toBe(eacces);
  });
});
