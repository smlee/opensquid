/**
 * Automation buffer pattern — file-driven, session-scoped, append-only sink
 * for lesson candidates captured during full-automation runs.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Automation buffer
 * pattern" + §"Directory layout" + §"Four buffer categories" +
 * `project_opensquid_automation_buffer_pattern` (memory).
 *
 * The buffer resolves the conflict between full-automation throughput and
 * the wedge gate's capture-time validation requirement: during automation,
 * the agent dumps candidate lessons into one of four category subdirs and
 * appends a one-line index entry to `BUFFER.md`. At end-of-automation, the
 * user walks the buffer through the cycle (triage → validate → persist →
 * proceed) — nothing auto-promotes silently.
 *
 * Layout produced:
 *
 *   ~/.opensquid/sessions/<id>/pending-lessons/
 *     potential-lessons/   <ts>_<id>.md
 *     keep-as-context/     <ts>_<id>.md
 *     preferences/         <ts>_<id>.md
 *     new-rag-pointers/    <ts>_<id>.md
 *     BUFFER.md            ← chronological index, one bullet per write
 *
 * Atomic write: tmp + rename pattern. If the process crashes mid-write, the
 * `.tmp` file remains on disk (no partial reads), and the canonical filename
 * never appeared — so `walkBuffer` skips the half-written entry. BUFFER.md
 * is intentionally non-atomic (append-only) — its job is human-readable
 * progress, not source-of-truth. Source of truth is the per-entry file.
 *
 * Frontmatter parser: minimal regex-based, single-line string fields only.
 * No nesting, no dates, no anchors — `gray-matter` would be overkill (per
 * risk callout 1). The shape is locked at write-time, so the parser only
 * needs to handle what we ourselves emit. The `sourceContext` multiline
 * value uses YAML's `|-` block scalar (literal, strip-final-newline) with
 * two-space indentation — the parser strips the leading indent on read.
 *
 * Imports from: node:fs/promises, node:path, ./capture, ./types.
 * Imported by: src/runtime/wedge/index.ts, end-of-automation cycle UI.
 */

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pendingLessonsDir, safeTimestamp } from './capture.js';

// ---------------------------------------------------------------------------
// BufferCategory — the four sinks per §"Four buffer categories".
//
// `potential-lessons` — candidate lessons (workflow / preference / skill).
// `keep-as-context`   — context-worthy facts that don't rise to "lesson".
// `preferences`       — pure preferences caught as a separate stream.
// `new-rag-pointers`  — RAG search hits the agent wants the user to review.
//
// The ordering of this list is also the walk order (potential-lessons first
// because the cycle's triage step is the highest-leverage walk).
// ---------------------------------------------------------------------------

export type BufferCategory =
  | 'potential-lessons'
  | 'keep-as-context'
  | 'preferences'
  | 'new-rag-pointers';

const CATEGORY_ORDER: readonly BufferCategory[] = [
  'potential-lessons',
  'keep-as-context',
  'preferences',
  'new-rag-pointers',
] as const;

// ---------------------------------------------------------------------------
// BufferEntry — on-disk shape.
//
// `id`            — caller-supplied unique id (filename component).
// `category`      — one of the four above.
// `body`          — Markdown body (LLM-facing notes, links, code snippets).
// `frontmatter`   — strict-shape header read back by `parseEntry`.
//                   `timestamp` orders writes; `proposedCategory` records the
//                   classifier's call (may differ from `category` if the user
//                   later moves the file between subdirs); `sourceContext`
//                   captures the conversational context at capture time;
//                   `confidence` is the classifier's 0..1 score.
// ---------------------------------------------------------------------------

export interface BufferEntry {
  id: string;
  category: BufferCategory;
  body: string;
  frontmatter: {
    timestamp: string;
    proposedCategory: string;
    sourceContext: string;
    confidence: number;
  };
}

// ---------------------------------------------------------------------------
// bufferDir — public so tests + callers can resolve sibling paths
// (e.g. BUFFER.md) without duplicating the layout.
// ---------------------------------------------------------------------------

export function bufferDir(sessionId: string): string {
  return pendingLessonsDir(sessionId);
}

// ---------------------------------------------------------------------------
// appendBufferEntry — write an entry atomically + update BUFFER.md index.
//
// Failure semantics: if `rename` fails (target locked, fs full, etc.), the
// `.tmp` file is left on disk for inspection. The BUFFER.md append is skipped
// in that path — the index never references a non-existent file.
// ---------------------------------------------------------------------------

