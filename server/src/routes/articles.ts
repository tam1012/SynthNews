import { Hono } from 'hono';
import { getMany, getOne, query, withTransaction } from '../db/index.js';
import { LOCAL_DATE_SQL, LOCAL_DATE_TEXT_SQL, PUBLIC_ARTICLE_FRESHNESS_SQL, buildArticleListFilters, buildArticleListOrderBy, buildArticleSearchFilters } from '../lib/articleFilters.js';
import { hasValidAdminToken } from '../lib/auth.js';
import { decodeArticleRows, decodeArticleTextFields } from '../lib/htmlEntities.js';
import { triggerQueueWorkerInBackground } from '../lib/jobLock.js';
import { generateId } from '../lib/utils.js';

const articles = new Hono();

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function parseBatchIds(c: any): Promise<{ ids?: string[]; response?: Response }> {
  const body = await c.req.json().catch(() => ({}));
  const rawIds = Array.isArray(body?.ids) ? body.ids : [];
  const cleanedIds: string[] = rawIds
    .map((id: unknown) => (typeof id === 'string' ? id.trim() : ''))
    .filter((id: string) => id.length > 0);
  const ids = Array.from(new Set<string>(cleanedIds));

  if (ids.length === 0) {
    return {
      response: c.json({ success: false, error: { code: 'VALIDATION', message: 'ids must contain at least one id' } }, 400),
    };
  }
  if (ids.length > 100) {
    return {
      response: c.json({ success: false, error: { code: 'VALIDATION', message: 'Batch actions support at most 100 ids' } }, 400),
    };
  }

  return { ids };
}

// Full-text search across articles
articles.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q || q.length < 2) {
    return c.json({ success: true, data: [], meta: { query: q, total: 0 } });
  }

  const limit = parseBoundedInt(c.req.query('limit'), 20, 1, 50);
  const date = c.req.query('date');
  const sourceId = c.req.query('sourceId');
  const feedTab = c.req.query('feedTab');
  const includeFuture = c.req.query('includeFuture') === '1' && hasValidAdminToken(c.req.header('Authorization'));

  let filters;
  try {
    filters = buildArticleSearchFilters({ query: q, date, sourceId, feedTab, includeFuture });
  } catch (err: any) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: err.message } }, 400);
  }

  const params = [...filters.params, limit];
  const rows = await getMany(
    `SELECT a.id, a.source_id, a.url, a.title, a.author, a.published_at,
            a.summary_short, a.tldr, a.hot_score, a.tags, a.image_url, a.created_at,
            a.translated_title,
            s.name as source_name, s.type as source_type,
            CASE WHEN a.title ILIKE $1 THEN 2 ELSE 0 END +
            CASE WHEN a.summary_short ILIKE $1 THEN 1 ELSE 0 END AS relevance
     FROM articles a
     LEFT JOIN sources s ON s.id = a.source_id
     ${filters.where}
     ORDER BY relevance DESC, COALESCE(a.published_at, a.created_at) DESC
     LIMIT $${filters.nextParamIndex}`,
    params
  );

  return c.json({ success: true, data: decodeArticleRows(rows), meta: { query: q, total: rows.length } });
});

