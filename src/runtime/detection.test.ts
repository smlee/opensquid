/**
 * IDF.2 — unit tests for the pure-function detected_by evaluator.
 *
 * Covers all 7 detection kinds (happy + error path each), OR semantics
 * across multi-clause arrays, and the empty-array back-compat case.
 *
 * No filesystem I/O; ctx is hand-staged per test.
 */
import { describe, expect, it } from 'vitest';

import type { DetectedByCheck } from '../packs/schemas/manifest.js';

import { type DetectionContext, matchesDetectedBy } from './detection.js';

function emptyCtx(): DetectionContext {
  return {
    cwd: '/tmp/proj',
    files: {},
    dirs: {},
    fileContents: {},
    memoryBodies: '',
    recentPrompts: '',
    userPinned: false,
  };
}

describe('matchesDetectedBy — back-compat + OR semantics', () => {
  it('empty detectedBy[] → true (back-compat: always-on among opted-in packs)', () => {
    expect(matchesDetectedBy([], emptyCtx())).toBe(true);
  });

  it('multi-clause OR — only second matches → true (first-match-wins via OR)', () => {
    const ctx = { ...emptyCtx(), dirs: { 'src/components/atoms': true } };
    const checks: DetectedByCheck[] = [
      { kind: 'file_exists', path: 'a' },
      { kind: 'dir_exists', path: 'src/components/atoms' },
    ];
    expect(matchesDetectedBy(checks, ctx)).toBe(true);
  });

  it('multi-clause OR — none match → false', () => {
    const ctx = emptyCtx();
    const checks: DetectedByCheck[] = [
      { kind: 'file_exists', path: 'a' },
      { kind: 'dir_exists', path: 'b' },
    ];
    expect(matchesDetectedBy(checks, ctx)).toBe(false);
  });
});

describe('matchesDetectedBy — file_exists', () => {
  it('files map has path:true → true', () => {
    const ctx = { ...emptyCtx(), files: { 'package.json': true } };
    expect(matchesDetectedBy([{ kind: 'file_exists', path: 'package.json' }], ctx)).toBe(true);
  });

  it('files map missing key → false', () => {
    expect(matchesDetectedBy([{ kind: 'file_exists', path: 'package.json' }], emptyCtx())).toBe(
      false,
    );
  });

  it('files map has path:false (negative cached) → false', () => {
    const ctx = { ...emptyCtx(), files: { 'package.json': false } };
    expect(matchesDetectedBy([{ kind: 'file_exists', path: 'package.json' }], ctx)).toBe(false);
  });
});

describe('matchesDetectedBy — dir_exists', () => {
  it('dirs map has path:true → true', () => {
    const ctx = { ...emptyCtx(), dirs: { 'src/components/atoms': true } };
    expect(matchesDetectedBy([{ kind: 'dir_exists', path: 'src/components/atoms' }], ctx)).toBe(
      true,
    );
  });

  it('dirs map missing key → false', () => {
    expect(
      matchesDetectedBy([{ kind: 'dir_exists', path: 'src/components/atoms' }], emptyCtx()),
    ).toBe(false);
  });
});

