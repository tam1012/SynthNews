/**
 * Post-summarize clustering pass.
 *
 * The fetch-time clustering pass (article-writer.ts) compares raw titles + excerpts
 * across the recent window. That works for same-language wire republishes but cannot
 * match a Chinese-script Reuters story against an English-script AP version of the
 * same event — char-bigrams have no overlap across scripts.
 *
 * After AI summarization, every article gets a Vietnamese `translated_title` and
 * `summary_short`. Running similarity on those normalized fields catches
 * cross-language duplicates that the fetch-time pass missed.
 *
 * Forward-only: only the article that just finished summarizing is moved. Existing
 * followers of other clusters are untouched. If we find a leader to attach to, we
 * also re-parent any followers that were already pointing at this article so the
 * cluster stays flat.
 */
import { getMany, getOne, query } from '../db/index.js';
import {
  CLUSTER_WINDOW_HOURS,
  NOVELTY_THRESHOLD,
  SIMILARITY_THRESHOLD,
  TITLE_LOCK_THRESHOLD,
  computeNovelty,
  computeSimilarity,
} from '../lib/similarity.js';

interface PostSummaryRow {
  id: string;
  url: string;
  title: string;
  translated_title: string | null;
  summary_short: string | null;
  image_url: string | null;
  parent_article_id: string | null;
}

interface PostSummaryCandidateRow {
  id: string;
  url: string;
  title: string;
  translated_title: string | null;
  summary_short: string | null;
  image_url: string | null;
}

function isForumArticle(url: string, title: string): boolean {
  return /voz|reddit/i.test(url || '') || (title || '').startsWith('[r/');
}

export async function maybeClusterAfterSummarize(articleId: string): Promise<{
  attached: boolean;
  parentId?: string;
  reason: string;
  score?: number;
  novelty?: number;
}> {
  const article = await getOne<PostSummaryRow>(
    `SELECT id, url, title, translated_title, summary_short, image_url, parent_article_id
     FROM articles WHERE id = $1`,
    [articleId]
  );
  if (!article) return { attached: false, reason: 'not-found' };
  if (article.parent_article_id) return { attached: false, reason: 'already-follower' };
  if (!article.translated_title) return { attached: false, reason: 'no-translated-title' };
  if (isForumArticle(article.url, article.title)) return { attached: false, reason: 'forum-skip' };

  const candidates = await getMany<PostSummaryCandidateRow>(
    `SELECT id, url, title, translated_title, summary_short, image_url
     FROM articles
     WHERE created_at >= NOW() - INTERVAL '${CLUSTER_WINDOW_HOURS} hours'
       AND parent_article_id IS NULL
       AND summary_status = 'done'
       AND translated_title IS NOT NULL
       AND id <> $1
     ORDER BY created_at DESC
     LIMIT 200`,
    [articleId]
  );

  if (candidates.length === 0) return { attached: false, reason: 'no-candidates' };

  const candidateForCmp = {
    id: article.id,
    title: article.translated_title,
    excerpt: article.summary_short || '',
    imageUrl: article.image_url,
  };

  let best: { row: PostSummaryCandidateRow; sim: ReturnType<typeof computeSimilarity> } | null = null;
  for (const cand of candidates) {
    if (isForumArticle(cand.url, cand.title)) continue;
    const sim = computeSimilarity(candidateForCmp, {
      id: cand.id,
      title: cand.translated_title || '',
      excerpt: cand.summary_short || '',
      imageUrl: cand.image_url,
    });
    if (sim.score >= SIMILARITY_THRESHOLD && (!best || sim.score > best.sim.score)) {
      best = { row: cand, sim };
    }
  }

  if (!best) return { attached: false, reason: 'no-similar' };

  const leaderId = best.row.id;
  let novelty = 0;
  if (best.sim.titleScore < TITLE_LOCK_THRESHOLD) {
    const leaderText = `${best.row.translated_title || ''} ${best.row.summary_short || ''}`;
    const candText = `${article.translated_title} ${article.summary_short || ''}`;
    novelty = computeNovelty(candText, leaderText);
    if (novelty >= NOVELTY_THRESHOLD) {
      return { attached: false, reason: 'novel-update', score: best.sim.score, novelty };
    }
  }

  await query(
    `UPDATE articles
     SET parent_article_id = $1,
         last_summary_error = $2
     WHERE id = $3`,
    [leaderId, `Đã gom cụm sau tóm tắt vào bài ${leaderId}`, articleId]
  );

  // Flatten: any followers that were attached to this article now point at the new leader.
  await query(
    `UPDATE articles SET parent_article_id = $1 WHERE parent_article_id = $2`,
    [leaderId, articleId]
  );

  console.log(
    `[post-cluster] ${articleId} -> follower of ${leaderId} score=${best.sim.score.toFixed(2)} novelty=${novelty.toFixed(2)}`
  );

  return { attached: true, parentId: leaderId, reason: 'duplicate', score: best.sim.score, novelty };
}
