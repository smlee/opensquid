/** Pure renderer for standardized stage report bodies. */

export type Stage = string;

export const CODE_PHASES = [
  'pre_research',
  'learn',
  'code',
  'test',
  'audit',
  'post_research',
  'fix',
] as const;

export interface StageReport {
  stage: Stage;
  taskId: string;
  summary: string;
  nextDirective: string;
  nextWork?: string;
  goalAligned?: boolean;
  phases?: readonly { name: string; done: boolean }[];
  evidence?: readonly { label: string; ok: boolean }[];
}

export function renderStageReport(r: StageReport, iso: string): { path: string; body: string } {
  const date = iso.slice(0, 10);
  const lines: string[] = [`After-stage report — ${r.stage} complete · ${r.taskId} · ${date}`, ''];
  lines.push(`Summary: ${r.summary}`, '');

  if (r.evidence !== undefined && r.evidence.length > 0) {
    lines.push(
      `Evidence: ${r.evidence.map((e) => `${e.label} ${e.ok ? '✓' : '✗'}`).join(' · ')}`,
      '',
    );
  }

  if (r.phases !== undefined && r.phases.length > 0) {
    lines.push('Phases:');
    for (const p of r.phases) lines.push(`  [${p.done ? 'x' : ' '}] ${p.name}`);
    lines.push('');
  }

  const work = r.nextWork;
  lines.push(`Next → ${r.nextDirective}${work !== undefined ? `: ${work}` : ''}`);

  if (r.goalAligned !== undefined) {
    lines.push(
      '',
      `Goal: ${r.goalAligned ? 'on the captured goal' : 'OFF the captured goal — destination drift'}`,
    );
  }

  const body = lines.join('\n') + '\n';
  return { path: `${r.stage.toLowerCase()}-${r.taskId}-${date}.md`, body };
}

export function renderStageSummary(
  stage: Stage,
  work: string | undefined,
  taskId: string,
  iso: string,
): { body: string } {
  const date = iso.slice(0, 10);
  const lines = [
    `Starting ${stage} · ${taskId} · ${date}`,
    '',
    `Will: ${work ?? 'begin this stage'}`,
  ];
  return { body: lines.join('\n') + '\n' };
}