// Danh sach tag pho bien (de UI hien topic filter chips)
articles.get('/tags', async (c) => {
  const feedTab = c.req.query('feedTab');
  const date = c.req.query('date');

  const includeFuture = c.req.query('includeFuture') === '1' && hasValidAdminToken(c.req.header('Authorization'));
  // Saved tab: no time limits — show tags from all saved articles
  const isSaved = feedTab === 'saved';
  let where = `WHERE a.summary_status = 'done'`;
  const params: any[] = [];
  let paramIndex = 1;

  if (!includeFuture && !isSaved) {
    where += ` AND ${PUBLIC_ARTICLE_FRESHNESS_SQL}`;
  }

  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !isSaved) {
    where += ` AND ${LOCAL_DATE_SQL} = $${paramIndex++}`;
    params.push(date);
  }

  // feedTab filter (reuse same logic as article list)
  if (feedTab === 'reddit') {
    where += ` AND (s.name ILIKE '%reddit%' OR a.url ILIKE '%reddit.com%' OR a.title ILIKE '[r/%')`;
  } else if (feedTab === 'voz') {
    where += ` AND (s.name ILIKE '%voz%' OR a.url ILIKE '%voz.vn%')`;
  } else if (feedTab === 'all') {
    where += ` AND NOT (s.name ILIKE '%reddit%' OR a.url ILIKE '%reddit.com%' OR a.title ILIKE '[r/%' OR s.name ILIKE '%voz%' OR a.url ILIKE '%voz.vn%')`;
  } else if (feedTab === 'news') {
    where += ` AND NOT (s.name ILIKE '%reddit%' OR a.url ILIKE '%reddit.com%' OR a.title ILIKE '[r/%' OR s.name ILIKE '%voz%' OR a.url ILIKE '%voz.vn%')`;
    where += ` AND COALESCE(s.feed_category, 'news') = 'news'`;
  } else if (feedTab === 'tech') {
    where += ` AND NOT (s.name ILIKE '%reddit%' OR a.url ILIKE '%reddit.com%' OR a.title ILIKE '[r/%' OR s.name ILIKE '%voz%' OR a.url ILIKE '%voz.vn%')`;
    where += ` AND COALESCE(s.feed_category, 'news') = 'tech'`;
  } else if (feedTab === 'saved') {
    where += ` AND a.is_saved = true`;
  }

  const rows = await getMany(
    `SELECT tag, COUNT(*)::int as count
     FROM articles a
     LEFT JOIN sources s ON s.id = a.source_id,
     LATERAL unnest(a.tags) AS tag
     ${where}
     GROUP BY tag
     ORDER BY count DESC
     LIMIT 20`,
    params
  );

  return c.json({ success: true, data: rows });
});

// Danh sach ngay co bai viet (de UI hien date picker)
articles.get('/dates', async (c) => {
  const sourceId = c.req.query('sourceId');
  const includeFuture = c.req.query('includeFuture') === '1' && hasValidAdminToken(c.req.header('Authorization'));

  let where = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (!includeFuture) {
    where += ` AND ${PUBLIC_ARTICLE_FRESHNESS_SQL}`;
  }

  if (sourceId) {
    where += ` AND a.source_id = $${paramIndex++}`;
    params.push(sourceId);
  }

  const rows = await getMany(
    `SELECT ${LOCAL_DATE_TEXT_SQL} as date, COUNT(*)::int as count
     FROM articles a
     ${where}
     GROUP BY ${LOCAL_DATE_SQL}
     ORDER BY date DESC
     LIMIT 60`,
    params
  );

  return c.json({ success: true, data: rows });
});

// Danh sach articles (phan trang, loc theo ngay va nguon)
articles.get('/', async (c) => {
  const page = parseBoundedInt(c.req.query('page'), 1, 1, 500);
  const limit = parseBoundedInt(c.req.query('limit'), 50, 1, 100);
  const sourceId = c.req.query('sourceId');
  const status = c.req.query('status');
  const date = c.req.query('date'); // YYYY-MM-DD local VN date
  const tag = c.req.query('tag');
  const minScore = c.req.query('minScore');
  const feedTab = c.req.query('feedTab');
  const sort = c.req.query('sort');
  const qualityIssue = c.req.query('qualityIssue');
  const includeFollowers = c.req.query('includeFollowers') === '1';
  const includeFuture = c.req.query('includeFuture') === '1' && hasValidAdminToken(c.req.header('Authorization'));
  const offset = (page - 1) * limit;

  let filters;
  try {
    filters = buildArticleListFilters({ sourceId, status, date, tag, minScore, feedTab, sort, qualityIssue, includeFollowers, includeFuture });
  } catch (err: any) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: err.message } }, 400);
  }

  const countResult = await getOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM articles a LEFT JOIN sources s ON s.id = a.source_id ${filters.where}`,
    filters.params
  );
  const total = parseInt(countResult?.count || '0');

  const params = [...filters.params];
  const orderBy = buildArticleListOrderBy(filters.sort);
  let paramIndex = filters.nextParamIndex;
  params.push(limit, offset);
  const rows = await getMany(
    `SELECT a.id, a.source_id, a.url, a.title, a.author, a.published_at,
            a.content_type, a.language, a.raw_excerpt, a.summary_text, a.tldr,
            a.summary_short, a.hot_score, a.tags,
            a.summary_status, a.retry_count, a.last_summary_error, a.image_url, a.created_at,
            a.translated_title, a.parent_article_id,
            (SELECT COUNT(*)::int FROM articles f WHERE f.parent_article_id = a.id) AS cluster_count,
            s.name as source_name, s.type as source_type,
            ${LOCAL_DATE_TEXT_SQL} as local_date
     FROM articles a
     LEFT JOIN sources s ON s.id = a.source_id
     ${filters.where}
     ${orderBy}
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return c.json({
    success: true,
    data: decodeArticleRows(rows),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), date: date || null, tag: tag || null, minScore: minScore || null, feedTab: feedTab || null, sort: filters.sort, qualityIssue: qualityIssue || null },
  });
});

