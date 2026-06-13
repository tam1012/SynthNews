import { getOne, getMany, query } from '../../db/index.js';
import { decodeHtmlEntities } from '../../lib/htmlEntities.js';
import { createContentHash, generateId, truncate } from '../../lib/utils.js';
import {
  CLUSTER_WINDOW_HOURS,
  NOVELTY_THRESHOLD,
  SIMILARITY_THRESHOLD,
  TITLE_LOCK_THRESHOLD,
  buildClusterSignature,
  computeNovelty,
  computeSimilarity,
} from '../../lib/similarity.js';

interface ArticleWriterSource {
  id: string;
  language: string;
}

export const MIN_ARTICLE_TEXT_LENGTH = parseInt(typeof process !== 'undefined' ? process.env.MIN_ARTICLE_TEXT_LENGTH || '500' : '500', 10);
const SHORT_WIRE_TEXT_LENGTH = 450;
const CJK_ARTICLE_TEXT_LENGTH = 160;
const FUTURE_PUBLISHED_AT_TOLERANCE_MS = 2 * 60 * 60 * 1000;

export class ArticleContentTooShortError extends Error {
  constructor(length: number, minLength: number) {
    super(`Article content too short after fetch (${length} characters, minimum ${minLength})`);
    this.name = 'ArticleContentTooShortError';
  }
}

function normalizeTextLength(value: string): number {
  return value.replace(/\s+/g, ' ').trim().length;
}

function isCjkLanguage(language: string | null | undefined): boolean {
  return /^(zh|ja|ko)(-|$)/i.test(language || '');
}

function countCjkCharacters(value: string): number {
  const matches = value.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  return matches ? matches.length : 0;
}

export function getEffectiveMinArticleTextLength(input: Pick<ArticleInsertInput, 'source' | 'rawContent' | 'rawExcerpt'>): number {
  const baseMin = Math.max(1, MIN_ARTICLE_TEXT_LENGTH || 500);
  const text = `${input.rawContent || ''} ${input.rawExcerpt || ''}`;
  const cjkChars = countCjkCharacters(text);

  if (isCjkLanguage(input.source.language) || cjkChars >= CJK_ARTICLE_TEXT_LENGTH) {
    return Math.min(baseMin, CJK_ARTICLE_TEXT_LENGTH);
  }

  return Math.min(baseMin, SHORT_WIRE_TEXT_LENGTH);
}

export function sanitizePublishedAtForInsert(
  publishedAt: string | null | undefined,
  now: Date = new Date()
): { publishedAt: string; warning: { original_published_at: string; replacement_published_at: string; tolerance_hours: number } | null } {
  const fallback = now.toISOString();
  if (!publishedAt) return { publishedAt: fallback, warning: null };

  const parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed)) return { publishedAt, warning: null };
  if (parsed <= now.getTime() + FUTURE_PUBLISHED_AT_TOLERANCE_MS) {
    return { publishedAt, warning: null };
  }

  return {
    publishedAt: fallback,
    warning: {
      original_published_at: publishedAt,
      replacement_published_at: fallback,
      tolerance_hours: 2,
    },
  };
}

function mergeMetadataWithPublishDateWarning(metadata: any, warning: ReturnType<typeof sanitizePublishedAtForInsert>['warning']): any {
  if (!warning) return metadata || null;
  if (!metadata) return { publish_date_warning: warning };
  if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    return { ...metadata, publish_date_warning: warning };
  }
  return { original_metadata: metadata, publish_date_warning: warning };
}

export function validateArticleContent(input: ArticleInsertInput): void {
  const contentType = input.contentType || 'article';
  const minLength = getEffectiveMinArticleTextLength(input);
  const length = Math.max(normalizeTextLength(input.rawContent || ''), normalizeTextLength(input.rawExcerpt || ''));

  if (contentType === 'article' && length < minLength) {
    throw new ArticleContentTooShortError(length, minLength);
  }
}

export interface ArticleInsertInput {
  source: ArticleWriterSource;
  url: string;
  title: string;
  author?: string | null;
  publishedAt?: string | null;
  rawExcerpt: string;
  rawContent: string;
  imageUrl?: string | null;
  externalId?: string | null;
  contentHashSeed?: string;
  excerptMaxLength?: number;
  contentMaxLength?: number;
  contentType?: 'article' | 'video';
  metadata?: any;
}

export interface ArticleInsertRow {
  id: string;
  source_id: string;
  external_id: string | null;
  url: string;
  title: string;
  author: string | null;
  published_at: string | null;
  content_type: 'article' | 'video';
  language: string;
  raw_excerpt: string;
  raw_content: string;
  content_hash: string;
  image_url: string | null;
  metadata: any;
  summary_status: 'pending' | 'skipped';
  retry_count: 0;
  last_summary_error: string | null;
  parent_article_id: string | null;
  cluster_signature: string | null;
}

export function buildArticleInsertRow(input: ArticleInsertInput): ArticleInsertRow {
  const title = decodeHtmlEntities(input.title).trim();
  const fullRawExcerpt = decodeHtmlEntities(input.rawExcerpt || '');
  const fullRawContent = decodeHtmlEntities(input.rawContent || '');
  const rawExcerpt = truncate(fullRawExcerpt, input.excerptMaxLength || 500);
  const rawContent = truncate(fullRawContent, input.contentMaxLength || 30000);
  const seed = input.contentHashSeed || `${title}${fullRawExcerpt || fullRawContent || ''}`;
  const publishDate = sanitizePublishedAtForInsert(input.publishedAt);

  return {
    id: generateId('art'),
    source_id: input.source.id,
    external_id: input.externalId || null,
    url: input.url,
    title,
    author: input.author || null,
    published_at: publishDate.publishedAt,
    content_type: input.contentType || 'article',
    language: input.source.language,
    raw_excerpt: rawExcerpt,
    raw_content: rawContent,
    content_hash: createContentHash(seed),
    image_url: input.imageUrl || null,
    metadata: mergeMetadataWithPublishDateWarning(input.metadata, publishDate.warning),
    summary_status: 'pending',
    retry_count: 0,
    last_summary_error: null,
    parent_article_id: null,
    cluster_signature: buildClusterSignature(title, fullRawExcerpt || fullRawContent || ''),
  };
}

