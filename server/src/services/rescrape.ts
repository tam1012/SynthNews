import { getOne, getMany, query } from '../db/index.js';
import { truncate, normalizePublicHttpUrl, sleep } from '../lib/utils.js';
import {
  parseVozPosts, extractVozPagination,
  buildVozRawContent, buildRedditRawContent,
  scoreForumComment, selectForumComments, ForumComment, VozPost,
  fetchRedditCommentsForPost
} from './scraper.js';
import { fetchVozThreadHtml } from './fetchers/voz-fetch-utils.js';

const VOZ_MAX_THREAD_PAGES = parseInt(process.env.VOZ_MAX_THREAD_PAGES || '15');
const FORUM_MAX_COMMENTS = parseInt(process.env.FORUM_MAX_COMMENTS || '70');
const REDDIT_COMMENT_LIMIT = parseInt(process.env.REDDIT_COMMENT_LIMIT || '30');
const REDDIT_COMMENT_DEPTH = parseInt(process.env.REDDIT_COMMENT_DEPTH || '3');
const FORUM_RAW_CONTENT_MAX_LENGTH = parseInt(process.env.FORUM_RAW_CONTENT_MAX_LENGTH || '80000');

export async function rescrapeArticle(articleId: string, force: boolean = false): Promise<boolean> {
  const article = await getOne(`
    SELECT a.*, s.type as source_type, s.name as source_name
    FROM articles a 
    JOIN sources s ON a.source_id = s.id 
    WHERE a.id = $1
  `, [articleId]);

  if (!article || !/voz|reddit/i.test(article.source_name || article.url)) {
    return false; // Only support rescraping forum threads
  }

  // If not forced, check rescraped_count limits
  if (!force && article.rescraped_count >= 2) {
    return false;
  }

  let newRawContent = '';
  let updated = false;

  try {
    if (/voz/i.test(article.source_name || article.url)) {
      const articleUrl = normalizePublicHttpUrl(article.url);
      if (!articleUrl) return false;

      const pagesToVisit: string[] = [articleUrl];
      const visited = new Set<string>();
      const allPosts: VozPost[] = [];

      for (let pageIndex = 0; pageIndex < pagesToVisit.length && pageIndex < VOZ_MAX_THREAD_PAGES; pageIndex++) {
        const pageUrl = normalizePublicHttpUrl(pagesToVisit[pageIndex]);
        if (!pageUrl) continue;
        if (visited.has(pageUrl)) continue;
        visited.add(pageUrl);

        await sleep(500);
        const threadHtml = await fetchVozThreadHtml(pageUrl);
        allPosts.push(...parseVozPosts(threadHtml, pageIndex + 1));

        if (pageIndex === 0) {
          const pageLinks = extractVozPagination(threadHtml, articleUrl).slice(0, Math.max(0, VOZ_MAX_THREAD_PAGES - 1));
          for (const nextPage of pageLinks) {
            if (!pagesToVisit.includes(nextPage)) pagesToVisit.push(nextPage);
          }
        }
      }

      if (allPosts.length > 0) {
        const comments = allPosts
          .filter((post) => !post.isOp)
          .map((post) => ({
            author: post.author,
            body: post.body,
            reactions: post.reactions,
            page: post.page,
            order: post.order,
            score: scoreForumComment(post.body, post.reactions, post.page, post.order),
          }));

        const selectedComments = selectForumComments(comments, FORUM_MAX_COMMENTS);
        newRawContent = buildVozRawContent(allPosts, selectedComments, visited.size, comments.length);
      }
    } else if (/reddit/i.test(article.source_name || article.url)) {
      let postPath = '';
      try {
        const articleUrl = normalizePublicHttpUrl(article.url);
        if (!articleUrl) return false;
        postPath = new URL(articleUrl).pathname;
      } catch (e) {
        return false;
      }

      let postContent = article.title;
      const existingContent = article.raw_content || '';
      const postContentMatch = existingContent.match(/\[Nội dung bài viết\]\n([\s\S]*?)\n\n\[/);
      if (postContentMatch) postContent = postContentMatch[1].trim();

      const linkMatch = existingContent.match(/\[Link chia sẻ\]: (.+)/);
      const existingOutboundUrl = linkMatch ? linkMatch[1].trim() : null;
      const fetched = await fetchRedditCommentsForPost(postPath, postContent);
      postContent = fetched.postContent;
      const outboundUrl = fetched.outboundUrl || existingOutboundUrl;
      const discussionComments = fetched.discussionComments;

      if (discussionComments.length > 0) {
        newRawContent = buildRedditRawContent(postContent, outboundUrl, discussionComments, discussionComments.length);
      }
    }

    if (newRawContent && newRawContent.length > 100 && newRawContent !== article.raw_content) {
      await query(
        `UPDATE articles SET 
           raw_content = $1, 
           summary_status = 'pending', 
           retry_count = 0,
           last_summary_error = NULL,
           rescraped_count = rescraped_count + 1,
           updated_at = NOW() 
         WHERE id = $2`,
        [truncate(newRawContent, FORUM_RAW_CONTENT_MAX_LENGTH), article.id]
      );
      updated = true;
      console.log(`[rescrape] Updated ${article.source_type} article: ${article.id}`);
    } else {
      // Content didn't change enough or fetch failed, just increment count
      await query(`UPDATE articles SET rescraped_count = rescraped_count + 1 WHERE id = $1`, [article.id]);
    }
    return updated;
  } catch (err: any) {
    console.error(`[rescrape] Error for ${article.id}: ${err.message}`);
    return false;
  }
}

export async function runForumRescrapeJob(): Promise<{ checked: number; updated: number }> {
  console.log(`[${new Date().toISOString()}] Starting forum rescrape job...`);
  const articles = await getMany(`
    SELECT a.id, a.url, s.type as source_type, s.name as source_name
    FROM articles a 
    JOIN sources s ON a.source_id = s.id 
    WHERE (s.name ILIKE '%reddit%' OR s.name ILIKE '%voz%')
      AND a.created_at >= NOW() - INTERVAL '4 hours'
      AND a.rescraped_count < 2
    ORDER BY a.created_at DESC LIMIT 30
  `);

  let updated = 0;
  for (const article of articles) {
    const wasUpdated = await rescrapeArticle(article.id);
    if (wasUpdated) updated++;
    await sleep(2000); // Prevent hitting rate limits
  }

  console.log(`  Rescrape complete: checked=${articles.length}, updated=${updated}`);
  return { checked: articles.length, updated };
}