export async function appendBufferEntry(sessionId: string, entry: BufferEntry): Promise<string> {
  const dir = join(bufferDir(sessionId), entry.category);
  await mkdir(dir, { recursive: true });

  const safeTs = safeTimestamp(entry.frontmatter.timestamp);
  const filename = `${safeTs}_${entry.id}.md`;
  const path = join(dir, filename);
  const tmp = `${path}.tmp`;

  // Format frontmatter. `sourceContext` may contain newlines — emit as YAML
  // block scalar with `|-` (literal, strip trailing newline) and 2-space
  // indent. Empty strings emit as `''`.
  const ctxLines = entry.frontmatter.sourceContext.split('\n');
  const ctxBlock =
    entry.frontmatter.sourceContext.length === 0
      ? "''"
      : '|-\n' + ctxLines.map((l) => '  ' + l).join('\n');

  const fm = [
    '---',
    `id: ${entry.id}`,
    `timestamp: ${entry.frontmatter.timestamp}`,
    `proposedCategory: ${entry.frontmatter.proposedCategory}`,
    `confidence: ${entry.frontmatter.confidence}`,
    `sourceContext: ${ctxBlock}`,
    '---',
    '',
    entry.body,
    '',
  ].join('\n');

  // Atomic: write tmp, then rename. Rename is atomic on POSIX + NTFS.
  await writeFile(tmp, fm, 'utf8');
  await rename(tmp, path);

  // BUFFER.md index — chronological, one entry per write. Non-atomic by
  // design (it's human-readable progress, not source-of-truth).
  const indexLine = `- [${entry.category}/${entry.id}](${entry.category}/${filename})\n`;
  await appendFile(join(bufferDir(sessionId), 'BUFFER.md'), indexLine, 'utf8');

  return path;
}

// ---------------------------------------------------------------------------
// walkBuffer — async iterator over all entries in category order.
//
// Within a category, entries are sorted lexicographically by filename — which,
// thanks to `safeTimestamp` writing ISO timestamps first, equals chronological
// order. ENOENT on a category subdir means "no entries in this category" —
// the walk simply skips it (an empty buffer yields nothing, not throws).
//
// `.tmp` files are skipped — they represent in-flight or crashed writes that
// never completed their rename. Only canonical filenames yield.
// ---------------------------------------------------------------------------

export async function* walkBuffer(sessionId: string): AsyncGenerator<BufferEntry> {
  for (const cat of CATEGORY_ORDER) {
    const dir = join(bufferDir(sessionId), cat);
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    for (const f of entries.filter((x) => !x.endsWith('.tmp')).sort()) {
      const raw = await readFile(join(dir, f), 'utf8');
      yield parseEntry(raw, cat);
    }
  }
}

// ---------------------------------------------------------------------------
// parseEntry — minimal frontmatter parser.
//
// Recognizes:
//   - simple `key: value` pairs
//   - `key: |-` block scalar followed by 2-space-indented lines
//   - `key: ''` empty-string sentinel
//
// Does NOT recognize:
//   - nested keys
//   - dates / typed values (everything is string, caller coerces)
//   - YAML anchors / tags / multi-doc
//
// The frontmatter writer above is the only producer, so the parser only
// needs to cover what we ourselves emit.
// ---------------------------------------------------------------------------

function parseEntry(raw: string, category: BufferCategory): BufferEntry {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(raw);
  const fmText = m?.[1] ?? '';
  const body = (m?.[2] ?? '').replace(/\n+$/, '');

  const fmLines = fmText.split('\n');
  const fm: Record<string, string> = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i] ?? '';
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? '';
    const rawVal = (kv[2] ?? '').trim();
    if (rawVal === "''") {
      fm[key] = '';
      continue;
    }
    if (rawVal === '|-') {
      // Consume subsequent indented lines.
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < fmLines.length) {
        const next = fmLines[j] ?? '';
        if (/^ {2}/.test(next)) {
          blockLines.push(next.replace(/^ {2}/, ''));
          j++;
        } else if (next === '') {
          // Empty line inside block — preserve.
          blockLines.push('');
          j++;
        } else {
          break;
        }
      }
      // Trim trailing empty lines to honor `|-` strip semantics.
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') {
        blockLines.pop();
      }
      fm[key] = blockLines.join('\n');
      i = j - 1;
      continue;
    }
    fm[key] = rawVal;
  }

  return {
    id: fm.id ?? 'unknown',
    category,
    body,
    frontmatter: {
      timestamp: fm.timestamp ?? '',
      proposedCategory: fm.proposedCategory ?? category,
      sourceContext: fm.sourceContext ?? '',
      confidence: Number(fm.confidence ?? 0),
    },
  };
}
