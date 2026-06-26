/**
 * T-AUTO-HANDOFF — pure renderers (deterministic in HandoffState).
 *
 * Four surfaces, one state: the handover doc (the complete record), the
 * MEMORY.md resume block (compressed pointer), the work-graph digest, and the
 * chat digest. Resume steps are MECHANICAL: a mid-flow FSM always resumes at
 * the RESEARCH flow (re-fire the pre-research artifact — audits re-run on the
 * fresh session's budget; user-locked). The handover doc is a gitignored
 * on-disk PROJECTION (single-writable-home): the successor reads it and never
 * commits it — the durable resume anchors are the MEMORY.md pointer + the
 * work-graph issue, not git-tracked markdown.
 *
 * Imports from: ./collect.js (types only).
 * Imported by: handoff/index.ts, handoff/write.ts.
 */

import { buildKanbanStory, renderKanbanStory } from '../../kanban/story.js';

import type { Issue } from '../../workgraph/types.js';
import type { HandoffState } from './collect.js';

const MID_FLOW = new Set([
  'scoping',
  'researching',
  'researched',
  'spec_authored',
  'spec_complete',
  'tasks_loaded',
  'phases_in_flight',
]);

function fsmStateOf(state: HandoffState): string {
  const fsm = state.fsm;
  if (
    fsm !== null &&
    typeof fsm === 'object' &&
    typeof (fsm as { state?: unknown }).state === 'string'
  ) {
    return (fsm as { state: string }).state;
  }
  return '<unknown>';
}

function fsmHistoryTail(state: HandoffState, n = 3): string[] {
  const fsm = state.fsm;
  if (fsm === null || typeof fsm !== 'object') return [];
  const history = (fsm as { history?: unknown }).history;
  if (!Array.isArray(history)) return [];
  return history
    .slice(-n)
    .map((h) =>
      h !== null && typeof h === 'object'
        ? `${String((h as { state?: unknown }).state)} @ ${String((h as { at?: unknown }).at)}`
        : String(h),
    );
}

/** The mechanical resume steps (research-flow-first; the doc is a gitignored projection — no commit step). */
export function renderResumeSteps(state: HandoffState): string[] {
  const steps: string[] = [];
  const fsmState = fsmStateOf(state);
  const pre = state.artifacts.find((a) => a.kind === 'pre_research');
  const spec = state.artifacts.find((a) => a.kind === 'spec');

  if (MID_FLOW.has(fsmState)) {
    if (pre !== undefined) {
      steps.push(
        `Re-fire the pre-research artifact at ${pre.path} ` +
          (pre.sha8 !== null
            ? `(disk hash ${pre.sha8} — verify before trusting any narrative)`
            : `(NOT READABLE ON DISK — recover content from the dead session's transcript first)`) +
          ` — the audits re-run on the fresh session's budget (cap-hit resumes re-enter at the RESEARCH flow).`,
      );
    } else {
      steps.push(
        'No pre-research artifact recorded — start the track at SCOPE (write the pre-research first).',
      );
    }
    if (spec !== undefined) {
      steps.push(
        `Re-fire the spec at ${spec.path}` +
          (spec.sha8 !== null ? ` (disk hash ${spec.sha8})` : ' (NOT READABLE ON DISK)') +
          ' — then TaskCreate with ABSOLUTE metadata.spec + metadata.taskId.',
      );
    }
    steps.push(
      'After TaskCreate/TaskUpdate(in_progress): re-drive the 7 log_phase calls for any work already done (the ledger below is the evidence of what genuinely completed).',
    );
  } else {
    steps.push(
      `FSM is at "${fsmState}" — no mid-flow recovery needed; pick the next backlog item (open work-graph issues below).`,
    );
  }
  return steps; // the doc is a gitignored projection; no commit step (single-writable-home)
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

/** T2.8 — the start-up surface for DURABLE acceptance items still awaiting a human OK. A closed-session
 *  acceptance is NOT lost (design §6.2-6.3): each waiting taskId renders `- waiting for your OK: <taskId>` so
 *  the successor re-asks the user. Empty → an explicit "_(none)_" marker (totality). */
export function renderWaitingAcceptance(state: HandoffState): string {
  if (state.waitingAcceptance.length === 0) return '_(none)_';
  return state.waitingAcceptance.map((taskId) => `- waiting for your OK: ${taskId}`).join('\n');
}

function codeBlock(lines: string[]): string {
  return lines.length === 0 ? '_(empty)_' : `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

export function renderHandoverDoc(state: HandoffState): string {
  const sid8 = state.sessionId.slice(0, 8);
  const resume = renderResumeSteps(state)
    .map((s, i) => `${String(i + 1)}. ${s}`)
    .join('\n');
  const phaseLedger =
    typeof state.phaseLedger === 'string'
      ? state.phaseLedger
      : state.phaseLedger.map((p) => `- **${p.phase}** — ${p.note}`).join('\n') || '_(none)_';
  const artifacts =
    state.artifacts
      .map((a) => `- ${a.kind}: \`${a.path}\` (sha8: ${a.sha8 ?? 'UNREADABLE'})`)
      .join('\n') || '_(none recorded)_';
  const git = state.git
    .map(
      (g) =>
        `### ${g.repo}\n\nstatus:\n${codeBlock(g.statusShort ? g.statusShort.split('\n') : [])}\n\nunpushed:\n${codeBlock(g.unpushed ? g.unpushed.split('\n') : [])}`,
    )
    .join('\n\n');
  // KANBAN.5: the work-graph rendered as a kanban STORY (goal + lanes) — the non-stale resume checkpoint,
  // in place of the old flat issue list. Built live from disk truth each handoff; unreadable → a marker.
  const story =
    typeof state.storyIssues === 'string' || typeof state.readyIds === 'string'
      ? '_(work-graph unreadable)_'
      : renderKanbanStory(
          buildKanbanStory(state.storyGoal, state.storyIssues as Issue[], new Set(state.readyIds)),
        );

  return `# AUTO-HANDOVER — session ${sid8} (${state.generatedAt})

Generated DETERMINISTICALLY from disk state by \`opensquid handoff\` (T-AUTO-HANDOFF).
Narrative carries no authority here — every claim below is a file read; artifact hashes
let the successor verify disk truth directly.

## The handoff lives on 4 surfaces

1. THIS doc (\`${state.root}/docs/\` — a gitignored on-disk projection, regenerated each handoff; read it, never commit it).
2. The auto-memory MEMORY.md managed resume block (\`opensquid:handoff\` markers).
3. Work-graph issue \`handoff-${sid8}\`.
4. The umbrella chat topic (best-effort digest).

${section('RESUME steps (mechanical)', resume)}
${section('FSM', `state: **${fsmStateOf(state)}**\n\nlast transitions:\n${codeBlock(fsmHistoryTail(state))}`)}
${section('Waiting for your OK (durable acceptance)', renderWaitingAcceptance(state))}
${section('Active task', codeBlock([JSON.stringify(state.activeTask, null, 2)]))}
${section('Phase set (session)', codeBlock([JSON.stringify(state.phaseSet)]))}
${section('Phase ledger (durable, active task)', phaseLedger)}
${section('Guess-audit head', codeBlock([state.guessAuditHead]))}
${section('Spec-audit head', codeBlock([state.specAuditHead]))}
${section('Spawn-ledger tail', codeBlock(state.spawnLedgerTail))}
${section('Attestations tail', codeBlock(state.attestationsTail))}
${section('Artifacts (disk truth)', artifacts)}
${section('Git', git || '_(no repos swept)_')}
${section('Kanban story (work-graph)', story)}
`;
}