interface ClusterCandidateRow {
  id: string;
  title: string;
  raw_excerpt: string;
  image_url: string | null;
  parent_article_id: string | null;
}

interface ClusterDecision {
  parentId: string | null;
  reason: string;
  score?: number;
  novelty?: number;
}

/**
 * Look for a near-duplicate leader within the recent clustering window. If found and the
 * candidate adds little new info, returns the leader id so the new article is filed as a
 * follower (and skipped from AI summarization). Otherwise returns null and the article is
 * inserted as an independent leader.
 */
async function findClusterParent(row: ArticleInsertRow): Promise<ClusterDecision> {
  // Skip clustering for forum content (Reddit/VOZ) — different OPs are intentionally separate.
  if (/voz|reddit/i.test(row.url) || row.title.startsWith('[r/')) {
    return { parentId: null, reason: 'forum-skip' };
  }

  const candidates = await getMany<ClusterCandidateRow>(
    `SELECT id, title, raw_excerpt, image_url, parent_article_id
     FROM articles
     WHERE created_at >= NOW() - INTERVAL '${CLUSTER_WINDOW_HOURS} hours'
       AND id <> $1
     ORDER BY created_at DESC
     LIMIT 200`,
    [row.id]
  );

  if (candidates.length === 0) return { parentId: null, reason: 'no-candidates' };

  const candidateForCmp = {
    id: row.id,
    title: row.title,
    excerpt: row.raw_excerpt,
    imageUrl: row.image_url,
  };

  let best: { row: ClusterCandidateRow; sim: ReturnType<typeof computeSimilarity> } | null = null;
  for (const cand of candidates) {
    const sim = computeSimilarity(candidateForCmp, {
      id: cand.id,
      title: cand.title,
      excerpt: cand.raw_excerpt || '',
      imageUrl: cand.image_url,
    });
    if (sim.score >= SIMILARITY_THRESHOLD && (!best || sim.score > best.sim.score)) {
      best = { row: cand, sim };
    }
  }

  if (!best) return { parentId: null, reason: 'no-similar' };

  const leaderId = best.row.parent_article_id || best.row.id;

  // Near-identical titles are a strong same-story signal across rewordings; skip the novelty
  // gate so we don't reject duplicates whose leads happen to be phrased differently.
  if (best.sim.titleScore >= TITLE_LOCK_THRESHOLD) {
    return { parentId: leaderId, reason: 'duplicate-title-lock', score: best.sim.score, novelty: 0 };
  }

  // Symmetric novelty on the same field on both sides (raw_excerpt). Comparing candidate's
  // raw_content against the leader's summary_text would mix scripts/languages once the
  // leader is summarized into Vietnamese, producing a false "novel-update" verdict.
  const leaderText = `${best.row.title} ${best.row.raw_excerpt || ''}`;
  const candidateText = `${row.title} ${row.raw_excerpt || ''}`;
  const novelty = computeNovelty(candidateText, leaderText);

  if (novelty >= NOVELTY_THRESHOLD) {
    return { parentId: null, reason: 'novel-update', score: best.sim.score, novelty };
  }

  return { parentId: leaderId, reason: 'duplicate', score: best.sim.score, novelty };
}

export async function insertArticleIfNew(input: ArticleInsertInput): Promise<boolean> {
  const existing = await getOne('SELECT id FROM articles WHERE url = $1', [input.url]);
  if (existing) return false;

  validateArticleContent(input);

  const row = buildArticleInsertRow(input);
  const hashExists = await getOne('SELECT id FROM articles WHERE content_hash = $1', [row.content_hash]);
  if (hashExists) return false;

  const cluster = await findClusterParent(row);
  if (cluster.parentId) {
    row.parent_article_id = cluster.parentId;
    row.summary_status = 'skipped';
    const scorePart = cluster.score !== undefined ? ` score=${cluster.score.toFixed(2)}` : '';
    const novPart = cluster.novelty !== undefined ? ` novelty=${cluster.novelty.toFixed(2)}` : '';
    row.last_summary_error = `Đã gom cụm vào bài ${cluster.parentId}${scorePart}${novPart}`;
    console.log(`[cluster] ${row.id} -> follower of ${cluster.parentId}${scorePart}${novPart}`);
  }

  const insertResult = await query(
    `INSERT INTO articles (id, source_id, external_id, url, title, author, published_at,
                           content_type, language, raw_excerpt, raw_content, content_hash,
                           image_url, metadata, summary_status, retry_count, last_summary_error,
                           parent_article_id, cluster_signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 0, $16, $17, $18)
     ON CONFLICT (url) DO NOTHING
     RETURNING id`,
    [
      row.id,
      row.source_id,
      row.external_id,
      row.url,
      row.title,
      row.author,
      row.published_at,
      row.content_type,
      row.language,
      row.raw_excerpt,
      row.raw_content,
      row.content_hash,
      row.image_url,
      row.metadata ? JSON.stringify(row.metadata) : null,
      row.summary_status,
      row.last_summary_error,
      row.parent_article_id,
      row.cluster_signature,
    ]
  );

  return Boolean(insertResult.rowCount && insertResult.rowCount > 0);
}