articles.get('/fetch-jobs', async (c) => {
  const page = parseBoundedInt(c.req.query('page'), 1, 1, 500);
  const limit = parseBoundedInt(c.req.query('limit'), 50, 1, 100);
  const status = c.req.query('status');
  const offset = (page - 1) * limit;

  const params: any[] = [];
  let where = 'WHERE 1=1';
  if (status) {
    if (!['discovered', 'fetching', 'done', 'failed', 'skipped'].includes(status)) {
      return c.json({ success: false, error: { code: 'VALIDATION', message: 'Invalid fetch job status' } }, 400);
    }
    params.push(status);
    where += ` AND j.status = $${params.length}`;
  }

  const countResult = await getOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM article_fetch_jobs j ${where}`,
    params
  );
  const total = parseInt(countResult?.count || '0');

  params.push(limit, offset);
  const rows = await getMany(
    `SELECT j.id, j.source_id, j.url, j.title, j.external_id, j.published_at,
            j.status, j.retry_count, j.last_error, j.created_at, j.updated_at,
            j.skip_reason, j.error_type, j.last_http_status, j.next_attempt_at,
            s.name as source_name, s.type as source_type
     FROM article_fetch_jobs j
     LEFT JOIN sources s ON s.id = j.source_id
     ${where}
     ORDER BY CASE j.status WHEN 'failed' THEN 0 WHEN 'fetching' THEN 1 WHEN 'discovered' THEN 2 ELSE 3 END,
              j.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return c.json({
    success: true,
    data: rows,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), status: status || null },
  });
});

articles.post('/fetch-jobs/batch/retry', async (c) => {
  const parsed = await parseBatchIds(c);
  if (parsed.response) return parsed.response;
  const ids = parsed.ids!;

  const result = await query(
    `UPDATE article_fetch_jobs
     SET status = 'discovered', retry_count = 0, last_error = NULL,
         skip_reason = NULL, error_type = NULL, last_http_status = NULL, next_attempt_at = NULL,
         updated_at = NOW()
     WHERE id = ANY($1::text[])`,
    [ids]
  );

  if (result.rowCount) {
    const { runArticleFetchJob } = await import('../jobs/scheduler.js');
    await triggerQueueWorkerInBackground('article-fetch', runArticleFetchJob);
  }

  return c.json({ success: true, data: { requested: ids.length, updated: result.rowCount || 0 } });
});

articles.post('/fetch-jobs/batch/delete', async (c) => {
  const parsed = await parseBatchIds(c);
  if (parsed.response) return parsed.response;
  const ids = parsed.ids!;

  const result = await query('DELETE FROM article_fetch_jobs WHERE id = ANY($1::text[])', [ids]);

  return c.json({ success: true, data: { requested: ids.length, deleted: result.rowCount || 0 } });
});

