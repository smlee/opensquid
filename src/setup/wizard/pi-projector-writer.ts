import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { atomicWriteFile } from '../../runtime/atomic_write.js';
import { resolvePiAgentPath } from '../../integrations/pi/paths.js';

export interface PiProjectorWriteResult {
  readonly path: string;
  readonly outcome: 'created' | 'unchanged' | 'replaced';
}

/** Install the interactive Pi lifecycle projector; autonomous laps still load it explicitly in isolation. */
export async function writePiInteractiveProjector(input: {
  projectorPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PiProjectorWriteResult> {
  const path = resolvePiAgentPath(input.env ?? process.env, 'extensions', 'opensquid-projector.js');
  const source = [
    '// @opensquid managed interactive lifecycle projector',
    `export { default } from ${JSON.stringify(pathToFileURL(input.projectorPath).href)};`,
    '',
  ].join('\n');
  let prior: string | null = null;
  try {
    prior = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (prior === source) return { path, outcome: 'unchanged' };
  await mkdir(dirname(path), { recursive: true });
  if (prior !== null) await writeFile(`${path}.bak`, prior, 'utf8');
  await atomicWriteFile(path, source);
  return { path, outcome: prior === null ? 'created' : 'replaced' };
}
