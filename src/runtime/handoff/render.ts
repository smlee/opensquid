/**
 * T-AUTO-HANDOFF — pure renderers (deterministic in HandoffState).
 *
 * Four surfaces, one state: the handover doc (the complete record), the
 * MEMORY.md resume block (compressed pointer), the work-graph digest, and the
 * chat digest. Resume steps are MECHANICAL: a mid-flow FSM always resumes at
 * the RESEARCH flow (re-fire the pre-research artifact — audits re-run on the
 * fresh session's budget; user-locked), and the FINAL step is always
 * "commit the handover doc(s)" (the successor-commits half of the locked
 * commit policy).
 *
 * Imports from: ./collect.js (types only).
 * Imported by: handoff/index.ts, handoff/write.ts.
 */

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

/** The mechanical resume steps (research-flow-first; commit-doc last). */
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
  steps.push('Commit the handover doc(s) — left uncommitted by the generator deliberately.');
  return steps;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
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
  const issues =
    typeof state.openIssues === 'string'
      ? state.openIssues
      : state.openIssues.map((i) => `- \`${i.id}\` ${i.title}`).join('\n') || '_(none open)_';

  return `# AUTO-HANDOVER — session ${sid8} (${state.generatedAt})

Generated DETERMINISTICALLY from disk state by \`opensquid handoff\` (T-AUTO-HANDOFF).
Narrative carries no authority here — every claim below is a file read; artifact hashes
let the successor verify disk truth directly.

## The handoff lives on 4 surfaces

1. THIS doc (\`${state.umbrellaRoot}/docs/\` — uncommitted; committing it is resume step ${String(renderResumeSteps(state).length)}).
2. The auto-memory MEMORY.md managed resume block (\`opensquid:handoff\` markers).
3. Work-graph issue \`handoff-${sid8}\`.
4. The umbrella chat topic (best-effort digest).

${section('RESUME steps (mechanical)', resume)}
${section('FSM', `state: **${fsmStateOf(state)}**\n\nlast transitions:\n${codeBlock(fsmHistoryTail(state))}`)}
${section('Active task', codeBlock([JSON.stringify(state.activeTask, null, 2)]))}
${section('Phase set (session)', codeBlock([JSON.stringify(state.phaseSet)]))}
${section('Phase ledger (durable, active task)', phaseLedger)}
${section('Guess-audit head', codeBlock([state.guessAuditHead]))}
${section('Spec-audit head', codeBlock([state.specAuditHead]))}
${section('Spawn-ledger tail', codeBlock(state.spawnLedgerTail))}
${section('Attestations tail', codeBlock(state.attestationsTail))}
${section('Artifacts (disk truth)', artifacts)}
${section('Git', git || '_(no repos swept)_')}
${section('Open work-graph issues', issues)}
`;
}

export function renderResumeBlock(state: HandoffState): string {
  const sid8 = state.sessionId.slice(0, 8);
  const steps = renderResumeSteps(state);
  return (
    `## ‼️ AUTO-HANDOFF (session ${sid8}, ${state.generatedAt}) — FSM ${fsmStateOf(state)}\n` +
    `Full record: see the auto-handover doc for session ${sid8} under the umbrella docs/ dir. ` +
    `First step: ${steps[0] ?? '(none)'} Final step: commit the handover doc(s).`
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

/** SessionStart injection text (reader side). */
export function renderInjection(docPath: string): string {
  return (
    `📦 AUTO-HANDOFF available from the previous session: ${docPath}\n` +
    `Read it BEFORE starting substantive work — it carries the mechanical RESUME steps ` +
    `(research-flow-first when the flow was mid-flight) and disk-truth artifact hashes.`
  );
}
