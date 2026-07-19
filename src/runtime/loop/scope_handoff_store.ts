import type { Client } from '@libsql/client';

import { dropLegacyFullstackCheckpointObjects } from '../../packs/migrations/fullstack_flow.js';
import { SCOPE_HANDOFF_RECEIPT_PREDICATE } from './loop_events.js';

export type ScopeHandoffStoreExecutor = Pick<Client, 'execute'>;

const CHECKPOINT_HAS_MATCHING_RECEIPT_SQL =
  `EXISTS (SELECT 1 FROM loop_events WHERE wg_id=NEW.task_id AND ${SCOPE_HANDOFF_RECEIPT_PREDICATE} ` +
  `AND stage IS NOT NULL AND length(stage)>0 ` +
  `AND scope_artifact_path IS NOT NULL AND length(scope_artifact_path)>0 ` +
  `AND scope_artifact_sha256 IS NOT NULL AND length(scope_artifact_sha256)=64 ` +
  `AND scope_artifact_sha256 NOT GLOB '*[^0-9a-f]*' ` +
  `AND scope_evidence_kind IN ('approval','legacy_repair') ` +
  `AND scope_artifact_path=json_extract(NEW.scope_artifacts_json,'$[0]'))`;
const CHECKPOINT_HAS_HANDOFF_ARTIFACT_SQL = `json_valid(NEW.scope_artifacts_json) AND json_array_length(NEW.scope_artifacts_json)=1`;
const CREATE_CHECKPOINT_INSERT_GUARD_SQL =
  `CREATE TRIGGER IF NOT EXISTS trg_task_checkpoints_handoff_insert_v4 ` +
  `BEFORE INSERT ON task_checkpoints WHEN ${CHECKPOINT_HAS_HANDOFF_ARTIFACT_SQL} ` +
  `AND NOT (${CHECKPOINT_HAS_MATCHING_RECEIPT_SQL}) BEGIN ` +
  `SELECT RAISE(ABORT, 'checkpoint artifact requires a scope-handoff receipt'); END`;
const CREATE_CHECKPOINT_UPDATE_GUARD_SQL =
  `CREATE TRIGGER IF NOT EXISTS trg_task_checkpoints_handoff_update_v4 ` +
  `BEFORE UPDATE OF stage,scope_artifacts_json ON task_checkpoints ` +
  `WHEN ${CHECKPOINT_HAS_HANDOFF_ARTIFACT_SQL} ` +
  `AND NOT (${CHECKPOINT_HAS_MATCHING_RECEIPT_SQL}) BEGIN ` +
  `SELECT RAISE(ABORT, 'checkpoint artifact requires a scope-handoff receipt'); END`;

/**
 * Cross-table approval invariant. The store never interprets the opaque checkpoint state: it protects the
 * approved artifact/receipt relationship, while pack-aware admission decides whether a state is process-driven.
 */
export async function installScopeHandoffStoreInvariants(
  db: ScopeHandoffStoreExecutor,
): Promise<void> {
  await dropLegacyFullstackCheckpointObjects(db);
  for (const name of [
    'trg_task_checkpoints_automated_insert_v2',
    'trg_task_checkpoints_automated_update_v2',
    'trg_task_checkpoints_automated_insert_v3',
    'trg_task_checkpoints_automated_update_v3',
  ]) {
    await db.execute(`DROP TRIGGER IF EXISTS ${name}`);
  }
  await db.execute(CREATE_CHECKPOINT_INSERT_GUARD_SQL);
  await db.execute(CREATE_CHECKPOINT_UPDATE_GUARD_SQL);
}
