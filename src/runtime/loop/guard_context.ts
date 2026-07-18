import { readFile } from 'node:fs/promises';

import type { AuditBinding } from '../../packs/schemas/pack_v2.js';
import { toolMatches } from '../../integrations/pi/tool_aliases.js';
import { sha256Hex } from '../durable/run_id.js';
import type { Event } from '../event.js';
import { readCheckpointBySession } from '../ralph/loop_stage.js';
import { sessionStateFile } from '../paths.js';
import { matchesLane } from './write_lane.js';
import { readTaskAuditCache, readTaskAuditHistory } from './task_audit_cache.js';
import {
  auditEntryCertifiesSubject,
  scopeAuditExpectedLenses,
  type AuditCacheLens,
  type ScopeAuditEntry,
  type ScopeAuditPolicy,
} from './scope_audit_policy.js';

export { auditEntryCertifiesSubject } from './scope_audit_policy.js';

export type AuditContextDeclarations = Readonly<
  Record<string, { binding: AuditBinding; policy?: ScopeAuditPolicy | null }>
>;

function asAuditCacheEntry(value: unknown): ScopeAuditEntry | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { verdict?: unknown }).verdict !== 'string'
  ) {
    return null;
  }
  const record = value as {
    verdict: string;
    subjectHash?: unknown;
    complete?: unknown;
    lenses?: unknown;
  };
  const lenses = Array.isArray(record.lenses)
    ? record.lenses.filter(
        (lens): lens is AuditCacheLens =>
          lens !== null &&
          typeof lens === 'object' &&
          typeof (lens as { id?: unknown }).id === 'string' &&
          typeof (lens as { promptHash?: unknown }).promptHash === 'string',
      )
    : undefined;
  return {
    verdict: record.verdict,
    ...(typeof record.subjectHash === 'string' ? { subjectHash: record.subjectHash } : {}),
    ...(typeof record.complete === 'boolean' ? { complete: record.complete } : {}),
    ...(lenses === undefined ? {} : { lenses }),
  };
}

async function readLocalAuditEntry(
  sessionId: string,
  key: string,
): Promise<ScopeAuditEntry | null> {
  try {
    return asAuditCacheEntry(
      JSON.parse(await readFile(sessionStateFile(sessionId, key), 'utf8')) as unknown,
    );
  } catch {
    return null;
  }
}

export async function readAuditVerdict(
  sessionId: string,
  key: string,
): Promise<string | undefined> {
  const local = await readLocalAuditEntry(sessionId, key);
  if (local !== null) return local.verdict;
  try {
    return (await readTaskAuditCache(sessionId, key))?.verdict;
  } catch {
    return undefined;
  }
}

/** Read an artifact audit only when it certifies the current exact bytes and declared lens prompts. */
export async function readFreshAuditVerdict(
  sessionId: string,
  cacheKey: string,
  liveArtifactPath?: string,
  policy?: ScopeAuditPolicy | null,
): Promise<string | undefined> {
  if (policy === null) return undefined;
  let artifactPath = liveArtifactPath;
  if (artifactPath === undefined || artifactPath === '') {
    try {
      artifactPath = (await readCheckpointBySession(sessionId))?.scopeArtifacts.at(-1);
    } catch {
      return undefined;
    }
  }
  if (artifactPath === undefined) return undefined;
  let artifact: string;
  try {
    artifact = await readFile(artifactPath, 'utf8');
  } catch {
    return undefined;
  }
  const currentHash = sha256Hex(artifact);
  const expectedLenses =
    policy === undefined ? undefined : scopeAuditExpectedLenses(artifact, policy);
  const candidates: (ScopeAuditEntry | null)[] = [];
  try {
    const [latest, history] = await Promise.all([
      readTaskAuditCache(sessionId, cacheKey),
      readTaskAuditHistory(sessionId, cacheKey),
    ]);
    candidates.push(latest, ...history.map((attempt) => attempt.entry));
  } catch {
    candidates.push(null);
  }
  candidates.push(await readLocalAuditEntry(sessionId, cacheKey));
  return candidates.find((entry) => auditEntryCertifiesSubject(entry, currentHash, expectedLenses))
    ?.verdict;
}

export interface BaseGuardContext {
  values: Map<string, unknown>;
  /** Live path only when this event writes within the pack-declared approved-artifact lane. */
  approvedArtifactPath?: string;
}

/** Build only universal context. State and audit channel ids remain opaque strings supplied by the pack. */
export async function buildBaseGuardContext(
  event: Event,
  sessionId: string,
  stateId: string,
  approvedArtifactWrites: readonly string[] | undefined,
  audits: AuditContextDeclarations,
): Promise<BaseGuardContext> {
  const values = new Map<string, unknown>();
  values.set('event', event.kind);
  if ('tool' in event) values.set('tool', event.tool);
  values.set('phase', stateId);

  const filePath = 'args' in event ? event.args?.file_path : undefined;
  const candidate =
    'tool' in event && toolMatches(event.tool, /^(Write|Edit)$/) && typeof filePath === 'string'
      ? filePath
      : undefined;
  const approvedArtifactPath =
    candidate !== undefined && matchesLane(candidate, approvedArtifactWrites ?? [])
      ? candidate
      : undefined;

  const auditValues: Record<string, string | undefined> = {};
  for (const [channel, declaration] of Object.entries(audits)) {
    const verdict =
      declaration.binding.subject === 'approved_artifact'
        ? await readFreshAuditVerdict(
            sessionId,
            declaration.binding.cache_key,
            approvedArtifactPath,
            declaration.policy,
          )
        : await readAuditVerdict(sessionId, declaration.binding.cache_key);
    auditValues[channel] = verdict;
    values.set(`audit.${channel}`, verdict);
  }
  values.set('audit', auditValues);
  return {
    values,
    ...(approvedArtifactPath === undefined ? {} : { approvedArtifactPath }),
  };
}
