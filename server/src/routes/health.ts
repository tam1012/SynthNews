import { Hono } from 'hono';
import { getOne, getMany } from '../db/index.js';
import { runScrapeJob, runArticleFetchJob, runSummarizeJob, runDigestJob, runCleanupJob } from '../jobs/scheduler.js';
import { getDeployInfo, getPublicChecks, getRuntimeInfo } from '../lib/runtime-status.js';

const health = new Hono();

health.get('/live', async (c) => {
  try {
    await getOne('SELECT 1');
    return c.json({ success: true, data: { status: 'ok' } });
  } catch {
    return c.json({ success: false, error: { code: 'HEALTH_CHECK_FAILED', message: 'Database unavailable' } }, 500);
  }
});

function num(value: unknown): number {
  return Number(value || 0);
}

type SourceQualityStatus = 'healthy' | 'low_yield' | 'failing' | 'stale' | 'disabled';

async function getScraplingStatus(): Promise<{ configured: boolean; ok: boolean; message: string }> {
  const url = process.env.SCRAPLING_SERVICE_URL;
  if (!url) return { configured: false, ok: false, message: 'SCRAPLING_SERVICE_URL not configured' };
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json() as { ok?: boolean };
    return { configured: true, ok: data.ok === true, message: data.ok ? 'Scrapling sidecar ready' : 'Scrapling unhealthy' };
  } catch (err: any) {
    return { configured: true, ok: false, message: `Scrapling unreachable: ${err.message}` };
  }
}

function getSourceQualityStatus(source: any): SourceQualityStatus {
  if (!source.is_enabled) return 'disabled';
  if (num(source.consecutive_failures) > 0) return 'failing';
  if (!source.last_success_at) return 'stale';
  const lastSuccessMs = new Date(source.last_success_at).getTime();
  if (Number.isFinite(lastSuccessMs) && Date.now() - lastSuccessMs > 3 * 24 * 60 * 60 * 1000) return 'stale';
  const runs24h = num(source.runs_24h);
  const found24h = num(source.items_found_24h);
  const inserted24h = num(source.items_inserted_24h);
  if (runs24h >= 2 && found24h > 0 && inserted24h === 0) return 'low_yield';
  return 'healthy';
}

