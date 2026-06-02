import { pool } from '../db/index.js';

function lockKeyForName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return hash;
}

export async function runWithJobLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  const lockKey = lockKeyForName(name);
  let destroyClient = false;

  try {
    const lockResult = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!lockResult.rows[0]?.locked) {
      console.log(`Skipping ${name}: previous run is still active.`);
      return null;
    }

    try {
      return await fn();
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      } catch (err) {
        destroyClient = true;
        console.error(`Failed to release advisory lock for ${name}; destroying PostgreSQL client.`, err);
      }
    }
  } finally {
    client.release(destroyClient);
  }
}
