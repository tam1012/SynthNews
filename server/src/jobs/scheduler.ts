import cron from 'node-cron';
import { getMany, query, getOne } from '../db/index.js';
import { scrapeSource, retryRedditComments } from '../services/scraper.js';
import { summarizePendingArticles, generateDigest } from '../services/summarizer.js';
import { generateId, sleep } from '../lib/utils.js';
import { rescrapeArticle, runForumRescrapeJob } from '../services/rescrape.js';
import { getFetcherForSource } from '../services/fetchers/registry.js';
import { sourceFetchers, SourceRow } from '../services/fetchers/index.js';
import { ArticleInsertInput, insertArticleIfNew, validateArticleContent } from '../services/fetchers/article-writer.js';
import {
  buildResetRetryableArticleFetchJobsSql,
  buildResetStuckArticleFetchJobsSql,
  claimArticleFetchJobs,
  enqueueDiscoveredArticles,
  markArticleFetchJobDone,
  markArticleFetchJobFailed,
  requeueShortContentArticles,
} from '../services/article-fetch-queue.js';
import {
  buildResetRetryableFailedSummariesSql,
  buildResetStuckProcessingSummariesSql,
} from '../lib/summaryRetryPolicy.js';
import { runWithJobLock } from '../lib/jobLock.js';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function getSourceScrapeTimeoutMs(source: any): number {
  const configured = Number(process.env.SOURCE_SCRAPE_TIMEOUT_MS || 0);
  if (Number.isFinite(configured) && configured >= 10_000) return configured;

  const name = String(source.name || '').toLowerCase();
  const url = String(source.url || '').toLowerCase();
  // Reddit listing now uses old.reddit HTML first (burst-safe through residential
  // proxy), with RSS lane-based fallback. Comment enrichment uses the same proxy
  // path (~3s/post). A sub enriches up to ~15 posts, so ~45-75s for comments +
  // ~15s for listing. 180s gives headroom for proxy retries, listing fallback,
  // and DB writes without false-positive timeouts.
  if (name.includes('reddit') || url.includes('reddit.com')) return 180_000;
  // VOZ now passes through Cloudflare Turnstile (~15s solve per page);
  // a full 15-thread sweep with multi-page reads needs serious headroom.
  if (name.includes('voz') || url.includes('voz.vn')) return 600_000;
  // RSS feeds may need full fallback chain (native -> worker proxy -> scrapling stealth).
  // Each layer can take 15-30s; default 45s is too tight for sources that hit all three.
  return 90_000;
}

function addScrapeJitter(minutes: number): number {
  if (minutes <= 10) return minutes;
  const jitterWindow = Math.min(10, Math.max(2, Math.floor(minutes * 0.1)));
  const jitter = Math.floor(Math.random() * (jitterWindow * 2 + 1)) - jitterWindow;
  return Math.max(5, minutes + jitter);
}

async function updateRescuedArticle(articleId: string, articleInput: ArticleInsertInput): Promise<void> {
  validateArticleContent(articleInput);
  await query(
    `UPDATE articles
     SET title = $2,
         author = $3,
         published_at = COALESCE($4, published_at),
         raw_excerpt = $5,
         raw_content = $6,
         image_url = COALESCE($7, image_url),
         metadata = $8,
         summary_status = 'pending',
         retry_count = 0,
         last_summary_error = NULL,
         summary_text = NULL,
         tldr = NULL,
         summary_short = NULL,
         hot_score = NULL,
         tags = '{}'::TEXT[],
         updated_at = NOW()
     WHERE id = $1`,
    [
      articleId,
      articleInput.title,
      articleInput.author || null,
      articleInput.publishedAt || null,
      articleInput.rawExcerpt,
      articleInput.rawContent,
      articleInput.imageUrl || null,
      articleInput.metadata ? JSON.stringify(articleInput.metadata) : null,
    ]
  );
}

