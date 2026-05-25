import { getOne, getMany, query } from '../../db/index.js';
import { decodeHtmlEntities } from '../../lib/htmlEntities.js';
import { createContentHash, generateId, truncate } from '../../lib/utils.js';
import {
  CLUSTER_WINDOW_HOURS,
  NOVELTY_THRESHOLD,
  SIMILARITY_THRESHOLD,
  buildClusterSignature,
  computeNovelty,
  computeSimilarity,
} from '../../lib/similarity.js';

interface ArticleWriterSource {
  id: string;
  language: string;
}

export const MIN_ARTICLE_TEXT_LENGTH = parseInt(typeof process !== 'undefined' ? process.env.MIN_ARTICLE_TEXT_LENGTH || '500' : '500', 10);

export class ArticleContentTooShortError extends Error {
  constructor(length: number, minLength: number) {
    super(`Article content too short after fetch (${length} characters, minimum ${minLength})`);
    this.name = 'ArticleContentTooShortError';
  }
}

function normalizeTextLength(value: string): number {
  return value.replace(/\s+/g, ' ').trim().length;
}

export function validateArticleContent(input: ArticleInsertInput): void {
  const contentType = input.contentType || 'article';
  const minLength = Math.max(1, MIN_ARTICLE_TEXT_LENGTH || 500);
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

  return {
    id: generateId('art'),
    source_id: input.source.id,
    external_id: input.externalId || null,
    url: input.url,
    title,
    author: input.author || null,
    published_at: input.publishedAt || new Date().toISOString(),
    content_type: input.contentType || 'article',
    language: input.source.language,
    raw_excerpt: rawExcerpt,
    raw_content: rawContent,
    content_hash: createContentHash(seed),
    image_url: input.imageUrl || null,
    metadata: input.metadata || null,
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
  summary_text: string | null;
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
    `SELECT id, title, raw_excerpt, image_url, parent_article_id, summary_text
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

  let best: { row: ClusterCandidateRow; score: number } | null = null;
  for (const cand of candidates) {
    const sim = computeSimilarity(candidateForCmp, {
      id: cand.id,
      title: cand.title,
      excerpt: cand.raw_excerpt || '',
      imageUrl: cand.image_url,
    });
    if (sim.score >= SIMILARITY_THRESHOLD && (!best || sim.score > best.score)) {
      best = { row: cand, score: sim.score };
    }
  }

  if (!best) return { parentId: null, reason: 'no-similar' };

  const leaderId = best.row.parent_article_id || best.row.id;
  // Compare candidate's full content against leader's content to detect follow-up updates.
  const leaderContent = `${best.row.title} ${best.row.summary_text || best.row.raw_excerpt || ''}`;
  const candidateContent = `${row.title} ${row.raw_content || row.raw_excerpt}`;
  const novelty = computeNovelty(candidateContent, leaderContent);

  if (novelty >= NOVELTY_THRESHOLD) {
    return { parentId: null, reason: 'novel-update', score: best.score, novelty };
  }

  return { parentId: leaderId, reason: 'duplicate', score: best.score, novelty };
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
