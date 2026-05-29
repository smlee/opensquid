/**
 * Tests for SCOPE_INTENT_REGEX (T-ASC, ASC.1).
 *
 * The regex is contracted to be a SUPERSET of the personal-pack
 * `scope-intent-nudge` rule's patterns at
 * `~/.opensquid/packs/sangmin-personal-rules/skills/scope-decomposer/skill.yaml:33-39`.
 * We mirror those patterns here as fixtures: every example string that the
 * pack patterns would match MUST also match SCOPE_INTENT_REGEX, or the chain-
 * state transition to 'scoping' would lag behind the nudge verdict and the
 * subsequent stage-gated handoff rules would never fire (the false-negative
 * mode the regex must prevent).
 */

import { describe, expect, it } from 'vitest';

import { SCOPE_INTENT_REGEX } from './scope_intent.js';

describe('SCOPE_INTENT_REGEX — true positives (pack-pattern subset)', () => {
  const POSITIVES: string[] = [
    // \bspec(?:c?ing|ced)?\s+(?:out|this|the)\b
    'spec out this thing',
    'spec this rfc',
    'spec the change',
    'speccing out the migration',
    'specing out the migration', // single-c variant per pack pattern
    'specced out yesterday',
    // \bscope\s+(?:out|this|the|a)\b
    'scope out the change',
    'scope this carefully',
    'scope a track',
    // \bnew\s+(?:task|track)\b
    'create a new task',
    'new track for the migration',
    // \badd\s+(?:a\s+|another\s+)?(?:task|track)\b
    'add task',
    'add a task',
    'add another track',
    // \bdesign\s+(?:a|the|this)\b
    'design a feature',
    'design the runtime gate',
    'design this differently',
    // \bplan\s+(?:out|a|the)\b
    'plan out the next track',
    'plan a follow-up',
    'plan the schema',
    // Looser superset cases — pack rule may not match, regex still does, by
    // design (false positives are cheap; the chain-state writer's idle-guard
    // limits the cost to one extra transition that the agent ignores).
    'spec',
    'scope',
    'design',
    'plan',
    // Case-insensitive
    'PLAN OUT THE NEXT RELEASE',
    'Spec Out The Schema',
  ];
  for (const text of POSITIVES) {
    it(`matches: ${JSON.stringify(text)}`, () => {
      expect(SCOPE_INTENT_REGEX.test(text)).toBe(true);
    });
  }
});

describe('SCOPE_INTENT_REGEX — true negatives (word-boundary protection)', () => {
  const NEGATIVES: string[] = [
    // Word-boundary anchoring prevents false matches inside larger words
    'specifically',
    'speculative',
    'specimen',
    'prescriptive',
    'scoped variables', // 'scope' here has trailing 'd' = no \b after — but wait, 'scoped' is one word. let's check.
    'plant',
    'plants',
    'planned', // 'plan' would NOT have \b after because 'n' is followed by 'n' — but 'plan' ends at 'n', then 'n' starts next... actually 'planned' is 'plan' + 'ned' — 'plan' is followed by 'n' (a word char), so no \b. So 'planned' does NOT match \bplan\b.
    'designate',
    'designated',
    'designer',
    'subscope', // pre-fix attached, no leading \b for scope
    // No scope-authoring intent words at all
    'hello there',
    'run the tests',
    'commit and push',
    'show me the diff',
    '',
    '   ',
  ];
  for (const text of NEGATIVES) {
    it(`does NOT match: ${JSON.stringify(text)}`, () => {
      expect(SCOPE_INTENT_REGEX.test(text)).toBe(false);
    });
  }
});

describe('SCOPE_INTENT_REGEX — pack-pattern superset invariant', () => {
  // The personal-pack patterns from scope-decomposer/skill.yaml:33-39.
  // For each pack pattern, generate a representative match string and verify
  // SCOPE_INTENT_REGEX also matches. If a pack pattern is added that breaks
  // this invariant, broaden SCOPE_INTENT_REGEX in the same commit.
  const PACK_REPRESENTATIVES: { pattern: string; example: string }[] = [
    { pattern: '\\bspec(?:c?ing|ced)?\\s+(?:out|this|the)\\b', example: 'spec out it' },
    { pattern: '\\bscope\\s+(?:out|this|the|a)\\b', example: 'scope the issue' },
    { pattern: '\\bnew\\s+(?:task|track)\\b', example: 'add a new task' },
    { pattern: '\\badd\\s+(?:a\\s+|another\\s+)?(?:task|track)\\b', example: 'add a task' },
    { pattern: '\\bdesign\\s+(?:a|the|this)\\b', example: 'design the gate' },
    { pattern: '\\bplan\\s+(?:out|a|the)\\b', example: 'plan a release' },
  ];
  for (const { pattern, example } of PACK_REPRESENTATIVES) {
    it(`SCOPE_INTENT_REGEX matches a representative of pack pattern ${pattern}`, () => {
      // Sanity-check: the pack pattern actually matches its representative.
      expect(new RegExp(pattern).test(example)).toBe(true);
      // The contract: SCOPE_INTENT_REGEX must also match.
      expect(SCOPE_INTENT_REGEX.test(example)).toBe(true);
    });
  }
});