// Scrape enabled sources that are due by next_run_at.
async function runScrapeJob() {
  console.log(`[${new Date().toISOString()}] Starting scrape job...`);

  const allSources = await getMany(
    `SELECT id, type, name, url, language, category, fetch_interval_minutes, parser_config
     FROM sources
     WHERE is_enabled = true
       AND (next_run_at IS NULL OR next_run_at <= NOW())
     ORDER BY COALESCE(next_run_at, created_at) ASC, name ASC`
  );

  console.log(`  Found ${allSources.length} enabled sources to scrape`);

  for (const source of allSources) {
    const logId = generateId('log');
    const startedAt = new Date().toISOString();

    const scrapeIntervalHours = Math.max(1, Math.ceil(source.fetch_interval_minutes / 60));

    try {
      console.log(`  Scraping [${source.type}] ${source.name}...`);
      const result = await withTimeout((async () => {
        const fetcher = getFetcherForSource(source, sourceFetchers);
        if (fetcher.discover) {
          const discovered = await fetcher.discover(source);
          const enqueued = await enqueueDiscoveredArticles(discovered);
          return { itemsFound: discovered.length, itemsInserted: enqueued, errors: [] as string[] };
        }
        return scrapeSource(source);
      })(), getSourceScrapeTimeoutMs(source), `Scrape source ${source.name}`);

      const nextRunDelayMinutes = addScrapeJitter(result.errors.length > 0
        ? Math.min(scrapeIntervalHours * 60 * 2, 24 * 60)
        : scrapeIntervalHours * 60);

      await query(
        `UPDATE sources SET
           last_checked_at = NOW(), last_success_at = NOW(),
           consecutive_failures = 0, last_error_message = NULL,
           next_run_at = NOW() + ($2 * INTERVAL '1 minute')
         WHERE id = $1`,
        [source.id, nextRunDelayMinutes]
      );

      // Log
      const status = result.errors.length > 0 ? (result.itemsInserted > 0 ? 'partial' : 'failed') : 'success';
      await query(
        `INSERT INTO scrape_logs (id, source_id, job_type, status, started_at, finished_at, items_found, items_inserted, error_message, metadata)
         VALUES ($1, $2, 'scrape', $3, $4, NOW(), $5, $6, $7, $8)`,
        [logId, source.id, status, startedAt, result.itemsFound, result.itemsInserted,
         result.errors.length > 0 ? result.errors.join('; ') : null,
         result.metadata ? JSON.stringify(result.metadata) : null]
      );

      console.log(`    -> ${result.itemsInserted}/${result.itemsFound} items inserted ${result.errors.length > 0 ? `(${result.errors.length} errors)` : ''}`);
    } catch (err: any) {
      console.error(`    -> ERROR: ${err.message}`);

      const failureCount = await getOne<{ consecutive_failures: number }>(
        'SELECT consecutive_failures + 1 as consecutive_failures FROM sources WHERE id = $1',
        [source.id]
      );
      const backoffMinutes = addScrapeJitter(Math.min(scrapeIntervalHours * 60 * Math.pow(2, Math.max((failureCount?.consecutive_failures || 1) - 1, 0)), 24 * 60));

      await query(
        `UPDATE sources SET
           last_checked_at = NOW(), consecutive_failures = consecutive_failures + 1,
           last_error_message = $1,
           next_run_at = NOW() + ($3 * INTERVAL '1 minute')
         WHERE id = $2`,
        [err.message.substring(0, 500), source.id, backoffMinutes]
      );

      await query(
        `INSERT INTO scrape_logs (id, source_id, job_type, status, started_at, finished_at, error_message)
         VALUES ($1, $2, 'scrape', 'failed', $3, NOW(), $4)`,
        [logId, source.id, startedAt, err.message.substring(0, 500)]
      );
    }
  }

  console.log(`[${new Date().toISOString()}] Scrape job complete.`);
}

function getDomainFromJobUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

function parseTimeoutEnv(name: string): number | null {
  const configured = Number(process.env[name] || 0);
  if (Number.isFinite(configured) && configured >= 10_000) return configured;
  return null;
}

export function getArticleFetchTimeoutMs(job: { url: string }): number {
  const configured = parseTimeoutEnv('ARTICLE_FETCH_TIMEOUT_MS');
  if (configured) return configured;

  const domain = getDomainFromJobUrl(job.url);
  const hardDomains = [
    'reuters.com',
    'wsj.com',
    'bloomberg.com',
    'ft.com',
    'economist.com',
  ];
  const isHardDomain = hardDomains.some((hardDomain) => domain === hardDomain || domain.endsWith(`.${hardDomain}`));
  if (isHardDomain) return parseTimeoutEnv('HARD_ARTICLE_FETCH_TIMEOUT_MS') || 360_000;

  return 240_000;
}

