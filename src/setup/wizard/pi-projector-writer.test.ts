import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writePiInteractiveProjector } from './pi-projector-writer.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('writePiInteractiveProjector', () => {
  it('writes an idempotent managed shim without changing Pi provider/model settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opensquid-pi-projector-'));
    cleanup.push(dir);
    const input = {
      projectorPath: '/package/dist/integrations/pi/projector.js',
      env: { PI_CODING_AGENT_DIR: dir },
    };
    await expect(writePiInteractiveProjector(input)).resolves.toMatchObject({ outcome: 'created' });
    await expect(writePiInteractiveProjector(input)).resolves.toMatchObject({
      outcome: 'unchanged',
    });
    const text = await readFile(join(dir, 'extensions', 'opensquid-projector.js'), 'utf8');
    expect(text).toContain('@opensquid managed interactive lifecycle projector');
    expect(text).toContain('file:///package/dist/integrations/pi/projector.js');
  });
});