health.get('/', async (c) => {
  try {
    const dbCheck = await getOne('SELECT NOW() as time');
    const scrapling = await getScraplingStatus();
    const publicChecksPromise = getPublicChecks();

    const sourcesCount = await getOne<{ total: string; enabled: string; due: string; failing: string; backed_off: string }>(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE is_enabled = true) as enabled,
              COUNT(*) FILTER (WHERE is_enabled = true AND (next_run_at IS NULL OR next_run_at <= NOW())) as due,
              COUNT(*) FILTER (WHERE is_enabled = true AND consecutive_failures > 0) as failing,
              COUNT(*) FILTER (WHERE is_enabled = true AND consecutive_failures > 0 AND next_run_at > NOW()) as backed_off
       FROM sources`
    );

    const articlesCount = await getOne<{ total: string; pending: string; processing: string; done: string; failed: string; skipped: string; retryable_failed: string }>(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE summary_status = 'pending') as pending,
              COUNT(*) FILTER (WHERE summary_status = 'processing') as processing,
              COUNT(*) FILTER (WHERE summary_status = 'done') as done,
              COUNT(*) FILTER (WHERE summary_status = 'failed') as failed,
              COUNT(*) FILTER (WHERE summary_status = 'skipped') as skipped,
              COUNT(*) FILTER (WHERE summary_status = 'failed' AND retry_count < 3) as retryable_failed
       FROM articles`
    );

    const articleFetchJobsCount = await getOne<{ total: string; discovered: string; fetching: string; done: string; failed: string; retryable_failed: string }>(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE status = 'discovered') as discovered,
              COUNT(*) FILTER (WHERE status = 'fetching') as fetching,
              COUNT(*) FILTER (WHERE status = 'done') as done,
              COUNT(*) FILTER (WHERE status = 'failed') as failed,
              COUNT(*) FILTER (WHERE status = 'failed' AND retry_count < 3) as retryable_failed
       FROM article_fetch_jobs`
    );

    const lastDigest = await getOne(
      `SELECT digest_date, title, article_count FROM digests WHERE status = 'done' ORDER BY digest_date DESC LIMIT 1`
    );

    const recentLogs = await getMany(
      `SELECT source_id, job_type, status, started_at, items_found, items_inserted, error_message
       FROM scrape_logs ORDER BY started_at DESC LIMIT 5`
    );

    const forumTotals = await getMany<{
      kind: string;
      threads_seen: string;
      inserted: string;
      skipped_few_comments: string;
      skipped_few_useful_comments: string;
      skipped_duplicate: string;
      fetch_errors: string;
    }>(
      `SELECT metadata->'forum'->>'kind' as kind,
              SUM((metadata->'forum'->>'threadsSeen')::int) as threads_seen,
              SUM((metadata->'forum'->>'inserted')::int) as inserted,
              SUM((metadata->'forum'->>'skippedFewComments')::int) as skipped_few_comments,
              SUM((metadata->'forum'->>'skippedFewUsefulComments')::int) as skipped_few_useful_comments,
              SUM((metadata->'forum'->>'skippedDuplicate')::int) as skipped_duplicate,
              SUM((metadata->'forum'->>'fetchErrors')::int) as fetch_errors
       FROM scrape_logs
       WHERE metadata ? 'forum'
         AND started_at >= NOW() - INTERVAL '24 hours'
       GROUP BY metadata->'forum'->>'kind'
       ORDER BY kind`
    );

    const forumRecent = await getMany(
      `SELECT sl.source_id, s.name as source_name, sl.job_type, sl.status, sl.started_at,
              sl.items_found, sl.items_inserted, sl.error_message, sl.metadata->'forum' as forum
       FROM scrape_logs sl
       LEFT JOIN sources s ON s.id = sl.source_id
       WHERE sl.metadata ? 'forum'
       ORDER BY sl.started_at DESC
       LIMIT 8`
    );

    const sourceQualityRows = await getMany(
      `SELECT s.id, s.name, s.type, s.is_enabled, s.last_checked_at, s.last_success_at,
              s.last_error_message, s.consecutive_failures, s.next_run_at,
              COUNT(sl.id) FILTER (WHERE sl.started_at >= NOW() - INTERVAL '24 hours') as runs_24h,
              COALESCE(SUM(sl.items_found) FILTER (WHERE sl.started_at >= NOW() - INTERVAL '24 hours'), 0) as items_found_24h,
              COALESCE(SUM(sl.items_inserted) FILTER (WHERE sl.started_at >= NOW() - INTERVAL '24 hours'), 0) as items_inserted_24h,
              COUNT(sl.id) FILTER (WHERE sl.started_at >= NOW() - INTERVAL '24 hours' AND sl.status = 'failed') as failed_runs_24h,
              COUNT(sl.id) FILTER (WHERE sl.started_at >= NOW() - INTERVAL '7 days') as runs_7d,
              COALESCE(SUM(sl.items_found) FILTER (WHERE sl.started_at >= NOW() - INTERVAL '7 days'), 0) as items_found_7d,
              COALESCE(SUM(sl.items_inserted) FILTER (WHERE sl.started_at >= NOW() - INTERVAL '7 days'), 0) as items_inserted_7d,
              COUNT(sl.id) FILTER (WHERE sl.started_at >= NOW() - INTERVAL '7 days' AND sl.status = 'failed') as failed_runs_7d
       FROM sources s
       LEFT JOIN scrape_logs sl ON sl.source_id = s.id
       GROUP BY s.id
       ORDER BY s.is_enabled DESC, s.consecutive_failures DESC, s.last_success_at ASC NULLS FIRST, s.name ASC`
    );

    const sourceQuality = sourceQualityRows.map((row: any) => {
      const status = getSourceQualityStatus(row);
      const found24h = num(row.items_found_24h);
      const inserted24h = num(row.items_inserted_24h);
      const found7d = num(row.items_found_7d);
      const inserted7d = num(row.items_inserted_7d);
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        isEnabled: Boolean(row.is_enabled),
        status,
        lastCheckedAt: row.last_checked_at,
        lastSuccessAt: row.last_success_at,
        lastErrorMessage: row.last_error_message,
        consecutiveFailures: num(row.consecutive_failures),
        nextRunAt: row.next_run_at,
        runs24h: num(row.runs_24h),
        itemsFound24h: found24h,
        itemsInserted24h: inserted24h,
        failedRuns24h: num(row.failed_runs_24h),
        insertRate24h: found24h > 0 ? inserted24h / found24h : null,
        runs7d: num(row.runs_7d),
        itemsFound7d: found7d,
        itemsInserted7d: inserted7d,
        failedRuns7d: num(row.failed_runs_7d),
        insertRate7d: found7d > 0 ? inserted7d / found7d : null,
      };
    });

    const sourceQualitySummary = sourceQuality.reduce((acc: Record<string, number>, row: any) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, { healthy: 0, low_yield: 0, failing: 0, stale: 0, disabled: 0 });

    const forum = {
      totals24h: forumTotals.map((row) => ({
        kind: row.kind,
        threadsSeen: num(row.threads_seen),
        inserted: num(row.inserted),
        skippedFewComments: num(row.skipped_few_comments),
        skippedFewUsefulComments: num(row.skipped_few_useful_comments),
        skippedDuplicate: num(row.skipped_duplicate),
        fetchErrors: num(row.fetch_errors),
      })),
      recent: forumRecent,
    };
    const deploy = getDeployInfo();
    const runtime = getRuntimeInfo(Boolean(dbCheck));
    const publicChecks = await publicChecksPromise;

    return c.json({
      success: true,
      data: {
        status: 'ok',
        time: dbCheck?.time,
        deploy,
        runtime,
        publicChecks,
        sources: {
          total: parseInt(sourcesCount?.total || '0'),
          enabled: parseInt(sourcesCount?.enabled || '0'),
          due: parseInt(sourcesCount?.due || '0'),
          failing: parseInt(sourcesCount?.failing || '0'),
          backed_off: parseInt(sourcesCount?.backed_off || '0'),
        },
        articles: {
          total: parseInt(articlesCount?.total || '0'),
          pending: parseInt(articlesCount?.pending || '0'),
          processing: parseInt(articlesCount?.processing || '0'),
          done: parseInt(articlesCount?.done || '0'),
          failed: parseInt(articlesCount?.failed || '0'),
          skipped: parseInt(articlesCount?.skipped || '0'),
          retryable_failed: parseInt(articlesCount?.retryable_failed || '0'),
        },
        articleFetchJobs: {
          total: parseInt(articleFetchJobsCount?.total || '0'),
          discovered: parseInt(articleFetchJobsCount?.discovered || '0'),
          fetching: parseInt(articleFetchJobsCount?.fetching || '0'),
          done: parseInt(articleFetchJobsCount?.done || '0'),
          failed: parseInt(articleFetchJobsCount?.failed || '0'),
          retryable_failed: parseInt(articleFetchJobsCount?.retryable_failed || '0'),
        },
        lastDigest: lastDigest || null,
        sourceQuality,
        sourceQualitySummary,
        scrapling,
        forum,
        recentLogs,
      },
    });
  } catch (err: any) {
    return c.json({
      success: false,
      error: { code: 'HEALTH_CHECK_FAILED', message: err.message },
    }, 500);
  }
});

// Manual trigger endpoints (POST, can auth)
health.post('/trigger/scrape', async (c) => {
  runScrapeJob().catch(console.error);
  return c.json({ success: true, data: { message: 'Triggered scrape discovery job' } });
});

health.post('/trigger/fetch-articles', async (c) => {
  runArticleFetchJob().catch(console.error);
  return c.json({ success: true, data: { message: 'Triggered article fetch job' } });
});

health.post('/trigger/summarize', async (c) => {
  runSummarizeJob().catch(console.error);
  return c.json({ success: true, data: { message: 'Triggered summarize job' } });
});

health.post('/trigger/digest', async (c) => {
  runDigestJob().catch(console.error);
  return c.json({ success: true, data: { message: 'Triggered digest job' } });
});

health.post('/trigger/cleanup', async (c) => {
  runCleanupJob().catch(console.error);
  return c.json({ success: true, data: { message: 'Triggered cleanup job' } });
});

export { health };