articles.post('/fetch-jobs/:id/retry', async (c) => {
  const { id } = c.req.param();
  const existing = await getOne('SELECT id FROM article_fetch_jobs WHERE id = $1', [id]);
  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Fetch job not found' } }, 404);
  }

  await query(
    `UPDATE article_fetch_jobs
     SET status = 'discovered', retry_count = 0, last_error = NULL,
         skip_reason = NULL, error_type = NULL, last_http_status = NULL, next_attempt_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id]
  );

  const { runArticleFetchJob } = await import('../jobs/scheduler.js');
  await triggerQueueWorkerInBackground('article-fetch', runArticleFetchJob);

  return c.json({ success: true, data: { retried: true } });
});

articles.delete('/fetch-jobs/:id', async (c) => {
  const { id } = c.req.param();
  const result = await query('DELETE FROM article_fetch_jobs WHERE id = $1', [id]);
  if (!result.rowCount) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Fetch job not found' } }, 404);
  }

  return c.json({ success: true, data: { deleted: true } });
});

articles.post('/batch/reset-summary', async (c) => {
  const parsed = await parseBatchIds(c);
  if (parsed.response) return parsed.response;
  const ids = parsed.ids!;

  const result = await query(
    `UPDATE articles
     SET summary_text = NULL, tldr = NULL, summary_short = NULL, hot_score = NULL,
         tags = '{}'::TEXT[], summary_status = 'pending', retry_count = 0, last_summary_error = NULL
     WHERE id = ANY($1::text[])`,
    [ids]
  );

  if (result.rowCount) {
    const { runSummarizeJob } = await import('../jobs/scheduler.js');
    await triggerQueueWorkerInBackground('summarize', runSummarizeJob);
  }

  return c.json({ success: true, data: { requested: ids.length, updated: result.rowCount || 0 } });
});

articles.post('/batch/delete', async (c) => {
  const parsed = await parseBatchIds(c);
  if (parsed.response) return parsed.response;
  const ids = parsed.ids!;

  const deleted = await withTransaction(async (client) => {
    await client.query('DELETE FROM digest_items WHERE article_id = ANY($1::text[])', [ids]);
    const result = await client.query('DELETE FROM articles WHERE id = ANY($1::text[])', [ids]);
    return result.rowCount || 0;
  });

  return c.json({ success: true, data: { requested: ids.length, deleted } });
});

// ========== Saved Items ==========

articles.post('/:id/save', async (c) => {
  const { id } = c.req.param();
  const existing = await getOne('SELECT id FROM articles WHERE id = $1', [id]);
  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Article not found' } }, 404);
  }
  await query(`UPDATE articles SET is_saved = true WHERE id = $1`, [id]);
  return c.json({ success: true, data: { saved: true } });
});

articles.post('/:id/unsave', async (c) => {
  const { id } = c.req.param();
  const existing = await getOne('SELECT id FROM articles WHERE id = $1', [id]);
  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Article not found' } }, 404);
  }
  await query(`UPDATE articles SET is_saved = false WHERE id = $1`, [id]);
  return c.json({ success: true, data: { saved: false } });
});

articles.post('/save-external', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const url = (body.url || '').trim();
  if (!url) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'url is required' } }, 400);
  }
  try {
    new URL(url);
  } catch {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'Invalid URL' } }, 400);
  }

  // Check if URL already exists as an article
  const existing = await getOne('SELECT id, is_saved FROM articles WHERE url = $1', [url]);
  if (existing) {
    if (!existing.is_saved) {
      await query('UPDATE articles SET is_saved = true WHERE id = $1', [existing.id]);
    }
    return c.json({ success: true, data: { articleId: existing.id, alreadyExists: true, message: 'Bài viết đã có trong hệ thống, đã thêm vào Saved' } });
  }

  // Create fetch job for Manual source
  const jobId = generateId('afj');
  await query(
    `INSERT INTO article_fetch_jobs (id, source_id, url, title, external_id, published_at, payload_json, status, retry_count)
     VALUES ($1, 'src_manual', $2, $2, NULL, NULL, jsonb_build_object('isManualSave', true), 'discovered', 0)
     ON CONFLICT (source_id, url) DO NOTHING`,
    [jobId, url]
  );

  // Kick off fetch job in background
  const { runArticleFetchJob } = await import('../jobs/scheduler.js');
  await triggerQueueWorkerInBackground('article-fetch', runArticleFetchJob);

  return c.json({ success: true, data: { jobId, message: 'Đã thêm vào hàng đợi. Bài sẽ xuất hiện sau ~30-60 giây.' } });
});

articles.post('/:id/reset-summary', async (c) => {
  const { id } = c.req.param();
  const existing = await getOne('SELECT id FROM articles WHERE id = $1', [id]);
  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Article not found' } }, 404);
  }

  await query(
    `UPDATE articles
     SET summary_text = NULL, tldr = NULL, summary_short = NULL, hot_score = NULL,
         tags = '{}'::TEXT[], summary_status = 'pending', retry_count = 0, last_summary_error = NULL
     WHERE id = $1`,
    [id]
  );

  // Trigger summarize job ngay lập tức (background, không chờ)
  const { runSummarizeJob } = await import('../jobs/scheduler.js');
  await triggerQueueWorkerInBackground('summarize', runSummarizeJob);

  const row = await getOne(
    `SELECT a.*, s.name as source_name, s.type as source_type
     FROM articles a
     LEFT JOIN sources s ON s.id = a.source_id
     WHERE a.id = $1`,
    [id]
  );

  return c.json({ success: true, data: decodeArticleTextFields(row) });
});

articles.delete('/:id', async (c) => {
  const { id } = c.req.param();

  const deleted = await withTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM articles WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rowCount === 0) return false;
    await client.query('DELETE FROM digest_items WHERE article_id = $1', [id]);
    await client.query('DELETE FROM articles WHERE id = $1', [id]);
    return true;
  });
  if (!deleted) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Article not found' } }, 404);
  }

  return c.json({ success: true, data: { deleted: true } });
});

// Detach an article from its cluster (admin: when clustering was wrong).
// Promotes the article back to leader status and clears its skipped marker so it can be
// re-summarized by the AI pipeline.
articles.post('/:id/uncluster', async (c) => {
  const { id } = c.req.param();
  const article = await getOne<any>(
    'SELECT id, parent_article_id, summary_status FROM articles WHERE id = $1',
    [id]
  );
  if (!article) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Article not found' } }, 404);
  }
  if (!article.parent_article_id) {
    return c.json({ success: false, error: { code: 'NOT_A_FOLLOWER', message: 'Bài này không phải follower của cụm nào.' } }, 400);
  }

  // Reset to pending so the summarizer picks it up on the next run.
  await query(
    `UPDATE articles
     SET parent_article_id = NULL,
         summary_status = CASE WHEN summary_status = 'skipped' THEN 'pending' ELSE summary_status END,
         last_summary_error = NULL
     WHERE id = $1`,
    [id]
  );

  const { runSummarizeJob: runSummarizeForUncluster } = await import('../jobs/scheduler.js');
  await triggerQueueWorkerInBackground('summarize', runSummarizeForUncluster);

  return c.json({ success: true, message: 'Đã tách khỏi cụm và xếp lịch tóm tắt lại.' });
});

// Force-attach an article into another cluster (admin: when auto-clustering missed it).
// The target leader must itself be a leader (parent_article_id IS NULL).
articles.post('/:id/cluster', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const targetId = typeof body?.parent_article_id === 'string' ? body.parent_article_id.trim() : '';

  if (!targetId) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'parent_article_id is required' } }, 400);
  }
  if (targetId === id) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'Cannot cluster an article into itself' } }, 400);
  }

  const clusterResult = await withTransaction(async (client) => {
    const article = await client.query('SELECT id FROM articles WHERE id = $1 FOR UPDATE', [id]);
    if (article.rowCount === 0) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Article not found' };

    const target = await client.query<any>('SELECT id, parent_article_id FROM articles WHERE id = $1 FOR UPDATE', [targetId]);
    if (target.rowCount === 0) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Target leader not found' };
    if (target.rows[0].parent_article_id) {
      return { ok: false, status: 400, code: 'TARGET_NOT_LEADER', message: 'Bài đích đã là follower trong cụm khác.' };
    }

    await client.query(
      `UPDATE articles
       SET parent_article_id = $1,
           summary_status = 'skipped',
           last_summary_error = $2
       WHERE id = $3`,
      [targetId, `Đã gom cụm thủ công vào bài ${targetId}`, id]
    );

    // Re-parent any followers that pointed at the now-demoted article so the cluster stays flat.
    await client.query(
      `UPDATE articles SET parent_article_id = $1 WHERE parent_article_id = $2`,
      [targetId, id]
    );
    return { ok: true, status: 200 };
  });

  if (!clusterResult.ok) {
    return c.json({ success: false, error: { code: clusterResult.code, message: clusterResult.message } }, clusterResult.status as any);
  }

  return c.json({ success: true, message: `Đã gom bài vào cụm ${targetId}.` });
});

// Chi tiet article
articles.get('/:id', async (c) => {
  const { id } = c.req.param();
  const row = await getOne<any>(
    `SELECT a.id, a.source_id, a.url, a.title, a.author, a.published_at,
            a.content_type, a.language, a.raw_excerpt, a.summary_text, a.tldr,
            a.summary_short, a.hot_score, a.tags,
            a.summary_status, a.retry_count, a.last_summary_error, a.image_url, a.created_at, a.updated_at,
            a.translated_title, a.parent_article_id,
            s.name as source_name, s.type as source_type
     FROM articles a
     LEFT JOIN sources s ON s.id = a.source_id
     WHERE a.id = $1`,
    [id]
  );
  if (!row) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Article not found' } }, 404);
  }

  // Find sibling articles in the same cluster.
  // - If this article is a leader (parent_article_id IS NULL), siblings are all followers.
  // - If this article is a follower, siblings are: leader + other followers (excluding self).
  const leaderId = row.parent_article_id || row.id;
  const siblings = await getMany<any>(
    `SELECT a.id, a.url, a.title, a.translated_title, a.published_at, a.image_url,
            a.parent_article_id,
            s.name as source_name, s.type as source_type
     FROM articles a
     LEFT JOIN sources s ON s.id = a.source_id
     WHERE (a.id = $1 OR a.parent_article_id = $1)
       AND a.id <> $2
     ORDER BY a.published_at ASC NULLS LAST, a.created_at ASC`,
    [leaderId, id]
  );

  const decoded = decodeArticleTextFields(row);
  return c.json({
    success: true,
    data: {
      ...decoded,
      cluster_leader_id: leaderId,
      cluster_siblings: decodeArticleRows(siblings),
    },
  });
});

// Manual Rescrape (for Admin / per-article button)
// - Forum (VOZ/Reddit): refetch comments via rescrape service
// - Non-forum (RSS/HTML/GitHub Trending): enqueue a fetch job with rescueArticleId so the fetcher overwrites raw_content + resets summary state
articles.post('/:id/rescrape', async (c) => {
  const { id } = c.req.param();
  const article = await getOne<any>(
    `SELECT a.id, a.url, a.source_id, s.name as source_name, s.type as source_type
     FROM articles a LEFT JOIN sources s ON s.id = a.source_id
     WHERE a.id = $1`,
    [id]
  );
  if (!article) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Article not found' } }, 404);
  }

  const { rescrapeArticle } = await import('../services/rescrape.js');
  const { runSummarizeJob, runArticleFetchJob } = await import('../jobs/scheduler.js');

  const isForum = /voz|reddit/i.test(article.source_name || article.url || '');

  if (isForum) {
    const updated = await rescrapeArticle(id, true);
    if (updated) {
      await triggerQueueWorkerInBackground('summarize', runSummarizeJob);
      return c.json({ success: true, message: 'Đã lấy lại nội dung forum và xếp lịch tóm tắt.' });
    }
    return c.json({
      success: false,
      error: { code: 'RESCRAPE_NO_UPDATE', message: 'Không lấy được nội dung mới (fetch lỗi hoặc nội dung không đổi).' },
    });
  }

  // Non-forum: enqueue a rescue fetch job. The article-fetch job runner will call
  // updateRescuedArticle which overwrites raw_content + clears summary state.
  const jobId = generateId('afj');
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO article_fetch_jobs (id, source_id, url, title, external_id, published_at, payload_json, status, retry_count, last_error)
       SELECT $1, a.source_id, a.url, a.title, NULL, a.published_at,
              jsonb_build_object('rescueArticleId', a.id),
              'discovered', 0, NULL
         FROM articles a
        WHERE a.id = $2
        ON CONFLICT (source_id, url) DO UPDATE
          SET status = 'discovered', retry_count = 0, last_error = NULL,
              payload_json = EXCLUDED.payload_json`,
      [jobId, id]
    );

    // Also pre-reset summary state so the UI immediately reflects "pending"
    await client.query(
      `UPDATE articles
         SET summary_status = 'pending', retry_count = 0, last_summary_error = NULL
       WHERE id = $1`,
      [id]
    );
  });

  // Kick off the fetch job + summarize asynchronously
  if (typeof runArticleFetchJob === 'function') {
    await triggerQueueWorkerInBackground('article-fetch', runArticleFetchJob);
  }
  await triggerQueueWorkerInBackground('summarize', runSummarizeJob);

  return c.json({ success: true, message: 'Đã xếp lịch fetch lại nội dung gốc và tóm tắt lại bằng AI.' });
});

export { articles };
