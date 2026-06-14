import { query } from '../../db/index.js';

export interface HostedFetchReservation {
  allowed: boolean;
  usedCount: number;
}

export async function reserveHostedFetchAttempt(provider: string, cap: number): Promise<HostedFetchReservation> {
  const result = await query<{ used_count: number; allowed: boolean }>(
    `WITH window AS (
       SELECT date_trunc('hour', NOW()) - ((EXTRACT(hour FROM NOW())::int % 24) * INTERVAL '1 hour') AS window_start
     ), upserted AS (
       INSERT INTO hosted_fetch_usage (provider, window_start, used_count, updated_at)
       SELECT $1, window_start, 1, NOW() FROM window
       ON CONFLICT (provider, window_start) DO UPDATE
         SET used_count = CASE
           WHEN hosted_fetch_usage.used_count < $2 THEN hosted_fetch_usage.used_count + 1
           ELSE hosted_fetch_usage.used_count
         END,
         updated_at = NOW()
       RETURNING used_count
     )
     SELECT used_count, used_count <= $2 AS allowed FROM upserted`,
    [provider, cap]
  );

  const row = result.rows[0];
  return { allowed: Boolean(row?.allowed), usedCount: Number(row?.used_count || 0) };
}
