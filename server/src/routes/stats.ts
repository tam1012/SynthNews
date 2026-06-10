import { Hono } from 'hono';
import { getMany } from '../db/index.js';

const stats = new Hono();

const TZ = 'Asia/Ho_Chi_Minh';
// Ngay theo gio VN, tinh theo thoi diem he thong lay bai ve (created_at)
const ARTICLE_LOCAL_DATE = `DATE(a.created_at AT TIME ZONE '${TZ}')`;
const JOB_LOCAL_DATE = `DATE(j.updated_at AT TIME ZONE '${TZ}')`;
// Trich domain tu URL: bo protocol, www, va phan path/query
const ARTICLE_DOMAIN = `regexp_replace(regexp_replace(lower(a.url), '^https?://(www\\.)?', ''), '[/?#].*$', '')`;
const JOB_DOMAIN = `regexp_replace(regexp_replace(lower(j.url), '^https?://(www\\.)?', ''), '[/?#].*$', '')`;

function isValidDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function toMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

stats.get('/', async (c) => {
  const toParam = c.req.query('to');
  const fromParam = c.req.query('from');

  if (toParam && !isValidDate(toParam)) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'to must be YYYY-MM-DD' } }, 400);
  }
  if (fromParam && !isValidDate(fromParam)) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'from must be YYYY-MM-DD' } }, 400);
  }

  // Mac dinh: 7 ngay gan nhat tinh theo gio VN
  const nowVn = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const defaultTo = nowVn.toISOString().slice(0, 10);
  const to = isValidDate(toParam) ? toParam : defaultTo;
  const defaultFromMs = toMs(to) - 6 * 24 * 60 * 60 * 1000;
  const from = isValidDate(fromParam) ? fromParam : new Date(defaultFromMs).toISOString().slice(0, 10);

  if (toMs(from) > toMs(to)) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'from must be <= to' } }, 400);
  }
  // Gioi han toi da 92 ngay de tranh query nang
  if (toMs(to) - toMs(from) > 92 * 24 * 60 * 60 * 1000) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'range must be <= 92 days' } }, 400);
  }

  const range = [from, to];

  const [articleByDomain, jobFailByDomain, skippedByDomain, dailyArticles, dailyFetchFail, errorTypes, aiByDay, silentDomains, totals] = await Promise.all([
    getMany<{ domain: string; articles: number }>(
      `SELECT ${ARTICLE_DOMAIN} AS domain, COUNT(*)::int AS articles
       FROM articles a
       WHERE ${ARTICLE_LOCAL_DATE} BETWEEN $1 AND $2
       GROUP BY domain`,
      range
    ),
    getMany<{ domain: string; fetch_failed: number }>(
      `SELECT ${JOB_DOMAIN} AS domain, COUNT(*)::int AS fetch_failed
       FROM article_fetch_jobs j
       WHERE j.status = 'failed' AND ${JOB_LOCAL_DATE} BETWEEN $1 AND $2
       GROUP BY domain`,
      range
    ),
    getMany<{ domain: string; skipped: number }>(
      `SELECT ${ARTICLE_DOMAIN} AS domain, COUNT(*)::int AS skipped
       FROM articles a
       WHERE a.summary_status = 'skipped' AND ${ARTICLE_LOCAL_DATE} BETWEEN $1 AND $2
       GROUP BY domain`,
      range
    ),
    getMany<{ date: string; count: number }>(
      `SELECT TO_CHAR(${ARTICLE_LOCAL_DATE}, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
       FROM articles a
       WHERE ${ARTICLE_LOCAL_DATE} BETWEEN $1 AND $2
       GROUP BY ${ARTICLE_LOCAL_DATE}
       ORDER BY date`,
      range
    ),
    getMany<{ date: string; count: number }>(
      `SELECT TO_CHAR(${JOB_LOCAL_DATE}, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
       FROM article_fetch_jobs j
       WHERE j.status = 'failed' AND ${JOB_LOCAL_DATE} BETWEEN $1 AND $2
       GROUP BY ${JOB_LOCAL_DATE}
       ORDER BY date`,
      range
    ),
    getMany<{ category: string; count: number }>(
      `SELECT CASE
                WHEN j.last_error ILIKE '%cloudflare%' OR j.last_error ILIKE '%challenge%' OR j.last_error ILIKE '%just a moment%' THEN 'Cloudflare/antibot'
                WHEN j.last_error ILIKE '%timeout%' OR j.last_error ILIKE '%timed out%' OR j.last_error ILIKE '%etimedout%' OR j.last_error ILIKE '%aborted%' THEN 'Timeout'
                WHEN j.last_error ILIKE '%429%' OR j.last_error ILIKE '%rate limit%' OR j.last_error ILIKE '%too many%' THEN 'Rate limit'
                WHEN j.last_error ILIKE '%403%' OR j.last_error ILIKE '%forbidden%' THEN '403 Forbidden'
                WHEN j.last_error ILIKE '%404%' OR j.last_error ILIKE '%not found%' THEN '404 Not found'
                WHEN j.last_error ILIKE '%502%' OR j.last_error ILIKE '%503%' OR j.last_error ILIKE '%500%' OR j.last_error ILIKE '%504%' OR j.last_error ILIKE '%bad gateway%' THEN 'Lỗi server (5xx)'
                WHEN j.last_error ILIKE '%paywall%' OR j.last_error ILIKE '%subscri%' THEN 'Paywall'
                WHEN j.last_error ILIKE '%empty%' OR j.last_error ILIKE '%no content%' OR j.last_error ILIKE '%too short%' THEN 'Nội dung rỗng/ngắn'
                WHEN j.last_error IS NULL OR btrim(j.last_error) = '' THEN 'Không rõ'
                ELSE 'Khác'
              END AS category,
              COUNT(*)::int AS count
       FROM article_fetch_jobs j
       WHERE j.status = 'failed' AND ${JOB_LOCAL_DATE} BETWEEN $1 AND $2
       GROUP BY category
       ORDER BY count DESC`,
      range
    ),
    getMany<{ date: string; done: number; failed: number; skipped: number }>(
      `SELECT TO_CHAR(${ARTICLE_LOCAL_DATE}, 'YYYY-MM-DD') AS date,
              COUNT(*) FILTER (WHERE a.summary_status = 'done')::int AS done,
              COUNT(*) FILTER (WHERE a.summary_status = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE a.summary_status = 'skipped')::int AS skipped
       FROM articles a
       WHERE ${ARTICLE_LOCAL_DATE} BETWEEN $1 AND $2
       GROUP BY ${ARTICLE_LOCAL_DATE}
       ORDER BY date`,
      range
    ),
    // Domain "im lang": co bai trong 30 ngay truoc khoang chon nhung khong co bai nao trong khoang chon
    getMany<{ domain: string; prior_count: number; last_seen: string }>(
      `WITH in_range AS (
         SELECT DISTINCT ${ARTICLE_DOMAIN} AS domain
         FROM articles a
         WHERE ${ARTICLE_LOCAL_DATE} BETWEEN $1 AND $2
       ),
       prior AS (
         SELECT ${ARTICLE_DOMAIN} AS domain,
                COUNT(*)::int AS prior_count,
                TO_CHAR(MAX(${ARTICLE_LOCAL_DATE}), 'YYYY-MM-DD') AS last_seen
         FROM articles a
         WHERE ${ARTICLE_LOCAL_DATE} BETWEEN ($1::date - INTERVAL '30 days') AND ($1::date - INTERVAL '1 day')
         GROUP BY domain
       )
       SELECT p.domain, p.prior_count, p.last_seen
       FROM prior p
       LEFT JOIN in_range r ON r.domain = p.domain
       WHERE r.domain IS NULL AND p.domain <> ''
       ORDER BY p.prior_count DESC
       LIMIT 15`,
      range
    ),
    getMany<{ articles: number; fetch_failed: number; skipped: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM articles a WHERE ${ARTICLE_LOCAL_DATE} BETWEEN $1 AND $2) AS articles,
         (SELECT COUNT(*)::int FROM article_fetch_jobs j WHERE j.status = 'failed' AND ${JOB_LOCAL_DATE} BETWEEN $1 AND $2) AS fetch_failed,
         (SELECT COUNT(*)::int FROM articles a WHERE a.summary_status = 'skipped' AND ${ARTICLE_LOCAL_DATE} BETWEEN $1 AND $2) AS skipped`,
      range
    ),
  ]);

  // Gop 3 so lieu theo domain vao 1 bang
  const domainMap = new Map<string, { domain: string; articles: number; fetchFailed: number; skipped: number }>();
  const ensure = (domain: string) => {
    const key = domain || '(không rõ)';
    if (!domainMap.has(key)) domainMap.set(key, { domain: key, articles: 0, fetchFailed: 0, skipped: 0 });
    return domainMap.get(key)!;
  };
  for (const row of articleByDomain) ensure(row.domain).articles = row.articles;
  for (const row of jobFailByDomain) ensure(row.domain).fetchFailed = row.fetch_failed;
  for (const row of skippedByDomain) ensure(row.domain).skipped = row.skipped;

  const domains = Array.from(domainMap.values())
    .map((d) => {
      const attempts = d.articles + d.fetchFailed;
      return { ...d, successRate: attempts > 0 ? d.articles / attempts : null };
    })
    .sort((a, b) => b.articles - a.articles || b.fetchFailed - a.fetchFailed);

  const summary = totals[0] || { articles: 0, fetch_failed: 0, skipped: 0 };

  return c.json({
    success: true,
    data: {
      range: { from, to, dayBasis: 'created_at' },
      summary: {
        articles: summary.articles,
        fetchFailed: summary.fetch_failed,
        skipped: summary.skipped,
        domains: domains.length,
      },
      domains,
      daily: {
        articles: dailyArticles,
        fetchFailed: dailyFetchFail,
      },
      errorTypes,
      aiByDay,
      silentDomains: silentDomains.map((s) => ({ domain: s.domain, priorCount: s.prior_count, lastSeen: s.last_seen })),
    },
  });
});

export { stats };
