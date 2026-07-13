import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EffectiveContent } from './effective_content.js';

let cwd = '';

afterEach(async () => {
  if (cwd !== '') await rm(cwd, { recursive: true, force: true });
  cwd = '';
});

describe('effective_content', () => {
  it('reconstructs marked MultiEdit content with original-relative semantics', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'opensquid-effective-content-'));
    const file = join(cwd, 'note.txt');
    await writeFile(file, '\uFEFFalpha\r\nbeta\r\n');
    const result = await EffectiveContent.execute(
      {},
      {
        event: {
          kind: 'tool_call',
          tool: 'MultiEdit',
          args: {
            file_path: file,
            replacement_semantics: 'original_unique_nonoverlap',
            edits: [{ old_string: 'beta', new_string: 'BETA' }],
          },
        },
        bindings: new Map(),
        sessionId: 's',
        packId: 'p',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('\uFEFFalpha\r\nBETA\r\n');
  });
});
