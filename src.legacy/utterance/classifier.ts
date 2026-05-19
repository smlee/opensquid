/**
 * Pattern-based utterance classifier — categorizes user-said text into
 * one of: `fact` / `preference` / `correction` / `workflow_lock` /
 * `none`, with a suggested follow-up action.
 *
 * Pure regex catalog. No LLM call. Fast, deterministic, hand-tunable.
 * The full LLM-driven Stop-hook auto-classifier is task #112; this
 * tool is agent-invoked per the CLAUDE.md classify-and-act block.
 *
 * Output is structured guidance, not an action. The MCP tool returns
 * { kind, suggested_action, matched, confidence }; the agent then calls
 * the appropriate downstream tool (memorize, remember, update_memory)
 * itself.
 */

export type UtteranceKind = "fact" | "preference" | "correction" | "workflow_lock" | "none";

export type UtteranceConfidence = "high" | "medium" | "low";

export interface UtterancePattern {
  /** Stable id (e.g. "preference-always"). */
  id: string;
  /** Category this pattern signals. */
  kind: UtteranceKind;
  /** Regex matched against the utterance text. */
  pattern: string;
  /** Confidence level when this pattern fires. */
  confidence: UtteranceConfidence;
  /** Short explanation surfaced to the agent. */
  reason: string;
}

/**
 * Catalog. Ordered by SPECIFICITY — most specific patterns first so the
 * first match wins. Conservative: a miss is "agent classifies based on
 * CLAUDE.md instructions anyway", a false-fire is "spurious memorize/
 * remember call".
 */
export const UTTERANCE_PATTERNS: UtterancePattern[] = [
  // -------------------- CORRECTION (unambiguous, high) --------------------
  {
    id: "correction-no-thats-wrong",
    kind: "correction",
    pattern: "\\b(no,?\\s+that'?s\\s+wrong|that'?s\\s+(?:not\\s+)?(?:wrong|incorrect))\\b",
    confidence: "high",
    reason: "explicit correction phrasing",
  },
  {
    id: "correction-actually",
    kind: "correction",
    pattern: "\\b(actually,?\\s+(?:it\\s+should\\s+be|the\\s+(?:right|correct))\\b)",
    confidence: "high",
    reason: "actually-it-should-be retraction pattern",
  },
  {
    id: "correction-i-meant",
    kind: "correction",
    pattern: "\\b(I\\s+(?:meant|misspoke)|let me correct that)\\b",
    confidence: "medium",
    reason: "self-correction pattern",
  },

  // -------------------- WORKFLOW_LOCK (specific, high) --------------------
  {
    id: "workflow-the-workflow-is",
    kind: "workflow_lock",
    pattern: "\\bthe\\s+workflow\\s+is\\b",
    confidence: "high",
    reason: "explicit workflow declaration",
  },
  {
    id: "workflow-pre-research-first",
    kind: "workflow_lock",
    pattern: "\\b(always|never)\\s+(pre-?research|audit|test|build)\\s+(first|before|after)\\b",
    confidence: "high",
    reason: "phase-ordering directive",
  },
  {
    id: "workflow-no-hedges",
    kind: "workflow_lock",
    pattern: "\\bno\\s+(hedges|later\\s+hedges|skip(?:ping)?\\s+phases)\\b",
    confidence: "high",
    reason: "explicit anti-drift directive",
  },
  {
    id: "workflow-keep-iterating",
    kind: "workflow_lock",
    pattern: "\\bkeep\\s+iterat(?:ing|e)\\s+until\\b",
    confidence: "medium",
    reason: "iteration-discipline directive",
  },

  // -------------------- PREFERENCE (specific, high — narrower than \"always\") --------------------
  {
    id: "preference-i-prefer",
    kind: "preference",
    pattern: "\\bI\\s+prefer\\s+",
    confidence: "high",
    reason: "explicit preference",
  },
  {
    id: "preference-always-i",
    kind: "preference",
    // "always [verb]" attached to first-person (I always, we always)
    pattern: "\\b(?:I|we|you should)\\s+always\\b",
    confidence: "high",
    reason: "first-person always-directive",
  },
  {
    id: "preference-always-action",
    kind: "preference",
    // "always [verb]" at sentence start — e.g. "Always run X" or "always X before Y"
    pattern: "(?:^|\\.\\s+)always\\s+\\w+",
    confidence: "medium",
    reason: "sentence-leading always-directive",
  },
  {
    id: "preference-never",
    kind: "preference",
    pattern: "\\b(?:I|we|you should)\\s+never\\b|(?:^|\\.\\s+)never\\s+\\w+",
    confidence: "high",
    reason: "negative directive",
  },
  {
    id: "preference-dont",
    kind: "preference",
    pattern: "(?:^|\\.\\s+)don'?t\\s+\\w+",
    confidence: "medium",
    reason: "sentence-leading prohibition",
  },

  // -------------------- FACT (broadest, conservative) --------------------
  {
    id: "fact-i-use",
    kind: "fact",
    pattern: "\\bI\\s+use\\s+\\w+",
    confidence: "high",
    reason: "I-use-X declarative",
  },
  {
    id: "fact-x-is-my",
    kind: "fact",
    pattern: "\\b\\w+\\s+is\\s+my\\s+\\w+",
    confidence: "high",
    reason: "X-is-my-Y identity statement",
  },
  {
    id: "fact-we-have",
    kind: "fact",
    pattern: "\\b(?:we\\s+have|our\\s+\\w+\\s+(?:is|uses))\\b",
    confidence: "medium",
    reason: "team-attribute statement",
  },
];

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export interface ClassifyResult {
  kind: UtteranceKind;
  /** Recommended next action for the agent. */
  suggested_action: string;
  /** Pattern id(s) that matched. */
  matched: string[];
  /** Confidence of the strongest hit. */
  confidence: UtteranceConfidence | null;
}

