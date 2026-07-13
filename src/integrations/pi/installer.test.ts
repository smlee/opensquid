import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePiAdapter, PI_MCP_ADAPTER_PACKAGE } from './installer.js';
import { resolvePiAdapterEntry, resolvePiManagedNpmPackageDir } from './paths.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-pi-installer-'));
  env = { PI_CODING_AGENT_DIR: join(dir, 'agent') };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedVersion(version: string, targetEnv = env): Promise<void> {
  const pkgDir = resolvePiManagedNpmPackageDir(PI_MCP_ADAPTER_PACKAGE, targetEnv);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ version }), 'utf8');
}

const readText = (path: string): Promise<string> =>
  import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'));

describe('ensurePiAdapter', () => {
  it('accepts an installed adapter without enforcing or replacing its version', async () => {
    await seedVersion('9.4.1');
    const deps = { readText, runPi: vi.fn() };
    const result = await ensurePiAdapter({ cli: 'pi', cwd: dir, env }, deps);
    expect(deps.runPi).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      adapterEntry: resolvePiAdapterEntry(PI_MCP_ADAPTER_PACKAGE, env),
      version: '9.4.1',
      installed: false,
    });
  });

  it('installs the unversioned adapter package only when it is missing', async () => {
    const deps = {
      readText,
      runPi: vi.fn(async () => {
        await seedVersion('3.0.0');
      }),
    };
    const result = await ensurePiAdapter({ cli: 'pi', cwd: dir, env }, deps);
    expect(deps.runPi).toHaveBeenCalledWith(
      ['install', `npm:${PI_MCP_ADAPTER_PACKAGE}`],
      expect.objectContaining({ cwd: dir }),
    );
    expect(result).toMatchObject({ version: '3.0.0', installed: true });
  });

  it('honors PI_CODING_AGENT_DIR for the managed install path', async () => {
    const customEnv = { PI_CODING_AGENT_DIR: join(dir, 'alt-agent') };
    const deps = {
      readText,
      runPi: vi.fn(async () => {
        await seedVersion('4.2.0', customEnv);
      }),
    };
    const result = await ensurePiAdapter({ cli: 'pi', cwd: dir, env: customEnv }, deps);
    expect(result.packageDir).toBe(
      resolvePiManagedNpmPackageDir(PI_MCP_ADAPTER_PACKAGE, customEnv),
    );
  });

  it('fails loud when installation does not produce a discoverable adapter', async () => {
    const deps = { readText, runPi: vi.fn(() => Promise.resolve()) };
    await expect(ensurePiAdapter({ cli: 'pi', cwd: dir, env }, deps)).rejects.toThrow(
      'is unavailable',
    );
  });
});
