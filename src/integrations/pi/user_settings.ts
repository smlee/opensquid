import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { atomicWriteFile } from '../../runtime/atomic_write.js';
import { resolvePiGlobalSettingsPath } from './paths.js';
import { getAvailablePiProviders } from './runtime.js';

export interface PiModelSelection {
  readonly provider: string;
  readonly id: string;
}

export interface UpdatePiModelSelectionResult {
  readonly path: string;
  readonly outcome: 'unchanged' | 'updated';
  readonly selection: PiModelSelection;
}

export interface PiUserSettingsDeps {
  getAvailable: typeof getAvailablePiProviders;
  readText(path: string): Promise<string>;
  ensureDir(path: string): Promise<void>;
  writeBackup(path: string, text: string): Promise<void>;
  writeAtomic(path: string, text: string): Promise<void>;
}

const DEFAULT_DEPS: PiUserSettingsDeps = {
  getAvailable: getAvailablePiProviders,
  readText: (path) => readFile(path, 'utf8'),
  ensureDir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeBackup: (path, text) => writeFile(path, text, 'utf8'),
  writeAtomic: async (path, text) => {
    await atomicWriteFile(path, text);
  },
};

/** Explicit user action only: update Pi's own default selection while preserving every unrelated setting. */
export async function updatePiModelSelection(
  input: {
    selection: PiModelSelection;
    cli: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
  deps: PiUserSettingsDeps = DEFAULT_DEPS,
): Promise<UpdatePiModelSelectionResult> {
  const provider = input.selection.provider.trim();
  const id = input.selection.id.trim();
  if (provider === '' || id === '')
    throw new Error('Pi provider/model selection must be non-empty');
  const env = input.env ?? process.env;
  const available = await deps.getAvailable({
    cli: input.cli,
    cwd: input.cwd,
    env,
    timeoutMs: 10_000,
  });
  const models = available.get(provider);
  if (models === undefined || (models !== null && !models.has(id))) {
    throw new Error(`Pi model is unavailable: ${provider}/${id}`);
  }

  const path = resolvePiGlobalSettingsPath(env);
  let raw = '{}\n';
  try {
    raw = await deps.readText(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Pi settings must be a JSON object: ${path}`);
  }
  const current = parsed as Record<string, unknown>;
  if (current.defaultProvider === provider && current.defaultModel === id) {
    return { path, outcome: 'unchanged', selection: { provider, id } };
  }
  const next = `${JSON.stringify(
    { ...current, defaultProvider: provider, defaultModel: id },
    null,
    2,
  )}\n`;
  await deps.ensureDir(dirname(path));
  await deps.writeBackup(`${path}.bak`, raw);
  await deps.writeAtomic(path, next);
  return { path, outcome: 'updated', selection: { provider, id } };
}
