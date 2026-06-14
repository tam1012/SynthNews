import { pool } from '../db/index.js';

function lockKeyForName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return hash;
}

interface JobLockLease {
  release(destroyClient?: boolean): Promise<void>;
}

export interface BackgroundJobTriggerResult {
  name: string;
  status: 'started' | 'already_running';
}

function startBackgroundJob<T>(
  name: string,
  fn: () => Promise<T>,
  cleanup?: () => Promise<void>
): BackgroundJobTriggerResult {
  void (async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`Background job ${name} failed:`, err);
    } finally {
      if (cleanup) await cleanup();
    }
  })();

  return { name, status: 'started' };
}

async function tryAcquireJobLock(name: string): Promise<JobLockLease | null> {
  const client = await pool.connect();
  const lockKey = lockKeyForName(name);
  let released = false;

  try {
    const lockResult = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!lockResult.rows[0]?.locked) {
      client.release(false);
      console.log(`Skipping ${name}: previous run is still active.`);
      return null;
    }
  } catch (err) {
    client.release(true);
    throw err;
  }

  return {
    async release(destroyClient = false) {
      if (released) return;
      released = true;
      let shouldDestroy = destroyClient;
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      } catch (err) {
        shouldDestroy = true;
        console.error(`Failed to release advisory lock for ${name}; destroying PostgreSQL client.`, err);
      } finally {
        client.release(shouldDestroy);
      }
    },
  };
}

export async function runWithJobLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const lease = await tryAcquireJobLock(name);
  if (!lease) return null;

  try {
    return await fn();
  } finally {
    await lease.release();
  }
}

export async function triggerLockedJobInBackground<T>(
  name: string,
  fn: () => Promise<T>
): Promise<BackgroundJobTriggerResult> {
  const lease = await tryAcquireJobLock(name);
  if (!lease) return { name, status: 'already_running' };

  return startBackgroundJob(name, fn, () => lease.release());
}

export async function triggerQueueWorkerInBackground<T>(
  name: string,
  fn: () => Promise<T>
): Promise<BackgroundJobTriggerResult> {
  return startBackgroundJob(name, fn);
}
