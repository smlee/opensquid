import { resolveCheckpointKey } from './checkpoint_key.js';
import { withLoopDb } from './loop_db.js';

const initialized = new Map<string, Promise<void>>();

async function ensureTable(): Promise<void> {
  await withLoopDb(async (db, url) => {
    let ready = initialized.get(url);
    if (ready === undefined) {
      ready = db
        .execute(
          `CREATE TABLE IF NOT EXISTS task_runtime_state (
          task_id TEXT NOT NULL,
          state_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (task_id, state_key)
        )`,
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          initialized.delete(url);
          throw error;
        });
      initialized.set(url, ready);
    }
    await ready;
  });
}

/** Persist pack runtime evidence under durable project/task identity for fresh per-stage sessions. */
export async function writeTaskRuntimeState(
  sessionId: string,
  stateKey: string,
  value: unknown,
  explicitTaskId?: string,
): Promise<void> {
  const taskId = explicitTaskId ?? (await resolveCheckpointKey(sessionId));
  await ensureTable();
  await withLoopDb(async (db) => {
    await db.execute({
      sql: `INSERT INTO task_runtime_state (task_id, state_key, value_json, updated_at_ms)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(task_id, state_key) DO UPDATE SET
              value_json=excluded.value_json, updated_at_ms=excluded.updated_at_ms`,
      args: [taskId, stateKey, JSON.stringify(value), Date.now()],
    });
  });
}

/** Read task-durable runtime evidence; malformed/absent state is a cache miss. */
export async function readTaskRuntimeState(
  sessionId: string,
  stateKey: string,
  explicitTaskId?: string,
): Promise<unknown> {
  const taskId = explicitTaskId ?? (await resolveCheckpointKey(sessionId));
  await ensureTable();
  return withLoopDb(async (db) => {
    const rs = await db.execute({
      sql: 'SELECT value_json FROM task_runtime_state WHERE task_id=? AND state_key=?',
      args: [taskId, stateKey],
    });
    const text = rs.rows[0]?.value_json;
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  });
}
