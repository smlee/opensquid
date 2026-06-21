/**
 * Worksheet IO seam (T-scope-worksheet / wg-7d649d90f26a) — the SINGLE home for
 * reading, titling, and writing the worksheet artifact. Reused by `validate_worksheet`
 * (the soft gate), `birth_or_repoint_worksheet`, and the renderer, so the parse/serialize
 * logic has one writable home.
 *
 *   parseWorksheetContent(md)       → Worksheet | { error }   (fence-extract → YAML.parse → schema)
 *   parseWorksheet(path)            → Worksheet | { error }   (read file → parseWorksheetContent)
 *   titleOf(content)                → string                  (first `# ` H1, else a fallback)
 *   writeWorksheetFile(scopeId, ws) → string                 (write docs/worksheets/<id>-worksheet.md, return path)
 *
 * Imports from: node:fs, node:path, yaml, ../paths.js, ../../packs/schemas/worksheet.js.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

import { Worksheet } from '../../packs/schemas/worksheet.js';
import { OPENSQUID_HOME } from '../paths.js';

/** The first fenced ```yaml block of a markdown document (the worksheet's AUTHORED block). */
function extractYamlFence(md: string): string | null {
  const m = /```ya?ml\s*\n([\s\S]*?)\n```/.exec(md);
  return m?.[1] ?? null;
}

/** Validate worksheet markdown CONTENT (the effective post-write text). Returns parsed or `{ error }`. */
export function parseWorksheetContent(md: string): Worksheet | { error: string } {
  const block = extractYamlFence(md);
  if (block === null) return { error: 'no ```yaml authored block found' };
  let doc: unknown;
  try {
    doc = yamlParse(block);
  } catch (e) {
    return { error: `YAML parse failed: ${(e as Error).message}` };
  }
  const r = Worksheet.safeParse(doc);
  return r.success ? r.data : { error: r.error.issues.map((i) => i.message).join('; ') };
}

/** Read + validate a worksheet file. Returns the parsed `Worksheet` or a structured `{ error }`. */
export function parseWorksheet(path: string): Worksheet | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { error: `worksheet not readable: ${path}` };
  }
  return parseWorksheetContent(raw);
}

/** The scope summary for an auto-born single worksheet: the pre-research's first H1, else the slug. */
export function titleOf(content: string, fallbackSlug = 'scope'): string {
  const m = /^#\s+(.+?)\s*$/m.exec(content);
  return m?.[1]?.trim() ?? fallbackSlug;
}

/** Absolute path of a worksheet file for a scope id. */
export function worksheetPath(scopeId: string): string {
  return join(OPENSQUID_HOME(), 'worksheets', `${scopeId}-worksheet.md`);
}

/** Serialize the AUTHORED block to docs/worksheets/<id>-worksheet.md and return its path. */
export function writeWorksheetFile(scopeId: string, ws: Worksheet): string {
  const path = worksheetPath(scopeId);
  mkdirSync(dirname(path), { recursive: true });
  const authored = yamlStringify(ws).trimEnd();
  writeFileSync(path, `# Worksheet — ${scopeId}\n\n\`\`\`yaml\n${authored}\n\`\`\`\n`, 'utf8');
  return path;
}
