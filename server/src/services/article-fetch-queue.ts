import { getMany, query } from '../db/index.js';
import { generateId, normalizePublicHttpUrl } from '../lib/utils.js';
import { matchPromoKeyword } from '../lib/promoFilter.js';
import { getBlocklistMatch, recordBlocklistHit } from './fetchers/blocklist.js';

export const MAX_ARTICLE_FETCH_RETRIES = 3;

export interface DiscoveredArticle {
  sourceId: string;
  url: string;
  title: string;
  externalId?: string | null;
  publishedAt?: string | null;
  payload?: any;
}

export interface ArticleFetchJobRow {
  id: string;
  source_id: string;
  url: string;
  title: string;
  external_id: string | null;
  published_at: string | null;
  payload_json: any;
  status: 'discovered';
  retry_count: 0;
  last_error: null;
}

export interface ArticleFetchJobClaim {
  id: string;
  source_id: string;
  url: string;
  title: string;
  external_id: string | null;
  published_at: string | null;
  payload_json: any;
  source_type: string;
  source_name: string;
  source_url: string;
  source_language: string;
  source_category: string | null;
  source_fetch_interval_minutes: number;
  source_parser_config: any;
}

export interface RescueShortContentResult {
  checked: number;
  enqueued: number;
}

export interface SqlStatement {
  sql: string;
  params: any[];
}

export function buildArticleFetchJobRow(input: DiscoveredArticle): ArticleFetchJobRow {
  const normalizedUrl = normalizePublicHttpUrl(input.url);
  if (!normalizedUrl) throw new Error('Article fetch job URL must be a public http(s) URL');

  return {
    id: generateId('afj'),
    source_id: input.sourceId,
    url: normalizedUrl,
    title: input.title.trim(),
    external_id: input.externalId || null,
    published_at: input.publishedAt || null,
    payload_json: input.payload || null,
    status: 'discovered',
    retry_count: 0,
    last_error: null,
  };
}

export function buildClaimArticleFetchJobsSql(limit: number): SqlStatement {
  return {
    sql: `WITH picked AS (
            SELECT id
            FROM article_fetch_jobs
            WHERE status = 'discovered'
            ORDER BY created_at DESC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          ), claimed AS (
            UPDATE article_fetch_jobs j
            SET status = 'fetching',
                last_error = NULL
            FROM picked
            WHERE j.id = picked.id
            RETURNING j.*
          )
          SELECT c.id, c.source_id, c.url, c.title, c.external_id, c.published_at,
                 c.payload_json,
                 s.type as source_type,
                 s.name as source_name,
                 s.url as source_url,
                 s.language as source_language,
                 s.category as source_category,
                 s.fetch_interval_minutes as source_fetch_interval_minutes,
                 s.parser_config as source_parser_config
          FROM claimed c
          JOIN sources s ON s.id = c.source_id`,
    params: [limit],
  };
}

export function buildResetStuckArticleFetchJobsSql(): SqlStatement {
  return {
    sql: `UPDATE article_fetch_jobs
          SET status = 'discovered',
              last_error = 'Reset stale fetching state',
              updated_at = NOW()
          WHERE status = 'fetching'
            AND updated_at < NOW() - INTERVAL '10 minutes'`,
    params: [],
  };
}

export function buildResetRetryableArticleFetchJobsSql(limit: number): SqlStatement {
  return {
    sql: `UPDATE article_fetch_jobs
          SET status = 'discovered',
              updated_at = NOW()
          WHERE id IN (
            SELECT id FROM article_fetch_jobs
            WHERE status = 'failed'
              AND retry_count < $1
              AND updated_at < NOW() - INTERVAL '10 minutes'
            ORDER BY updated_at ASC
            LIMIT $2
          )`,
    params: [MAX_ARTICLE_FETCH_RETRIES, limit],
  };
}

export function buildFindShortContentArticlesSql(limit: number, minLength = 500): SqlStatement {
  return {
    sql: `SELECT a.id, a.source_id, a.url, a.title, a.external_id, a.published_at, a.author,
                 a.raw_excerpt, a.raw_content, a.image_url
          FROM articles a
          JOIN sources s ON s.id = a.source_id
          WHERE a.summary_status = 'skipped'
            AND a.last_summary_error ILIKE '%source content too short%'
            AND GREATEST(length(coalesce(a.raw_content, '')), length(coalesce(a.raw_excerpt, ''))) < $1
            AND NOT EXISTS (
              SELECT 1 FROM article_fetch_jobs j
              WHERE j.source_id = a.source_id
                AND j.url = a.url
                AND j.status IN ('discovered', 'fetching', 'failed')
                AND coalesce(j.payload_json->>'rescueArticleId', '') = a.id
            )
            AND s.type IN ('rss', 'web')
          ORDER BY a.created_at DESC
          LIMIT $2`,
    params: [minLength, limit],
  };
}

