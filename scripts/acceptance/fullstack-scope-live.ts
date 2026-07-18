#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LiveScopeToolEvent {
  readonly id: string;
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  readonly path: string;
  readonly decision: 'allow' | 'deny' | 'completed';
  readonly attemptedContentSha256?: string;
}

export interface LiveScopeCommandEvent {
  readonly id: string;
  readonly name: string;
  readonly args: string;
  readonly outcome: 'completed' | 'failed';
}

export interface LiveScopeReceiptEvidence {
  readonly actionId: string;
  readonly wgId: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
}

export interface LiveScopeHandoffEvidence {
  readonly invokedVia: 'pi-native-scope-done';
  readonly commandEventId: string;
  readonly approvedArtifactSha256: string;
  readonly receiptActionId: string;
  readonly checkpointStage: 'scope_write';
  readonly loopStatus: 'started' | 'running';
  readonly underlyingStartCount: 1;
}

export interface LiveScopeEvidence {
  readonly harness: 'claude' | 'codex' | 'pi';
  readonly hostVersion: string;
  readonly trust: 'ordinary' | 'not-applicable';
  readonly nonce: string;
  readonly allowedPath: string;
  readonly deniedPath: string;
  readonly artifactBefore: 'absent';
  readonly artifactBytesBase64: string;
  readonly deniedPathAbsent: boolean;
  readonly toolEvents: readonly LiveScopeToolEvent[];
  readonly commandEvents: readonly LiveScopeCommandEvent[];
  readonly receipts: readonly LiveScopeReceiptEvidence[];
  readonly issueIdsBefore: readonly string[];
  readonly issueIdsAfter: readonly string[];
  readonly itemId: string;
  readonly activeTaskId: string;
  readonly entryCheckpointStage: 'scope';
  readonly handoff?: LiveScopeHandoffEvidence;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Verify raw-event-derived evidence only. Asserted booleans cannot replace correlated pre/post ids, exact paths,
 * exact bytes, canonical state, or the native Pi handoff receipt join.
 */
export function verifyLiveScopeEvidence(evidence: LiveScopeEvidence): void {
  if (evidence.hostVersion.trim() === '') throw new Error('host version is missing');
  if (evidence.harness === 'codex' && evidence.trust !== 'ordinary') {
    throw new Error('Codex acceptance requires ordinary persisted workspace hook trust');
  }
  const expected = Buffer.from(`scope-live-${evidence.harness}-${evidence.nonce}\n`, 'utf8');
  const expectedHash = createHash('sha256').update(expected).digest('hex');
  if (evidence.artifactBefore !== 'absent') throw new Error('artifact baseline was not absent');
  if (!Buffer.from(evidence.artifactBytesBase64, 'base64').equals(expected)) {
    throw new Error('allowed artifact bytes differ');
  }
  const allowedPre = evidence.toolEvents.find(
    (event) =>
      event.phase === 'pre' &&
      event.path === evidence.allowedPath &&
      event.decision === 'allow' &&
      event.attemptedContentSha256 === expectedHash &&
      WRITE_TOOLS.has(event.tool),
  );
  const allowedPost = evidence.toolEvents.find(
    (event) =>
      event.phase === 'post' &&
      event.path === evidence.allowedPath &&
      event.decision === 'completed' &&
      WRITE_TOOLS.has(event.tool) &&
      event.id === allowedPre?.id,
  );
  const denied = evidence.toolEvents.find(
    (event) =>
      event.phase === 'pre' &&
      event.path === evidence.deniedPath &&
      event.decision === 'deny' &&
      WRITE_TOOLS.has(event.tool),
  );
  if (
    allowedPre === undefined ||
    allowedPost === undefined ||
    denied === undefined ||
    allowedPre.id === denied.id
  ) {
    throw new Error('allowed write and denied write are not distinctly correlated to their paths');
  }
  if (!evidence.deniedPathAbsent) throw new Error('denied source path exists');
  const created = evidence.issueIdsAfter.filter((id) => !evidence.issueIdsBefore.includes(id));
  if (created.length !== 1 || created[0] !== evidence.itemId) {
    throw new Error('scope entry did not create exactly one canonical issue');
  }
  if (evidence.itemId !== evidence.activeTaskId || evidence.entryCheckpointStage !== 'scope') {
    throw new Error('canonical engagement state differs');
  }
  if (evidence.harness === 'pi') {
    const handoff = evidence.handoff;
    const command = evidence.commandEvents.find(
      (event) =>
        event.id === handoff?.commandEventId &&
        event.name === 'scope-done' &&
        event.args === `${evidence.itemId} ${evidence.allowedPath}` &&
        event.outcome === 'completed',
    );
    const receipt = evidence.receipts.find(
      (candidate) =>
        candidate.actionId === handoff?.receiptActionId &&
        candidate.wgId === evidence.itemId &&
        candidate.artifactPath === evidence.allowedPath &&
        candidate.artifactSha256 === expectedHash,
    );
    if (
      handoff === undefined ||
      handoff.invokedVia !== 'pi-native-scope-done' ||
      handoff.approvedArtifactSha256 !== expectedHash ||
      handoff.checkpointStage !== 'scope_write' ||
      (handoff.loopStatus !== 'started' && handoff.loopStatus !== 'running') ||
      handoff.underlyingStartCount !== 1 ||
      command === undefined ||
      receipt === undefined
    ) {
      throw new Error('Pi native scope-done handoff evidence is incomplete');
    }
  } else if (evidence.handoff !== undefined) {
    throw new Error('only the Pi native-callback probe carries handoff evidence');
  }
}

function parseEvidence(text: string, path: string): LiveScopeEvidence {
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== 'object')
    throw new Error(`${path}: evidence is not an object`);
  return value as LiveScopeEvidence;
}

async function verifyFile(path: string): Promise<LiveScopeEvidence> {
  const evidence = parseEvidence(await readFile(path, 'utf8'), path);
  verifyLiveScopeEvidence(evidence);
  process.stdout.write(`PASS ${evidence.harness} ${evidence.hostVersion} ${path}\n`);
  return evidence;
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== 'verify') {
    throw new Error(
      'usage: fullstack-scope-live verify <evidence.json> | verify --all <evidence-directory>',
    );
  }
  const paths =
    rest[0] === '--all'
      ? (await readdir(resolve(rest[1] ?? '.opensquid/reports/fullstack-scope-live')))
          .filter((name) => name.endsWith('.json'))
          .map((name) => resolve(rest[1] ?? '.opensquid/reports/fullstack-scope-live', name))
      : rest[0] === undefined
        ? []
        : [resolve(rest[0])];
  if (paths.length === 0) throw new Error('no live evidence files supplied');
  const evidence = await Promise.all(paths.map(verifyFile));
  const harnesses = new Set(evidence.map((entry) => entry.harness));
  if (rest[0] === '--all') {
    for (const required of ['claude', 'codex', 'pi'] as const) {
      if (!harnesses.has(required)) throw new Error(`missing ${required} live evidence`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
