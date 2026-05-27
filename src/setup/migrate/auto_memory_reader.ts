/**
 * Parses a Claude Code auto-memory file (G.6).
 *
 * Auto-memory files live at `~/.claude/projects/<encoded-path>/memory/<name>.md`.
 * Shape: YAML frontmatter delimited by `---` lines, then a markdown body.
 *
 *   ---
 *   name: foo-bar
 *   description: "..."
 *   metadata:
 *     type: feedback | user | project | reference
 *     originSessionId: <uuid>      # optional
 *     node_type: memory            # optional
 *   ---
 *   <markdown body, may itself contain `---` separators>
 *
 * Strict Zod validation on the frontmatter; the body is preserved verbatim
 * (re-joined with `---` so embedded HRs survive the round-trip).
 *
 * No I/O beyond `fs.readFile`. No engine knowledge — purely a file-format
 * parser. The importer (auto_memory_importer.ts) is the side-effect layer.
 *
 * Imports from: node:fs, yaml, zod.
 * Imported by: auto_memory_importer.ts, auto_memory_reader.test.ts.
 */

import { promises as fs } from 'node:fs';

import yaml from 'yaml';
import { z } from 'zod';

const MemoryMetadata = z.object({
  type: z.enum(['user', 'feedback', 'project', 'reference']),
  originSessionId: z.string().optional(),
  node_type: z.string().optional(),
});

/**
 * Accept BOTH the current nested shape (`metadata: { type }`) and the LEGACY
 * flat shape (`type:` at the frontmatter top level, no `metadata:` block) —
 * older auto-memory files predate the nested convention. A `z.preprocess`
 * normalizes the flat form into `metadata` before validation, so the
 * "record everything" backfill (MAU.6) never drops a memory just because its
 * frontmatter is older. The `type` data is present either way → scope stays
 * correct (no silent mis-scope to a default).
 */
export const AutoMemoryFrontmatter = z.preprocess(
  (raw) => {
    if (raw !== null && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      if (o.metadata === undefined && o.type !== undefined) {
        return {
          ...o,
          metadata: { type: o.type, originSessionId: o.originSessionId, node_type: o.node_type },
        };
      }
    }
    return raw;
  },
  z.object({ name: z.string().min(1), description: z.string().min(1), metadata: MemoryMetadata }),
);

export type ParsedAutoMemoryFrontmatter = z.infer<typeof AutoMemoryFrontmatter>;

export interface ParsedAutoMemory {
  frontmatter: ParsedAutoMemoryFrontmatter;
  body: string;
  source_path: string;
}

/**
 * Line-scan splitter. We walk the file line-by-line and stop at the SECOND
 * `---` (the closing delimiter), then return everything after it verbatim.
 * This preserves bodies containing their own `---` thematic-break HRs —
 * the naïve `raw.split(/^---$/m)` approach would shred those out and we'd
 * never get them back.
 */
function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  const lines = raw.split('\n');
  if (lines[0] !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return null;
  return {
    yaml: lines.slice(1, closeIdx).join('\n'),
    body: lines.slice(closeIdx + 1).join('\n'),
  };
}

export async function readAutoMemory(path: string): Promise<ParsedAutoMemory> {
  const raw = await fs.readFile(path, 'utf-8');
  const split = splitFrontmatter(raw);
  if (!split) {
    throw new Error(`${path}: no YAML frontmatter (expected ---...--- block)`);
  }
  let fmObj: unknown;
  try {
    fmObj = yaml.parse(split.yaml);
  } catch (e) {
    throw new Error(`${path}: malformed YAML in frontmatter: ${(e as Error).message}`);
  }
  const parsed = AutoMemoryFrontmatter.safeParse(fmObj);
  if (!parsed.success) {
    throw new Error(`${path}: invalid frontmatter shape: ${parsed.error.message}`);
  }
  return { frontmatter: parsed.data, body: split.body.trim(), source_path: path };
}