export function truncateFetchJobError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || 'Unknown article fetch error');
  return message.substring(0, 500);
}

export async function enqueueDiscoveredArticles(items: DiscoveredArticle[]): Promise<number> {
  let inserted = 0;

  for (const item of items) {
    // Drop promo/deal articles before they ever become a fetch job. The keyword
    // check is title-only and free; catching it here saves a full article fetch +
    // DB insert + AI classify that would otherwise end in a summarize-time skip.
    const matchedKeyword = matchPromoKeyword(item.title);
    if (matchedKeyword) {
      console.log(`[promo-filter] Skipped at enqueue "${item.title}" (matched: "${matchedKeyword}")`);
      continue;
    }

    // Blocklist applies to every source type at enqueue (RSS already checks it
    // earlier, but web/sitemap discovery does not), so a path pattern like
    // edition.cnn.com/*/weather/video/ stops the link before it costs a fetch.
    const blockMatch = await getBlocklistMatch(item.url);
    if (blockMatch) {
      console.log(`[blocklist] Skipped at enqueue "${item.title}" from ${item.url} (pattern=${blockMatch.pattern})`);
      recordBlocklistHit(blockMatch.id).catch(() => {});
      continue;
    }

    const row = buildArticleFetchJobRow(item);
    const result = await query(
      `INSERT INTO article_fetch_jobs (id, source_id, url, title, external_id, published_at, payload_json, status, retry_count, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'discovered', 0, NULL)
       ON CONFLICT (source_id, url) DO NOTHING
       RETURNING id`,
      [row.id, row.source_id, row.url, row.title, row.external_id, row.published_at, row.payload_json]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
  }

  return inserted;
}

export async function requeueShortContentArticles(limit: number, minLength = 500): Promise<RescueShortContentResult> {
  const statement = buildFindShortContentArticlesSql(limit, minLength);
  const articles = await getMany<any>(statement.sql, statement.params);
  let enqueued = 0;

  for (const article of articles) {
    const row = buildArticleFetchJobRow({
      sourceId: article.source_id,
      url: article.url,
      title: article.title,
      externalId: article.external_id,
      publishedAt: article.published_at,
      payload: {
        rescueArticleId: article.id,
        author: article.author || null,
        rawExcerpt: article.raw_excerpt || '',
        rawContent: article.raw_content || '',
        imageUrl: article.image_url || null,
      },
    });

    const result = await query(
      `INSERT INTO article_fetch_jobs (id, source_id, url, title, external_id, published_at, payload_json, status, retry_count, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'discovered', 0, NULL)
       ON CONFLICT (source_id, url) DO UPDATE SET
         status = CASE WHEN article_fetch_jobs.status = 'done' THEN 'discovered' ELSE article_fetch_jobs.status END,
         payload_json = EXCLUDED.payload_json,
         last_error = NULL,
         updated_at = NOW()
       WHERE article_fetch_jobs.status = 'done'
       RETURNING id`,
      [row.id, row.source_id, row.url, row.title, row.external_id, row.published_at, row.payload_json]
    );
    if (result.rowCount && result.rowCount > 0) enqueued++;
  }

  return { checked: articles.length, enqueued };
}

export async function claimArticleFetchJobs(limit: number): Promise<ArticleFetchJobClaim[]> {
  const statement = buildClaimArticleFetchJobsSql(limit);
  return getMany<ArticleFetchJobClaim>(statement.sql, statement.params);
}

export async function markArticleFetchJobDone(id: string): Promise<void> {
  await query(`UPDATE article_fetch_jobs SET status = 'done', last_error = NULL WHERE id = $1`, [id]);
}

export async function markArticleFetchJobFailed(id: string, err: unknown): Promise<void> {
  await query(
    `UPDATE article_fetch_jobs
     SET status = 'failed',
         retry_count = retry_count + 1,
         last_error = $2
     WHERE id = $1`,
    [id, truncateFetchJobError(err)]
  );
}
