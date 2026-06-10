/**
 * T-CODEX-HOST-SHELL CHS.2 — codex `apply_patch` envelope parsing.
 *
 * Codex's file-edit tool reports `tool_name: "apply_patch"` with the patch
 * text in `tool_input.command`; no pack rule matches that name, so without
 * normalization a codex file write sails past every coding-flow gate (the
 * post-trust CHS.1 live spike proved it). The hook bin normalizes each
 * touched path into ONE synthesized single-path `Write` event — every PATH
 * predicate dialect (contains/endsWith/startsWith/==) sees a normal
 * file_path. Content: `Add File` sections carry the FULL final content as
 * `+` lines (true artifact for the content audits); `Update`/`Delete`
 * sections become a first-line-LABELED hunk diff — explicit, never
 * silently-stale (the effective_content failure mode the design review
 * caught). Zero markers parsed → [] → the caller passes the event through
 * untouched (fail-open for unknown envelope variants).
 *
 * Imports from: (none — pure).
 * Imported by: src/runtime/hooks/pre-tool-use.ts.
 */

export interface PatchedFile {
  path: string;
  kind: 'add' | 'update' | 'delete';
  /** add: true final content; update/delete: labeled hunk diff. */
  content: string;
}

const MARKER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

export function parseApplyPatch(command: string): PatchedFile[] {
  const lines = command.split('\n');
  const out: PatchedFile[] = [];
  let cur: { path: string; kind: PatchedFile['kind']; lines: string[] } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const content =
      cur.kind === 'add'
        ? cur.lines
            .filter((l) => l.startsWith('+'))
            .map((l) => l.slice(1))
            .join('\n')
        : `<apply_patch ${cur.kind} — content below is the hunk diff, not the final artifact>\n${cur.lines.join('\n')}`;
    out.push({ path: cur.path, kind: cur.kind, content });
    cur = null;
  };
  for (const line of lines) {
    const m = MARKER.exec(line);
    if (m !== null) {
      flush();
      cur = {
        path: m[2] ?? '',
        kind: (m[1] ?? 'update').toLowerCase() as PatchedFile['kind'],
        lines: [],
      };
    } else if (cur !== null && !line.startsWith('*** End Patch')) {
      cur.lines.push(line);
    }
  }
  flush();
  return out.filter((f) => f.path.length > 0);
}