async function runArticleFetchJob() {
  console.log(`[${new Date().toISOString()}] Starting article fetch job...`);
  const limit = parseInt(process.env.MAX_ARTICLE_FETCH_JOBS_PER_RUN || '30');
  const jobs = await claimArticleFetchJobs(limit);
  let succeeded = 0;
  let failed = 0;

  const domainLastFetch = new Map<string, number>();
  const PER_DOMAIN_MIN_DELAY_MS = parseInt(process.env.FETCH_PER_DOMAIN_DELAY_MS || '10000');
  const BASE_DELAY_MS = 1500;

  for (const job of jobs) {
    const domain = getDomainFromJobUrl(job.url);
    const lastFetch = domainLastFetch.get(domain) || 0;
    const elapsed = Date.now() - lastFetch;
    const requiredDelay = lastFetch === 0 ? BASE_DELAY_MS : Math.max(BASE_DELAY_MS, PER_DOMAIN_MIN_DELAY_MS - elapsed);
    if (requiredDelay > 0) await sleep(requiredDelay);

    const source: SourceRow = {
      id: job.source_id,
      type: job.source_type,
      name: job.source_name,
      url: job.source_url,
      language: job.source_language,
      category: job.source_category,
      fetch_interval_minutes: job.source_fetch_interval_minutes,
      parser_config: job.source_parser_config,
    };

    try {
      const fetcher = getFetcherForSource(source, sourceFetchers);
      if (!fetcher.fetchArticle) {
        throw new Error(`Fetcher ${fetcher.key} does not support article fetch jobs`);
      }

      const articleInput = await withTimeout(
        fetcher.fetchArticle(job, source),
        getArticleFetchTimeoutMs(job),
        `Article fetch ${job.url}`
      );
      if (articleInput) {
        const rescueArticleId = typeof job.payload_json?.rescueArticleId === 'string' ? job.payload_json.rescueArticleId : null;
        if (rescueArticleId) {
          await updateRescuedArticle(rescueArticleId, articleInput);
        } else {
          await insertArticleIfNew(articleInput);
        }
      }
      await markArticleFetchJobDone(job.id);
      succeeded++;
    } catch (err) {
      await markArticleFetchJobFailed(job.id, err);
      failed++;
    }
    domainLastFetch.set(domain, Date.now());
  }

  console.log(`  Article fetch jobs: processed=${jobs.length}, succeeded=${succeeded}, failed=${failed}`);
}

// Summarize articles pending
async function runSummarizeJob() {
  console.log(`[${new Date().toISOString()}] Starting summarize job...`);
  try {
    const result = await summarizePendingArticles();
    console.log(`  Processed: ${result.processed}, Succeeded: ${result.succeeded}, Failed: ${result.failed}`);
  } catch (err: any) {
    console.error(`  Summarize error: ${err.message}`);
  }
}

// Generate digest
async function runDigestJob() {
  console.log(`[${new Date().toISOString()}] Starting digest generation...`);
  try {
    const digestId = await generateDigest();
    if (digestId) {
      console.log(`  Digest created: ${digestId}`);
    } else {
      console.log('  No articles to digest');
    }
  } catch (err: any) {
    console.error(`  Digest error: ${err.message}`);
  }
}

// Cleanup du lieu cu
async function runCleanupJob() {
  console.log(`[${new Date().toISOString()}] Starting cleanup...`);
  try {
    // Xoa logs cu hon 14 ngay
    const logsResult = await query(
      `DELETE FROM scrape_logs WHERE started_at < NOW() - INTERVAL '14 days'`
    );
    console.log(`  Deleted ${logsResult.rowCount} old logs`);

    // NULL raw_content cua articles cu hon 60 ngay (giu summary)
    const articlesResult = await query(
      `UPDATE articles SET raw_content = NULL
       WHERE created_at < NOW() - INTERVAL '60 days' AND raw_content IS NOT NULL`
    );
    console.log(`  Cleaned content of ${articlesResult.rowCount} old articles`);

    // Reset stuck processing items (> 5 phut = chac chan da timeout)
    const stuckStatement = buildResetStuckProcessingSummariesSql();
    const stuckResult = await query(stuckStatement.sql, stuckStatement.params);
    console.log(`  Reset ${stuckResult.rowCount} stuck articles`);

    const fetchStuckStatement = buildResetStuckArticleFetchJobsSql();
    const fetchStuckResult = await query(fetchStuckStatement.sql, fetchStuckStatement.params);
    console.log(`  Reset ${fetchStuckResult.rowCount} stuck article fetch jobs`);
  } catch (err: any) {
    console.error(`  Cleanup error: ${err.message}`);
  }
}

