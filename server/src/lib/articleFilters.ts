export const LOCAL_DATE_SQL = `DATE(COALESCE(a.published_at, a.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh')`;
export const LOCAL_DATE_TEXT_SQL = `TO_CHAR(${LOCAL_DATE_SQL}, 'YYYY-MM-DD')`;
export const PUBLIC_ARTICLE_FRESHNESS_SQL = `COALESCE(a.published_at, a.created_at) <= NOW() + INTERVAL '2 hours'`;

const VALID_SUMMARY_STATUSES = ['pending', 'processing', 'done', 'failed', 'skipped'];
const VALID_FEED_TABS = ['all', 'news', 'tech', 'voz', 'reddit'];
const VALID_ARTICLE_SORTS = ['latest', 'hot'];
const VALID_QUALITY_ISSUES = ['missing_tldr', 'missing_summary_short', 'missing_tags', 'missing_hot_score', 'short_summary'];

export type ArticleListSort = 'latest' | 'hot';
export type ArticleQualityIssue = 'missing_tldr' | 'missing_summary_short' | 'missing_tags' | 'missing_hot_score' | 'short_summary';

export interface ArticleListFilterInput {
  sourceId?: string;
  status?: string;
  date?: string;
  tag?: string;
  minScore?: string;
  feedTab?: string;
  sort?: string;
  qualityIssue?: string;
  includeFollowers?: boolean;
  includeFuture?: boolean;
}

export interface ArticleListFilters {
  where: string;
  params: any[];
  nextParamIndex: number;
  sort: ArticleListSort;
}

export interface ArticleSearchFilterInput {
  query: string;
  sourceId?: string;
  date?: string;
  feedTab?: string;
  includeFuture?: boolean;
}

export interface ArticleSearchFilters {
  where: string;
  params: any[];
  nextParamIndex: number;
}

function parseMinScore(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error('minScore must be between 1 and 10');
  }
  return parsed;
}

function validateLocalDate(date?: string) {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must be YYYY-MM-DD');
  }
}

function validateFeedTab(feedTab?: string) {
  if (feedTab && !VALID_FEED_TABS.includes(feedTab)) {
    throw new Error('Invalid feedTab');
  }
}

function appendFeedTabClauses(clauses: string[], feedTab?: string) {
  if (feedTab === 'reddit') {
    clauses.push(`(s.name ILIKE '%reddit%' OR a.url ILIKE '%reddit.com%' OR a.title ILIKE '[r/%')`);
  } else if (feedTab === 'voz') {
    clauses.push(`(s.name ILIKE '%voz%' OR a.url ILIKE '%voz.vn%')`);
  } else if (feedTab === 'all') {
    clauses.push(`NOT (s.name ILIKE '%reddit%' OR a.url ILIKE '%reddit.com%' OR a.title ILIKE '[r/%' OR s.name ILIKE '%voz%' OR a.url ILIKE '%voz.vn%')`);
  } else if (feedTab === 'news') {
    clauses.push(`NOT (s.name ILIKE '%reddit%' OR a.url ILIKE '%reddit.com%' OR a.title ILIKE '[r/%' OR s.name ILIKE '%voz%' OR a.url ILIKE '%voz.vn%')`);
    clauses.push(`COALESCE(s.feed_category, 'news') = 'news'`);
  } else if (feedTab === 'tech') {
    clauses.push(`NOT (s.name ILIKE '%reddit%' OR a.url ILIKE '%reddit.com%' OR a.title ILIKE '[r/%' OR s.name ILIKE '%voz%' OR a.url ILIKE '%voz.vn%')`);
    clauses.push(`COALESCE(s.feed_category, 'news') = 'tech'`);
  }
}

