import { atomicWriteFile } from '../../runtime/atomic_write.js';
import { readActiveTaskId } from '../../runtime/session_state.js';
import type { Event } from '../../runtime/event.js';
import { sessionStateFile } from '../../runtime/paths.js';
import { readCheckpointBySession } from '../../runtime/ralph/loop_stage.js';
import { scopeEvidence } from '../../runtime/loop/scope_evidence.js';
import { planEvidence, openWg } from '../../runtime/loop/plan_evidence.js';
import { authorEvidenceForSession, type AuthorInputs } from '../../runtime/loop/author_evidence.js';
import { codeEvidenceForSession, type CodeEvidenceDeps } from '../../runtime/loop/code_evidence.js';
import {
  deployEvidenceForSession,
  type DeployEvidenceDeps,
} from '../../runtime/loop/deploy_evidence.js';
import {
  frontendEvidenceForEvent,
  type FrontendEvidenceDeps,
} from '../../runtime/loop/frontend_evidence.js';
import { externalNeededForSession } from '../../runtime/loop/external_dependency_evidence.js';
import {
  externalConsultResult,
  type ExternalConsult,
} from '../../runtime/loop/external_consult.js';
import { resolveChecklist, type ChecklistSubIssue } from '../../runtime/loop/report_checklist.js';
import { reportResolved } from '../../runtime/loop/report_resolution.js';
import { readBugfixRounds, readNeedsRedesign } from '../../runtime/loop/verification.js';
import type { BaseGuardContext } from '../../runtime/loop/guard_context.js';

export {
  fullstackScopeCommand,
  registerFullstackScopeEntry,
  resolveFullstackScopeEngagement,
} from './fullstack_scope.js';

const ARTIFACT_POINTER_KEY = 'fullstack-flow-approved-artifact-path';
const LEGACY_ARTIFACT_POINTER_KEY = 'fullstack-flow-pre-research-path';
const MAX_BUGFIX_ROUNDS = 3;

