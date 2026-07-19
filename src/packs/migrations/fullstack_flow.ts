import type { Client } from '@libsql/client';

/** Remove obsolete database objects emitted by an older built-in pack runtime. Compatibility only. */
export async function dropLegacyFullstackLoopEventObjects(
  db: Pick<Client, 'execute'>,
): Promise<void> {
  await db.execute('DROP TRIGGER IF EXISTS trg_loop_events_scope_write_entry');
  await db.execute('DROP INDEX IF EXISTS idx_loop_events_scope_write_legacy');
}

/** Remove obsolete checkpoint guards that encoded one pack's state ids. */
export async function dropLegacyFullstackCheckpointObjects(
  db: Pick<Client, 'execute'>,
): Promise<void> {
  await db.execute('DROP TRIGGER IF EXISTS trg_task_checkpoints_scope_write_insert');
  await db.execute('DROP TRIGGER IF EXISTS trg_task_checkpoints_scope_write_update');
}
