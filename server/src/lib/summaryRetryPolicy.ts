import { RETRYABLE_AI_ERROR_SQL_PATTERNS } from './aiRetryPolicy.js';

export const MAX_SUMMARY_RETRIES = 3;
export const STUCK_SUMMARY_MINUTES = 10;

export interface SqlStatement {
  sql: string;
  params: any[];
}

export function truncateSummaryError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || 'Unknown summary error');
  return message.substring(0, 500);
}

export function buildResetStuckProcessingSummariesSql(): SqlStatement {
  return {
    sql: `UPDATE articles
          SET summary_status = 'pending',
              last_summary_error = 'Reset stale processing state',
              updated_at = NOW()
          WHERE summary_status = 'processing'
            AND updated_at < NOW() - INTERVAL '${STUCK_SUMMARY_MINUTES} minutes'`,
    params: [],
  };
}

export function buildResetRetryableFailedSummariesSql(limit: number): SqlStatement {
  const retryPatternConditions = RETRYABLE_AI_ERROR_SQL_PATTERNS
    .map((_, index) => `lower(COALESCE(last_summary_error, '')) LIKE $${index + 3}`)
    .join('\n                 OR ');

  return {
    sql: `UPDATE articles
          SET summary_status = 'pending',
              updated_at = NOW()
          WHERE id IN (
            SELECT id FROM articles
            WHERE summary_status = 'failed'
              AND retry_count < $1
              AND (
                ${retryPatternConditions}
              )
              AND updated_at < NOW() - INTERVAL '10 minutes'
            ORDER BY updated_at ASC
            LIMIT $2
          )`,
    params: [MAX_SUMMARY_RETRIES, limit, ...RETRYABLE_AI_ERROR_SQL_PATTERNS],
  };
}