/** Read the latest pack artifact pointer, falling back to the issue checkpoint's durable artifact list. */
export async function readFullstackArtifactPath(sessionId: string): Promise<string | null> {
  try {
    const value = JSON.parse(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(sessionStateFile(sessionId, ARTIFACT_POINTER_KEY), 'utf8'),
      ),
    ) as unknown;
    if (typeof value === 'string' && value !== '') return value;
  } catch {
    // Fall through to the legacy session pointer used by existing durable sessions.
  }
  try {
    const value = JSON.parse(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(sessionStateFile(sessionId, LEGACY_ARTIFACT_POINTER_KEY), 'utf8'),
      ),
    ) as unknown;
    if (typeof value === 'string' && value !== '') return value;
  } catch {
    // Fall through to the durable issue checkpoint.
  }
  try {
    return (await readCheckpointBySession(sessionId))?.scopeArtifacts.at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Extend universal guard context with the evidence contract declared by the built-in fullstack pack.
 * This module is pack-owned: core sees only an opaque adapter id and opaque context keys.
 */
export async function extendFullstackGuardContext(
  base: BaseGuardContext,
  event: Event,
  sessionId: string,
  authorInputs?: AuthorInputs,
  codeDeps?: CodeEvidenceDeps,
  deployDeps?: DeployEvidenceDeps,
  frontendDeps?: FrontendEvidenceDeps,
): Promise<Map<string, unknown>> {
  const values = base.values;
  const artifactPath = base.approvedArtifactPath;
  const isAdvance = artifactPath !== undefined;

  const scope: {
    is_advance: boolean;
    anchors_ok?: boolean;
    depth?: number;
    open_question?: boolean;
  } = { is_advance: isAdvance };
  values.set('scope.is_advance', isAdvance);
  if (artifactPath !== undefined) {
    const evidence = await scopeEvidence(sessionId, artifactPath);
    scope.anchors_ok = evidence.anchorsOk;
    scope.depth = evidence.depth;
    scope.open_question = evidence.openQuestion;
    values.set('scope.anchors_ok', evidence.anchorsOk);
    values.set('scope.depth', evidence.depth);
    values.set('scope.open_question', evidence.openQuestion);
    try {
      await atomicWriteFile(
        sessionStateFile(sessionId, ARTIFACT_POINTER_KEY),
        JSON.stringify(artifactPath),
      );
    } catch (error) {
      process.stderr.write(
        `[fullstack-flow] artifact pointer write failed (ignored): ${String(error)}\n`,
      );
    }
  }
  values.set('scope', scope);

  const plan = { acyclic: false, complete: false };
  try {
    const captured = await readFullstackArtifactPath(sessionId);
    if (captured !== null) Object.assign(plan, await planEvidence(sessionId, captured));
  } catch (error) {
    process.stderr.write(
      `[fullstack-flow] decomposition evidence failed (ignored): ${String(error)}\n`,
    );
  }
  values.set('plan.acyclic', plan.acyclic);
  values.set('plan.complete', plan.complete);
  values.set('plan', plan);

  let externalNeeded = false;
  let consult: ExternalConsult = { before: false, after: false };
  try {
    externalNeeded = await externalNeededForSession(sessionId);
    const taskId = await readActiveTaskId(sessionId);
    if (taskId !== null) consult = await externalConsultResult(sessionId, taskId);
  } catch (error) {
    process.stderr.write(
      `[fullstack-flow] consultation evidence failed (ignored): ${String(error)}\n`,
    );
  }

  const author = await authorEvidenceForSession(sessionId, authorInputs);
  values.set('author.manifest_complete', author.manifestComplete);
  values.set('author.real_code', author.realCode);
  values.set('author.searched_existing', consult.before);
  values.set('author.external_needed', externalNeeded);
  values.set('author', {
    manifest_complete: author.manifestComplete,
    real_code: author.realCode,
    searched_existing: consult.before,
    external_needed: externalNeeded,
  });

  let resolved = true;
  try {
    const taskId = await readActiveTaskId(sessionId);
    if (taskId !== null) {
      const wg = await openWg(sessionId);
      const [issues, edges] = await Promise.all([wg.listIssues(), wg.listEdges()]);
      const childIds = new Set(
        edges
          .filter((edge) => edge.type === 'parent-child' && edge.from === taskId)
          .map((edge) => edge.to),
      );
      const byId = new Map(issues.map((issue) => [issue.id, issue]));
      const children: ChecklistSubIssue[] = [...childIds]
        .map((id) => byId.get(id))
        .filter((issue): issue is NonNullable<typeof issue> => issue !== undefined)
        .map((issue) => ({
          id: issue.id,
          title: issue.title,
          status: issue.status,
          ...(issue.wedgeReason === undefined ? {} : { wedgeReason: issue.wedgeReason }),
        }));
      resolved = reportResolved(resolveChecklist(children).allResolved);
    }
  } catch (error) {
    process.stderr.write(`[fullstack-flow] report evidence failed (ignored): ${String(error)}\n`);
  }
  values.set('report.resolved', resolved);
  values.set('report', { resolved });

  const code = await codeEvidenceForSession(sessionId, codeDeps);
  values.set('code.phases_complete', code.phasesComplete);
  values.set('code.readiness_ran', code.readinessRan);
  values.set('code.deprecated_clean', code.deprecatedClean);
  values.set('code.suite_green', code.suiteGreen);
  values.set('code.arch_clean', code.archClean);
  values.set('code.consulted_before', consult.before);
  values.set('code.audited', consult.after);
  values.set('code.external_needed', externalNeeded);
  values.set('code', {
    phases_complete: code.phasesComplete,
    readiness_ran: code.readinessRan,
    deprecated_clean: code.deprecatedClean,
    suite_green: code.suiteGreen,
    arch_clean: code.archClean,
    consulted_before: consult.before,
    audited: consult.after,
    external_needed: externalNeeded,
  });

  const deploy = await deployEvidenceForSession(sessionId, deployDeps);
  let bugfixExhausted = false;
  let needsRedesign = false;
  try {
    const taskId = await readActiveTaskId(sessionId);
    bugfixExhausted =
      taskId !== null && (await readBugfixRounds(sessionId, taskId)) >= MAX_BUGFIX_ROUNDS;
    needsRedesign = taskId !== null && (await readNeedsRedesign(sessionId, taskId));
  } catch {
    bugfixExhausted = false;
    needsRedesign = false;
  }
  values.set('deploy.capability_ok', deploy.capabilityOk);
  values.set('deploy.accepted', deploy.accepted);
  values.set('deploy.clean', deploy.deployClean);
  values.set('deploy.bugfix_exhausted', bugfixExhausted);
  values.set('deploy.needs_redesign', needsRedesign);
  values.set('deploy.reversible', deploy.reversible);
  values.set('deploy', {
    capability_ok: deploy.capabilityOk,
    accepted: deploy.accepted,
    clean: deploy.deployClean,
    bugfix_exhausted: bugfixExhausted,
    needs_redesign: needsRedesign,
    reversible: deploy.reversible,
  });

  const frontend = await frontendEvidenceForEvent(event, frontendDeps);
  values.set('frontend.clean', frontend.clean);
  values.set('frontend.critical', frontend.critical);
  values.set('frontend.high', frontend.high);
  values.set('frontend', {
    clean: frontend.clean,
    critical: frontend.critical,
    high: frontend.high,
  });
  return values;
}
