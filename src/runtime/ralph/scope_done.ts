import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { resolveActorId } from '../actor_id.js';
import { resolveLocalStoreDir } from '../paths.js';
import { workGraphStore } from '../../workgraph/store.js';
import { upsertTaskStage } from './loop_stage.js';

export interface CompleteScopeResult {
  readonly wgId: string;
  readonly artifact: string;
  readonly stage: 'scope_write';
}

export interface CompleteScopeDeps {
  assertOpen(wgId: string, cwd: string): Promise<void>;
  advance(wgId: string, artifact: string): Promise<void>;
}

const DEFAULT_DEPS: CompleteScopeDeps = {
  assertOpen: async (wgId, cwd) => {
    const dir = await resolveLocalStoreDir(cwd);
    const store = workGraphStore({
      dbUrl: `file:${join(dir, 'workgraph.db')}`,
      sourceDir: join(dir, 'store', 'issues'),
      actorId: await resolveActorId(),
    });
    await store.init();
    const issue = await store.getIssue(wgId);
    if (issue?.status !== 'open') {
      throw new Error(`scope-done requires an open WorkGraph item: ${wgId}`);
    }
  },
  advance: (wgId, artifact) => upsertTaskStage(wgId, 'scope_write', Date.now(), artifact),
};

/** Human scope-exit boundary shared by CLI, Pi command, and future TUI/web actions. */
export async function completeInteractiveScope(
  input: {
    wgId: string;
    artifact: string;
    cwd?: string;
  },
  deps: CompleteScopeDeps = DEFAULT_DEPS,
): Promise<CompleteScopeResult> {
  const cwd = await realpath(input.cwd ?? process.cwd());
  const artifact = await realpath(resolve(cwd, input.artifact));
  if (artifact !== cwd && !artifact.startsWith(`${cwd}${sep}`)) {
    throw new Error(`scope artifact escapes the project: ${input.artifact}`);
  }
  await deps.assertOpen(input.wgId, cwd);
  await deps.advance(input.wgId, artifact);
  return { wgId: input.wgId, artifact, stage: 'scope_write' };
}
