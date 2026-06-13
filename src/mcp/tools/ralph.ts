/**
 * GR.4 — the lap-side decision classifier MCP tool (`decision_classify`).
 *
 * Exposes GR.2's deterministic `classifyDecision` to the in-lap `claude -p` agent so it can consult the
 * cheap DECIDE-vs-ESCALATE heuristic mid-execution (the single-home for the classifier: it runs LAP-SIDE,
 * never in the orchestrator). READ-only — pure function, no state mutation. The lap stamps the returned
 * verdict into its `HUMAN_REQUIRED` payload on an ESCALATE so the escalation carries the heuristic verdict
 * (the input the post-hoc `recordMisclassification` override path compares against).
 *
 * Imports from: zod, ../../runtime/ralph/decision_classifier.js.
 */
import { z } from 'zod';
import { classifyDecision } from '../../runtime/ralph/decision_classifier.js';

export const DecisionClassifySchema = z.object({
  decision: z.string().min(1),
});

export const handleDecisionClassify = (a: z.infer<typeof DecisionClassifySchema>): string =>
  JSON.stringify(classifyDecision(a.decision));
