/** GAC.1 — the shipped baseline asset loads and contains the 5 universal rule leads. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { AGENTS_ASSET, loadAgentsBaseline } from './agents_context.js';

describe('agents_context (GAC.1)', () => {
  it('loadAgentsBaseline returns the 5 universal rule leads', async () => {
    const body = await loadAgentsBaseline();
    for (const lead of [
      'Never guess',
      "Don't drift",
      'Report outcomes faithfully',
      'do not give much weight to development cost',
      'put each full sentence on its own line',
    ]) {
      expect(body).toContain(lead);
    }
  });

  it('the asset is shipped under context/ (in package.json files[])', async () => {
    expect(AGENTS_ASSET.replace(/\\/g, '/')).toContain('/context/AGENTS.md');
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as {
      files: string[];
    };
    expect(pkg.files).toContain('context');
  });
});