/**
 * Classify an utterance. Returns the strongest-confidence match's kind
 * (high > medium > low), all matching pattern ids, and a suggested
 * downstream action.
 *
 * Empty / whitespace input → kind="none".
 */
export function classifyUtterance(text: string): ClassifyResult {
  if (!text || !text.trim()) {
    return { kind: "none", suggested_action: "", matched: [], confidence: null };
  }
  const matches: UtterancePattern[] = [];
  for (const p of UTTERANCE_PATTERNS) {
    try {
      if (new RegExp(p.pattern, "i").test(text)) matches.push(p);
    } catch {
      // bad pattern — skip
    }
  }
  if (matches.length === 0) {
    return { kind: "none", suggested_action: "", matched: [], confidence: null };
  }
  const winner = pickStrongest(matches);
  return {
    kind: winner.kind,
    suggested_action: suggestedAction(winner.kind),
    matched: matches.map((m) => m.id),
    confidence: winner.confidence,
  };
}

function pickStrongest(matches: UtterancePattern[]): UtterancePattern {
  const order: Record<UtteranceConfidence, number> = { high: 3, medium: 2, low: 1 };
  return matches.reduce((best, p) => (order[p.confidence] > order[best.confidence] ? p : best));
}

function suggestedAction(kind: UtteranceKind): string {
  switch (kind) {
    case "fact":
      return "call `memorize` with the fact. Note the memory id in your reply.";
    case "preference":
      return 'call `memorize` AND `remember` to create a lesson candidate. Reply: "Captured as a candidate rule — promote to permanent?"';
    case "workflow_lock":
      return "call `memorize` AND `remember` (workflow rules are high-priority lesson candidates). Offer to promote.";
    case "correction":
      return "call `memorize` with the correction. If it supersedes a specific prior memory you can identify, also call `update_memory`.";
    case "none":
      return "";
  }
}
