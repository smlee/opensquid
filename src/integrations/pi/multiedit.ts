export interface MultiEditReplacement {
  readonly oldText: string;
  readonly newText: string;
}

export class PiMultiEditError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'PiMultiEditError';
    this.retryable = retryable;
  }
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };
}

export function detectLineEnding(content: string): '\n' | '\r\n' {
  const crlfIdx = content.indexOf('\r\n');
  const lfIdx = content.indexOf('\n');
  if (lfIdx === -1) return '\n';
  if (crlfIdx === -1) return '\n';
  return crlfIdx < lfIdx ? '\r\n' : '\n';
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, lineEnding: '\n' | '\r\n'): string {
  return lineEnding === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

function normalizeForFuzzyMatch(text: string): string {
  return normalizeToLf(text)
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

function uniqueMatchIndex(content: string, needle: string): number {
  if (needle.length === 0) {
    throw new PiMultiEditError('Pi MultiEdit oldText must not be empty');
  }
  const first = content.indexOf(needle);
  if (first === -1) {
    const fuzzyContent = normalizeForFuzzyMatch(content);
    const fuzzyNeedle = normalizeForFuzzyMatch(needle);
    if (fuzzyNeedle.length > 0 && countOccurrences(fuzzyContent, fuzzyNeedle) === 1) {
      throw new PiMultiEditError(
        'Pi MultiEdit oldText must match exactly once in the original file; fuzzy-only matches are rejected. Re-issue the edit with exact current text.',
      );
    }
    throw new PiMultiEditError('Pi MultiEdit oldText was not found in the original file');
  }
  const occurrences = countOccurrences(content, needle);
  if (occurrences > 1) {
    throw new PiMultiEditError(
      `Pi MultiEdit oldText must be unique in the original file; found ${String(occurrences)} matches`,
    );
  }
  return first;
}

export interface AppliedOriginalRelativeMultiEdit {
  readonly content: string;
  readonly normalizedOriginal: string;
  readonly normalizedResult: string;
}

export function applyOriginalRelativeMultiEdit(
  originalContent: string,
  edits: readonly MultiEditReplacement[],
): AppliedOriginalRelativeMultiEdit {
  const { bom, text } = stripBom(originalContent);
  const lineEnding = detectLineEnding(text);
  const normalizedOriginal = normalizeToLf(text);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));
  const matches = normalizedEdits.map((edit, index) => {
    const start = uniqueMatchIndex(normalizedOriginal, edit.oldText);
    return {
      index,
      start,
      end: start + edit.oldText.length,
      newText: edit.newText,
    };
  });
  matches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < matches.length; i += 1) {
    const previous = matches[i - 1];
    const current = matches[i];
    if (previous !== undefined && current !== undefined && previous.end > current.start) {
      throw new PiMultiEditError(
        `Pi MultiEdit replacements overlap in the original file (edits[${String(previous.index)}] and edits[${String(current.index)}])`,
      );
    }
  }
  let normalizedResult = normalizedOriginal;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    if (match === undefined) continue;
    normalizedResult =
      normalizedResult.slice(0, match.start) + match.newText + normalizedResult.slice(match.end);
  }
  if (normalizedResult === normalizedOriginal) {
    throw new PiMultiEditError(
      'Pi MultiEdit produced no change; re-issue the edit with an exact unique replacement',
    );
  }
  return {
    content: bom + restoreLineEndings(normalizedResult, lineEnding),
    normalizedOriginal,
    normalizedResult,
  };
}