/** HPB.1 (wg-c34349377f81) — a POINTER-ONLY projection. The project's locked
 *  thesis (event-sourced work-graph; the memory axiom): disk state is the
 *  truth; shared-mutable surfaces carry pointers, never content. The inline
 *  steps this used to carry were a stale-prone duplicate of what the
 *  SessionStart directive injection (0.5.404) renders fresh — and an
 *  overwritten POINTER loses nothing, because the doc it names is lazily
 *  regenerated to currency at read time. */
export function renderResumeBlock(state: HandoffState): string {
  const sid8 = state.sessionId.slice(0, 8);
  return (
    `## 📦 AUTO-HANDOFF pointer (session ${sid8}, ${state.generatedAt}) — FSM ${fsmStateOf(state)}\n` +
    `Full record: \`docs/handover-session-${sid8}-auto.md\` under the umbrella root. ` +
    `The next session AUTO-RESUMES from it on any first prompt (0.5.404 directive) — no manual action needed.`
  );
}

export function renderWgDigest(state: HandoffState): string {
  return (
    `AUTO-HANDOFF for session ${state.sessionId} (${state.generatedAt}). ` +
    `FSM: ${fsmStateOf(state)}. Resume steps:\n` +
    renderResumeSteps(state)
      .map((s, i) => `${String(i + 1)}. ${s}`)
      .join('\n')
  );
}

export function renderChatDigest(state: HandoffState): string {
  const sid8 = state.sessionId.slice(0, 8);
  return (
    `AUTO-HANDOFF session ${sid8} — FSM ${fsmStateOf(state)}. ` +
    `Doc: handover-…-session-${sid8}-auto.md (umbrella docs/). ` +
    `${renderResumeSteps(state)[0] ?? ''}`
  );
}

/** AHO.2 — insert the narrative section above the RESUME steps. PURE: every
 *  other byte of the doc is untouched (the splice pin enforces it). */
const NARRATIVE_ANCHOR = '## RESUME steps (mechanical)';
export function spliceNarrative(doc: string, narrative: string): string {
  const section = `## Narrative (LLM layer — non-load-bearing)\n\n${narrative}\n\n`;
  const at = doc.indexOf(NARRATIVE_ANCHOR);
  if (at === -1) return `${doc}\n${section}`; // defensive — append
  return `${doc.slice(0, at)}${section}${doc.slice(at)}`;
}

/** SessionStart injection text (reader side). HRA.1 (wg-c34349377f81): a
 *  DIRECTIVE, not an FYI — the user's bar is "resume on ANY first prompt"
 *  (their morning words: "i thought it would be automatic"). The yield
 *  clause keeps the user's actual ask sovereign. */
export function renderInjection(docPath: string): string {
  return (
    `📦 AUTO-HANDOFF PENDING from the previous session: ${docPath}\n` +
    `This is an ACTIVE task, not background context: read that doc and execute its ` +
    `RESUME steps NOW — announce in one line that you are resuming, then drive the ` +
    `steps to completion. Yield ONLY if the user's first prompt explicitly requests ` +
    `different work (their ask always wins); otherwise any first prompt — including a ` +
    `greeting — starts the resume.`
  );
}