export function buildArticleListFilters(input: ArticleListFilterInput): ArticleListFilters {
  if (input.status && !VALID_SUMMARY_STATUSES.includes(input.status)) {
    throw new Error('Invalid status');
  }

  validateLocalDate(input.date);

  validateFeedTab(input.feedTab);

  if (input.sort && !VALID_ARTICLE_SORTS.includes(input.sort)) {
    throw new Error('Invalid sort');
  }

  if (input.qualityIssue && !VALID_QUALITY_ISSUES.includes(input.qualityIssue)) {
    throw new Error('Invalid qualityIssue');
  }

  const sort: ArticleListSort = input.sort === 'hot' ? 'hot' : 'latest';
  const minScore = parseMinScore(input.minScore);
  const params: any[] = [];
  const clauses = ['1=1'];
  let paramIndex = 1;

  if (!input.includeFuture) {
    clauses.push(PUBLIC_ARTICLE_FRESHNESS_SQL);
  }

  if (input.sourceId) {
    clauses.push(`a.source_id = $${paramIndex++}`);
    params.push(input.sourceId);
  }
  if (input.status) {
    clauses.push(`a.summary_status = $${paramIndex++}`);
    params.push(input.status);
  }
  if (input.date) {
    clauses.push(`${LOCAL_DATE_SQL} = $${paramIndex++}`);
    params.push(input.date);
  }
  if (input.tag?.trim()) {
    clauses.push(`$${paramIndex++} = ANY(a.tags)`);
    params.push(input.tag.trim());
  }
  if (minScore !== null) {
    clauses.push(`a.hot_score >= $${paramIndex++}`);
    params.push(minScore);
  }
  appendFeedTabClauses(clauses, input.feedTab);

  if (input.qualityIssue) {
    clauses.push(`a.summary_status = 'done'`);
    if (input.qualityIssue === 'missing_tldr') {
      clauses.push(`(a.tldr IS NULL OR btrim(a.tldr) = '')`);
    } else if (input.qualityIssue === 'missing_summary_short') {
      clauses.push(`(a.summary_short IS NULL OR btrim(a.summary_short) = '')`);
    } else if (input.qualityIssue === 'missing_tags') {
      clauses.push(`(a.tags IS NULL OR cardinality(a.tags) = 0)`);
    } else if (input.qualityIssue === 'missing_hot_score') {
      clauses.push(`a.hot_score IS NULL`);
    } else if (input.qualityIssue === 'short_summary') {
      clauses.push(`length(btrim(COALESCE(a.summary_text, ''))) < 200`);
    }
  }

  // Hide clustered followers from public feed by default. Admin views (status filter,
  // qualityIssue filter, includeFollowers) bypass this so operators can still inspect them.
  const showAllRows = Boolean(
    input.includeFollowers || input.status || input.qualityIssue
  );
  if (!showAllRows) {
    clauses.push('a.parent_article_id IS NULL');
  }

  return {
    where: `WHERE ${clauses.join(' AND ')}`,
    params,
    nextParamIndex: paramIndex,
    sort,
  };
}

export function buildArticleSearchFilters(input: ArticleSearchFilterInput): ArticleSearchFilters {
  validateLocalDate(input.date);
  validateFeedTab(input.feedTab);

  const params: any[] = [`%${input.query.trim()}%`];
  const clauses = [
    `a.summary_status = 'done'`,
    `(a.title ILIKE $1 OR a.summary_short ILIKE $1 OR a.tldr ILIKE $1)`,
  ];
  let paramIndex = 2;

  if (!input.includeFuture) {
    clauses.push(PUBLIC_ARTICLE_FRESHNESS_SQL);
  }

  if (input.date) {
    clauses.push(`${LOCAL_DATE_SQL} = $${paramIndex++}`);
    params.push(input.date);
  }

  if (input.sourceId) {
    clauses.push(`a.source_id = $${paramIndex++}`);
    params.push(input.sourceId);
  }

  appendFeedTabClauses(clauses, input.feedTab);

  return {
    where: `WHERE ${clauses.join(' AND ')}`,
    params,
    nextParamIndex: paramIndex,
  };
}

export function buildArticleListOrderBy(sort: ArticleListSort): string {
  if (sort === 'hot') {
    return `ORDER BY COALESCE(a.hot_score, 0) DESC,
             COALESCE(a.published_at, a.created_at) DESC`;
  }

  return 'ORDER BY COALESCE(a.published_at, a.created_at) DESC';
}