describe('matchesDetectedBy — file_match (JSON path + regex)', () => {
  it('parsed JSON containing matching dotted key → true', () => {
    const ctx = {
      ...emptyCtx(),
      fileContents: {
        'package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      },
    };
    expect(
      matchesDetectedBy(
        [
          {
            kind: 'file_match',
            path: 'package.json',
            matches: { 'dependencies.react': '\\^19' },
          },
        ],
        ctx,
      ),
    ).toBe(true);
  });

  it('parsed JSON with non-matching value (react 17) → false', () => {
    const ctx = {
      ...emptyCtx(),
      fileContents: {
        'package.json': JSON.stringify({ dependencies: { react: '^17.0.0' } }),
      },
    };
    expect(
      matchesDetectedBy(
        [
          {
            kind: 'file_match',
            path: 'package.json',
            matches: { 'dependencies.react': '\\^19' },
          },
        ],
        ctx,
      ),
    ).toBe(false);
  });

  it('malformed JSON → false (no throw)', () => {
    const ctx = {
      ...emptyCtx(),
      fileContents: { 'package.json': '{not json' },
    };
    expect(
      matchesDetectedBy(
        [
          {
            kind: 'file_match',
            path: 'package.json',
            matches: { 'dependencies.react': '\\^19' },
          },
        ],
        ctx,
      ),
    ).toBe(false);
  });

  it('missing file content (key absent) → false', () => {
    expect(
      matchesDetectedBy(
        [
          {
            kind: 'file_match',
            path: 'package.json',
            matches: { 'dependencies.react': '\\^19' },
          },
        ],
        emptyCtx(),
      ),
    ).toBe(false);
  });

  it('JSON value at path is non-string (object) → false', () => {
    const ctx = {
      ...emptyCtx(),
      fileContents: {
        'package.json': JSON.stringify({ dependencies: { react: {} } }),
      },
    };
    expect(
      matchesDetectedBy(
        [
          {
            kind: 'file_match',
            path: 'package.json',
            matches: { 'dependencies.react': '\\^19' },
          },
        ],
        ctx,
      ),
    ).toBe(false);
  });

  it('AND semantics within a single file_match — all matches[] keys must hit', () => {
    const ctx = {
      ...emptyCtx(),
      fileContents: {
        'package.json': JSON.stringify({
          name: 'my-app',
          dependencies: { react: '^19.0.0' },
        }),
      },
    };
    expect(
      matchesDetectedBy(
        [
          {
            kind: 'file_match',
            path: 'package.json',
            matches: { 'dependencies.react': '\\^19', name: 'my-app' },
          },
        ],
        ctx,
      ),
    ).toBe(true);
    // one of the two fails → false
    expect(
      matchesDetectedBy(
        [
          {
            kind: 'file_match',
            path: 'package.json',
            matches: { 'dependencies.react': '\\^19', name: 'other-app' },
          },
        ],
        ctx,
      ),
    ).toBe(false);
  });
});

describe('matchesDetectedBy — file_glob', () => {
  it('5 .tsx files + min_count 3 → true', () => {
    const ctx = {
      ...emptyCtx(),
      files: {
        'src/a.tsx': true,
        'src/b.tsx': true,
        'src/c.tsx': true,
        'src/d.tsx': true,
        'src/e.tsx': true,
      },
    };
    expect(matchesDetectedBy([{ kind: 'file_glob', pattern: '**/*.tsx', min_count: 3 }], ctx)).toBe(
      true,
    );
  });

  it('2 .tsx files + min_count 3 → false', () => {
    const ctx = {
      ...emptyCtx(),
      files: { 'src/a.tsx': true, 'src/b.tsx': true },
    };
    expect(matchesDetectedBy([{ kind: 'file_glob', pattern: '**/*.tsx', min_count: 3 }], ctx)).toBe(
      false,
    );
  });

  it('only false-valued entries in files map → false', () => {
    const ctx = {
      ...emptyCtx(),
      files: { 'src/a.tsx': false, 'src/b.tsx': false },
    };
    expect(matchesDetectedBy([{ kind: 'file_glob', pattern: '**/*.tsx', min_count: 1 }], ctx)).toBe(
      false,
    );
  });
});

describe('matchesDetectedBy — memory_match + conversation_signal', () => {
  it('memory_match: pattern present in memoryBodies → true', () => {
    const ctx = { ...emptyCtx(), memoryBodies: '... uses react-19 ...' };
    expect(matchesDetectedBy([{ kind: 'memory_match', pattern: 'react-19' }], ctx)).toBe(true);
  });

  it('memory_match: pattern absent → false', () => {
    expect(matchesDetectedBy([{ kind: 'memory_match', pattern: 'react-19' }], emptyCtx())).toBe(
      false,
    );
  });

  it('conversation_signal: prompt contains pattern (regex word-boundary) → true', () => {
    const ctx = { ...emptyCtx(), recentPrompts: 'check the opensquid pack' };
    expect(
      matchesDetectedBy([{ kind: 'conversation_signal', pattern: '\\bopensquid\\b' }], ctx),
    ).toBe(true);
  });

  it('conversation_signal: malformed regex → false (no throw)', () => {
    const ctx = { ...emptyCtx(), recentPrompts: 'any text' };
    expect(matchesDetectedBy([{ kind: 'conversation_signal', pattern: '[unclosed' }], ctx)).toBe(
      false,
    );
  });
});

describe('matchesDetectedBy — user_pinned', () => {
  it('userPinned true → true', () => {
    const ctx = { ...emptyCtx(), userPinned: true };
    expect(matchesDetectedBy([{ kind: 'user_pinned' }], ctx)).toBe(true);
  });

  it('userPinned false → false', () => {
    expect(matchesDetectedBy([{ kind: 'user_pinned' }], emptyCtx())).toBe(false);
  });
});