// Retry failed + stuck articles (mỗi 10 phút)
async function runRetryJob() {
  console.log(`[${new Date().toISOString()}] Running retry check...`);
  try {
    const stuckStatement = buildResetStuckProcessingSummariesSql();
    const stuckResult = await query(stuckStatement.sql, stuckStatement.params);
    if (stuckResult.rowCount && stuckResult.rowCount > 0) {
      console.log(`  Reset ${stuckResult.rowCount} stuck processing articles`);
    }

    // Reset 'failed' > 10 phút (tối đa 15 bài)
    const failedStatement = buildResetRetryableFailedSummariesSql(15);
    const failedResult = await query(failedStatement.sql, failedStatement.params);
    console.log(`  Reset ${failedResult.rowCount} failed articles for retry`);

    const fetchFailedStatement = buildResetRetryableArticleFetchJobsSql(15);
    const fetchFailedResult = await query(fetchFailedStatement.sql, fetchFailedStatement.params);
    console.log(`  Reset ${fetchFailedResult.rowCount} failed article fetch jobs for retry`);

    const shortContentRetry = await requeueShortContentArticles(15, parseInt(process.env.MIN_ARTICLE_TEXT_LENGTH || '500', 10));
    if (shortContentRetry.checked > 0) {
      console.log(`  Short-content rescue: checked=${shortContentRetry.checked}, enqueued=${shortContentRetry.enqueued}`);
    }

    // Retry lấy comment Reddit cho bài chưa có comment (Pullpush chậm index)
    let redditEnriched = 0;
    try {
      const redditRetry = await retryRedditComments();
      redditEnriched = redditRetry.enriched;
      console.log(`  Reddit comments retry: checked=${redditRetry.checked}, enriched=${redditRetry.enriched}, empty=${redditRetry.pullpushEmpty}, failed=${redditRetry.pullpushFailed}, noUseful=${redditRetry.noUsefulComments}, invalidUrl=${redditRetry.invalidUrl}`);
    } catch (err: any) {
      console.log(`  Reddit retry error: ${err.message}`);
    }

    // Nếu có bài được reset hoặc Reddit enriched, gọi ngay summarize job
    const totalReset = (stuckResult.rowCount || 0) + (failedResult.rowCount || 0) + redditEnriched;
    if (totalReset > 0) {
      console.log(`  Triggering summarizer for ${totalReset} retried articles...`);
      await runSummarizeJob();
    }
  } catch (err: any) {
    console.error(`  Retry error: ${err.message}`);
  }
}

export function startCronJobs() {
  const intervalHours = parseInt(process.env.SCRAPE_INTERVAL_HOURS || '1');

  setTimeout(() => {
    runWithJobLock('scrape', runScrapeJob).catch(console.error);
  }, 30_000).unref?.();

  cron.schedule('*/5 * * * *', async () => {
    runWithJobLock('scrape', runScrapeJob).catch(console.error);
  });

  // Summarize independently so slow AI never blocks source scraping.
  cron.schedule('*/10 * * * *', () => {
    runWithJobLock('summarize', runSummarizeJob).catch(console.error);
  });

  // Fetch discovered article URLs independently from source discovery.
  cron.schedule('*/5 * * * *', () => {
    runWithJobLock('article-fetch', runArticleFetchJob).catch(console.error);
  });

  // Re-scrape active forum threads every 30 minutes (at :30 and :00 of non-scrape hours)
  cron.schedule(`0,30 * * * *`, async () => {
    const currentHour = new Date().getHours();
    const currentMinute = new Date().getMinutes();
    
    // Don't run at minute 0 if it's the main scrape hour to avoid overlap
    if (currentMinute === 0 && currentHour % intervalHours === 0) {
      return;
    }

    runWithJobLock('forum-rescrape', async () => {
      const result = await runForumRescrapeJob();
      if (result.updated > 0) {
        await runWithJobLock('summarize', runSummarizeJob);
      }
    }).catch(console.error);
  });

  // Generate digest at 0:30, 6:30, 12:30, 21:30 (GMT+7 = UTC 17:30, 23:30, 5:30, 14:30)
  cron.schedule('30 17,23,5,14 * * *', () => {
    runWithJobLock('digest', runDigestJob).catch(console.error);
  });

  // Retry & fix mỗi 10 phút
  cron.schedule('*/10 * * * *', () => {
    runWithJobLock('retry', runRetryJob).catch(console.error);
  });

  // Cleanup mỗi ngày lúc 2:43 AM
  cron.schedule('43 2 * * *', () => {
    runWithJobLock('cleanup', runCleanupJob).catch(console.error);
  });

  console.log(`Cron jobs scheduled:`);
  console.log(`  - Scrape due sources: every 5 minutes plus startup check`);
  console.log(`  - Article Fetch: every 5 minutes`);
  console.log(`  - Summarize: every 10 minutes`);
  console.log(`  - Forum Rescrape: every 30 mins (max 2 times per article)`);
  console.log(`  - Digest: 0:30, 6:30, 12:30, 21:30 (GMT+7)`);
  console.log(`  - Retry: every 10 minutes`);
  console.log(`  - Cleanup: daily at 2:43 AM`);
}

// Export de co the goi thu cong qua API
export { runScrapeJob, runArticleFetchJob, runSummarizeJob, runDigestJob, runCleanupJob, rescrapeArticle, runForumRescrapeJob };
