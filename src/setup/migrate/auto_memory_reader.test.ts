/**
 * Unit tests for `readAutoMemory` — file-format parsing.
 *
 * Uses real tmp files (not in-memory mocks) so the round-trip behavior of
 * `fs.readFile` + the splitter regex stays honest. All side effects scoped
 * to vitest's tmp dir; afterEach scrubs.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAutoMemory } from './auto_memory_reader.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-reader-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(file: string, contents: string): Promise<string> {
  const path = join(dir, file);
  await fs.writeFile(path, contents, 'utf-8');
  return path;
}

describe('readAutoMemory', () => {
  it('parses valid frontmatter + body', async () => {
    const path = await write(
      'feedback_x.md',
      `---
name: feedback-x
description: "rule statement"
metadata:
  type: feedback
  originSessionId: abc-123
  node_type: memory
---
body line 1
body line 2
`,
    );
    const out = await readAutoMemory(path);
    expect(out.frontmatter.name).toBe('feedback-x');
    expect(out.frontmatter.description).toBe('rule statement');
    expect(out.frontmatter.metadata.type).toBe('feedback');
    expect(out.frontmatter.metadata.originSessionId).toBe('abc-123');
    expect(out.frontmatter.metadata.node_type).toBe('memory');
    expect(out.body).toBe('body line 1\nbody line 2');
    expect(out.source_path).toBe(path);
  });

  it('throws with file path when frontmatter is missing', async () => {
    const path = await write('plain.md', '# just a markdown file\nno yaml here\n');
    await expect(readAutoMemory(path)).rejects.toThrow(path);
    await expect(readAutoMemory(path)).rejects.toThrow(/no YAML frontmatter/);
  });

  it('throws with file path when YAML is malformed', async () => {
    const path = await write(
      'bad.md',
      `---
name: x
description: "y
metadata:
  type: feedback
---
body
`,
    );
    await expect(readAutoMemory(path)).rejects.toThrow(path);
  });

  it('throws when frontmatter shape is invalid (missing required field)', async () => {
    const path = await write(
      'bad.md',
      `---
description: "no name"
metadata:
  type: feedback
---
body
`,
    );
    await expect(readAutoMemory(path)).rejects.toThrow(path);
    await expect(readAutoMemory(path)).rejects.toThrow(/invalid frontmatter shape/);
  });

  it('rejects unknown metadata.type values via Zod enum', async () => {
    const path = await write(
      'bad.md',
      `---
name: x
description: y
metadata:
  type: bogus
---
body
`,
    );
    await expect(readAutoMemory(path)).rejects.toThrow(path);
  });

  it('preserves body containing --- thematic-break separators verbatim', async () => {
    const path = await write(
      'fancy.md',
      `---
name: fancy
description: d
metadata:
  type: user
---
intro

---

section after a horizontal rule

---

final section
`,
    );
    const out = await readAutoMemory(path);
    expect(out.body).toBe(
      [
        'intro',
        '',
        '---',
        '',
        'section after a horizontal rule',
        '',
        '---',
        '',
        'final section',
      ].join('\n'),
    );
  });

  it('tolerates optional metadata fields being absent', async () => {
    const path = await write(
      'minimal.md',
      `---
name: minimal
description: d
metadata:
  type: project
---
body
`,
    );
    const out = await readAutoMemory(path);
    expect(out.frontmatter.metadata.originSessionId).toBeUndefined();
    expect(out.frontmatter.metadata.node_type).toBeUndefined();
  });

  it('accepts the LEGACY flat frontmatter (top-level type, no metadata block)', async () => {
    // Older auto-memory files predate the nested `metadata:` convention — they
    // carry `type:` (and optional originSessionId) at the top level. MAU.6: the
    // reader normalizes these so the backfill records them (record everything).
    const path = await write(
      'legacy.md',
      `---
name: legacy
description: d
type: feedback
originSessionId: abc-123
---
body
`,
    );
    const out = await readAutoMemory(path);
    expect(out.frontmatter.metadata.type).toBe('feedback');
    expect(out.frontmatter.metadata.originSessionId).toBe('abc-123');
  });
});
