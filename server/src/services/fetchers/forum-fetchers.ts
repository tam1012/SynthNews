import RssParser from 'rss-parser';
import * as cheerio from 'cheerio';
import { query, getOne, getMany } from '../../db/index.js';
import { generateId, createContentHash, normalizePublicHttpUrl, truncate, sleep } from '../../lib/utils.js';
import { BROWSER_UA, browserFetch, curlFetch, isBlockedHtml, playwrightFetch, randomUA } from './http-utils.js';
import { scraplingFetchWithFallback } from './scrapling-fetch.js';
import {
  ForumComment,
  VozPost,
  normalizeWhitespace,
  scoreForumComment,
  selectForumComments,
  shouldInsertForumArticle,
} from './forum-utils.js';
import { normalizeDate, getDefaultTimezoneForLanguage } from '../../lib/dateUtils.js';

export { BROWSER_UA, browserFetch, curlFetch } from './http-utils.js';
export {
  normalizeWhitespace,
  scoreForumComment,
  selectForumComments,
  shouldInsertForumArticle,
} from './forum-utils.js';
export type { ForumComment, VozPost } from './forum-utils.js';

const rssParser = new RssParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'NewsDigest/1.0 (RSS Reader)',
    Accept: 'application/rss+xml, application/xml, text/xml',
  },
});

const FORUM_RAW_CONTENT_MAX_LENGTH = parseInt(process.env.FORUM_RAW_CONTENT_MAX_LENGTH || '80000');
const FORUM_MAX_COMMENTS = parseInt(process.env.FORUM_MAX_COMMENTS || '70');
const FORUM_MIN_COMMENTS = Math.max(1, parseInt(process.env.FORUM_MIN_COMMENTS || '10', 10) || 10);
const REDDIT_MIN_COMMENTS = Math.max(1, parseInt(process.env.REDDIT_MIN_COMMENTS || '5', 10) || 5);
const VOZ_MAX_THREAD_PAGES = parseInt(process.env.VOZ_MAX_THREAD_PAGES || '15');
const REDDIT_COMMENT_LIMIT = parseInt(process.env.REDDIT_COMMENT_LIMIT || '30');
const REDDIT_COMMENT_DEPTH = parseInt(process.env.REDDIT_COMMENT_DEPTH || '3');

// Reddit OAuth
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || '';
const REDDIT_USERNAME = process.env.REDDIT_USERNAME || '';
const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD || '';
const REDDIT_PROXY_URL = process.env.REDDIT_PROXY_URL || '';
const VOZ_PROXY_URL = process.env.BROWSER_PROXY_URL || process.env.VOZ_PROXY_URL || '';
const WORKER_PROXY_TOKEN = process.env.WORKER_PROXY_TOKEN || '';
let redditToken: { access_token: string; expires_at: number } | null = null;

function hasRedditOAuth(): boolean {
  return !!(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET && REDDIT_USERNAME && REDDIT_PASSWORD);
}

async function getRedditToken(): Promise<string | null> {
  if (!hasRedditOAuth()) return null;
  if (redditToken && Date.now() < redditToken.expires_at) return redditToken.access_token;

  try {
    const body = new URLSearchParams({
      grant_type: 'password',
      username: REDDIT_USERNAME,
      password: REDDIT_PASSWORD,
    });
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'User-Agent': 'newstamhv/1.0',
        Authorization: `Basic ${Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Status code ${response.status}`);

    const data = await response.json();
    if (data.access_token) {
      redditToken = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
      return data.access_token;
    }
    console.error('Reddit OAuth: no token in response');
    return null;
  } catch (err: any) {
    console.error('Reddit OAuth error:', err.message);
    return null;
  }
}

async function redditApiFetch(path: string): Promise<any | null> {
  const token = await getRedditToken();
  if (!token) return null;

  try {
    const url = `https://oauth.reddit.com${path}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'newstamhv/1.0',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Status code ${response.status}`);
    return await response.json();
  } catch (err: any) {
    console.error('Reddit API error:', err.message);
    return null;
  }
}

function isRedditUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'reddit.com' || hostname === 'www.reddit.com';
  } catch {
    return false;
  }
}

function isVozUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'voz.vn' || hostname === 'www.voz.vn';
  } catch {
    return false;
  }
}

function extractSubreddit(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/^\/r\/([^/]+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

interface SourceRow {
  id: string;
  type: string;
  name: string;
  url: string;
  language: string;
  category: string | null;
  fetch_interval_minutes: number;
  parser_config: any;
}

interface ScrapeResult {
  itemsFound: number;
  itemsInserted: number;
  errors: string[];
  metadata?: Record<string, unknown>;
}

type ForumSkipReason = 'few_comments' | 'few_useful_comments' | 'duplicate' | 'comment_fetch_failed';

type ForumStrategyName = 'oauth' | 'proxy' | 'rss' | 'puppeteer' | 'pullpush';

interface RedditCommentFetchResult {
  postContent: string;
  outboundUrl: string | null;
  discussionComments: ForumComment[];
  strategyUsed: ForumStrategyName | null;
}

interface ForumScrapeStats {
  kind: 'reddit' | 'voz';
  threadsSeen: number;
  inserted: number;
  skippedFewComments: number;
  skippedFewUsefulComments: number;
  skippedDuplicate: number;
  fetchErrors: number;
  strategies?: Record<ForumStrategyName, { attempts: number; successes: number }>;
}

function createForumScrapeStats(kind: 'reddit' | 'voz'): ForumScrapeStats {
  const stats: ForumScrapeStats = {
    kind,
    threadsSeen: 0,
    inserted: 0,
    skippedFewComments: 0,
    skippedFewUsefulComments: 0,
    skippedDuplicate: 0,
    fetchErrors: 0,
  };

  if (kind === 'reddit') {
    stats.strategies = {
      oauth: { attempts: 0, successes: 0 },
      puppeteer: { attempts: 0, successes: 0 },
      rss: { attempts: 0, successes: 0 },
      proxy: { attempts: 0, successes: 0 },
      pullpush: { attempts: 0, successes: 0 },
    };
  }

  return stats;
}

function markForumSkip(stats: ForumScrapeStats, reason: ForumSkipReason) {
  if (reason === 'few_comments') stats.skippedFewComments++;
  if (reason === 'few_useful_comments') stats.skippedFewUsefulComments++;
  if (reason === 'duplicate') stats.skippedDuplicate++;
  if (reason === 'comment_fetch_failed') stats.fetchErrors++;
}

function getForumSkipReason(commentCount: number, minComments: number, usefulCount: number, minUsefulComments = 3): ForumSkipReason | null {
  if (commentCount === 0) return 'comment_fetch_failed';
  if (commentCount < minComments) return 'few_comments';
  if (usefulCount < minUsefulComments) return 'few_useful_comments';
  return null;
}

function markRedditStrategy(stats: ForumScrapeStats | undefined, strategy: ForumStrategyName, success: boolean) {
  const entry = stats?.strategies?.[strategy];
  if (!entry) return;
  entry.attempts++;
  if (success) entry.successes++;
}

function parseRedditJsonComments(commentsData: any, postContent: string): RedditCommentFetchResult | null {
  if (!Array.isArray(commentsData)) return null;

  let nextPostContent = postContent;
  let outboundUrl: string | null = null;
  const postData = commentsData[0]?.data?.children?.[0]?.data;
  if (postData?.selftext && postData.selftext.length > nextPostContent.length) {
    nextPostContent = normalizeWhitespace(postData.selftext);
  }
  if (postData?.url && !postData.is_self && !String(postData.url).includes('reddit.com')) {
    outboundUrl = normalizePublicHttpUrl(String(postData.url));
  }

  const comments = commentsData[1]?.data?.children || [];
  const flattened: ForumComment[] = [];
  flattenRedditComments(comments, 1, REDDIT_COMMENT_DEPTH, flattened);
  return {
    postContent: nextPostContent,
    outboundUrl,
    discussionComments: selectForumComments(flattened, REDDIT_COMMENT_LIMIT),
    strategyUsed: null,
  };
}

export async function fetchRedditCommentsForPost(postPath: string, initialPostContent: string, stats?: ForumScrapeStats): Promise<RedditCommentFetchResult> {
  if (hasRedditOAuth()) {
    markRedditStrategy(stats, 'oauth', false);
    const commentsData = await redditApiFetch(`${postPath}.json?limit=${REDDIT_COMMENT_LIMIT}&sort=best&depth=${REDDIT_COMMENT_DEPTH}`);
    const parsed = parseRedditJsonComments(commentsData, initialPostContent);
    if (parsed && parsed.discussionComments.length > 0) {
      markRedditStrategy(stats, 'oauth', true);
      console.log(`[reddit] comments strategy=oauth count=${parsed.discussionComments.length} path=${postPath}`);
      return { ...parsed, strategyUsed: 'oauth' };
    }
  }

  if (REDDIT_PROXY_URL) {
    try {
      markRedditStrategy(stats, 'proxy', false);
      const proxyUrl = `${REDDIT_PROXY_URL}?path=${encodeURIComponent(postPath + '.json')}&limit=${REDDIT_COMMENT_LIMIT}&sort=best&depth=${REDDIT_COMMENT_DEPTH}`;
      const proxyRes = await fetch(proxyUrl, {
        headers: {
          Accept: 'application/json',
          ...(WORKER_PROXY_TOKEN ? { 'X-Proxy-Token': WORKER_PROXY_TOKEN } : {}),
        },
        signal: AbortSignal.timeout(15000),
      });
      if (proxyRes.ok) {
        const parsed = parseRedditJsonComments(await proxyRes.json(), initialPostContent);
        if (parsed && parsed.discussionComments.length > 0) {
          markRedditStrategy(stats, 'proxy', true);
          console.log(`[reddit] comments strategy=proxy count=${parsed.discussionComments.length} path=${postPath}`);
          return { ...parsed, strategyUsed: 'proxy' };
        }
      }
    } catch (e: any) {
      console.log(`[reddit] comments strategy=proxy failed path=${postPath}: ${e.message}`);
    }
  }

  try {
    markRedditStrategy(stats, 'rss', false);
    const commentRssUrl = `https://www.reddit.com${postPath}.rss`;
    const rssRes = await fetch(commentRssUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (rssRes.ok) {
      const feed = await rssParser.parseString(await rssRes.text());
      const comments: ForumComment[] = [];
      for (let i = 1; i < feed.items.length; i++) {
        const item = feed.items[i];
        const body = normalizeWhitespace(stripHtmlBasic(item.contentSnippet || item.content || ''));
        if (body && body.length > 20) {
          comments.push({
            author: item.author || 'unknown',
            body: body.substring(0, 900),
            reactions: 0,
            page: 1,
            order: i,
            score: scoreForumComment(body, 0, 1, i),
          });
        }
      }
      const discussionComments = selectForumComments(comments, REDDIT_COMMENT_LIMIT);
      if (discussionComments.length > 0) {
        markRedditStrategy(stats, 'rss', true);
        console.log(`[reddit] comments strategy=rss count=${discussionComments.length} path=${postPath}`);
        return { postContent: initialPostContent, outboundUrl: null, discussionComments, strategyUsed: 'rss' };
      }
    }
  } catch (e: any) {
    console.log(`[reddit] comments strategy=rss failed path=${postPath}: ${e.message}`);
  }

  try {
    markRedditStrategy(stats, 'puppeteer', false);
    const oldUrl = `https://old.reddit.com${postPath}.json?limit=${REDDIT_COMMENT_LIMIT}&sort=best&depth=${REDDIT_COMMENT_DEPTH}`;
    const rawJsonText = await scraplingFetchWithFallback(
      oldUrl,
      { mode: 'fast', rawText: true, timeoutMs: 25000 },
      { rawText: true, blockHeavyResources: true, settleMs: 500, timeoutMs: 25000, userAgent: randomUA() },
    );
    if (rawJsonText && (rawJsonText.trim().startsWith('[') || rawJsonText.trim().startsWith('{'))) {
      const parsed = parseRedditJsonComments(JSON.parse(rawJsonText), initialPostContent);
      if (parsed && parsed.discussionComments.length > 0) {
        markRedditStrategy(stats, 'puppeteer', true);
        console.log(`[reddit] comments strategy=puppeteer count=${parsed.discussionComments.length} path=${postPath}`);
        return { ...parsed, strategyUsed: 'puppeteer' };
      }
    }
  } catch (e: any) {
    console.log(`[reddit] comments strategy=puppeteer failed path=${postPath}: ${e.message}`);
  }

  return { postContent: initialPostContent, outboundUrl: null, discussionComments: [], strategyUsed: null };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseVozPosts(html: string, page: number): VozPost[] {
  const $ = cheerio.load(html);
  const posts: VozPost[] = [];

  $('article.message--post').each((idx, el) => {
    const author = $(el).find('.message-name .username, .message-name a').first().text().trim() || 'unknown';
    const bodyEl = $(el).find('.message-body .bbWrapper').first().clone();
    bodyEl.find('.bbCodeBlock--quote, .toggleTriggerAnchor').remove();
    bodyEl.find('iframe, video, .bbMediaWrapper, script, style').remove();

    const body = normalizeWhitespace(bodyEl.text());
    let reactions = 0;
    const reactText = $(el).find('.reactionsBar-link').text().trim();
    const numMatch = reactText.match(/(\d+)/);
    if (numMatch) reactions = parseInt(numMatch[1], 10);

    if (body && body.length > 10) {
      posts.push({
        author,
        body: body.substring(0, 1200),
        reactions,
        isOp: idx === 0 && page === 1,
        page,
        order: idx,
      });
    }
  });

  return posts;
}

export function extractVozPagination(html: string, threadUrl: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();

  $('.pageNav-page').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const publicUrl = normalizePublicHttpUrl(new URL(href, threadUrl).toString());
      if (publicUrl) urls.add(publicUrl);
    } catch {}
  });

  return [...urls];
}

export function buildVozRawContent(posts: VozPost[], selectedComments: ForumComment[], pagesFetched: number, totalCommentsSeen: number): string {
  if (posts.length === 0) return '';

  const opPost = posts.find((post) => post.isOp) || posts[0];
  let fullContent = `[Nội dung bài viết gốc - bởi ${opPost.author}]\n${opPost.body}\n\n`;
  fullContent += `[Dữ liệu thread VOZ]\n- Đã đọc ${pagesFetched} trang thread\n- Đã trích ${totalCommentsSeen} bình luận thành viên\n- Đã chọn ${selectedComments.length} bình luận tiêu biểu cho AI\n\n`;

  if (selectedComments.length > 0) {
    fullContent += '[Bình luận thành viên nổi bật nhiều trang]\n';
    for (const comment of selectedComments) {
      const reactionLabel = comment.reactions > 0 ? ` | ${comment.reactions} reactions` : '';
      fullContent += `- Trang ${comment.page}${reactionLabel} | ${comment.author}: ${comment.body}\n`;
    }
  } else {
    fullContent += '[Chưa có bình luận thành viên đủ dữ liệu để tổng hợp]\n';
  }

  return fullContent;
}

export function flattenRedditComments(nodes: any[], depth: number, maxDepth: number, bucket: ForumComment[]) {
  if (!Array.isArray(nodes) || depth > maxDepth) return;

  for (const node of nodes) {
    if (node?.kind !== 't1' || !node.data?.body) continue;
    const body = normalizeWhitespace(node.data.body || '');
    if (!body || body === '[deleted]' || body === '[removed]') continue;

    const score = node.data.score || 0;
    const comment: ForumComment = {
      author: node.data.author || 'unknown',
      body: body.substring(0, 900),
      reactions: score,
      page: depth,
      order: bucket.length,
      score: scoreForumComment(body, score, depth, bucket.length + 1) + (depth === 1 ? 0.8 : 0.2),
    };
    bucket.push(comment);

    const replies = node.data.replies?.data?.children;
    if (Array.isArray(replies)) {
      flattenRedditComments(replies, depth + 1, maxDepth, bucket);
    }
  }
}

export function buildRedditRawContent(postContent: string, linkUrl: string | null, selectedComments: ForumComment[], totalCommentsSeen: number): string {
  let fullContent = `[Nội dung bài viết]\n${postContent}\n\n`;
  if (linkUrl) {
    fullContent += `[Link chia sẻ]: ${linkUrl}\n\n`;
  }

  fullContent += `[Dữ liệu thảo luận Reddit]\n- Đã trích ${totalCommentsSeen} comment/reply\n- Đã chọn ${selectedComments.length} comment tiêu biểu cho AI\n\n`;

  if (selectedComments.length > 0) {
    fullContent += '[Bình luận cộng đồng]\n';
    for (const comment of selectedComments) {
      const scoreLabel = comment.reactions > 0 ? `(${comment.reactions} điểm)` : '(0 điểm)';
      const depthLabel = comment.page > 1 ? ` [reply depth ${comment.page}]` : '';
      fullContent += `- ${scoreLabel}${depthLabel} ${comment.author}: ${comment.body}\n`;
    }
  }

  return fullContent;
}

export async function scrapeRedditSource(source: SourceRow): Promise<ScrapeResult> {
  const forumStats = createForumScrapeStats('reddit');
  const result: ScrapeResult = { itemsFound: 0, itemsInserted: 0, errors: [], metadata: { forum: forumStats } };
  const subreddit = extractSubreddit(source.url);
  if (!subreddit) {
    result.errors.push('Could not extract subreddit name');
    return result;
  }

  try {
    const rssUrl = `https://www.reddit.com/r/${subreddit}/hot/.rss`;
    let xml = '';
    try {
      const rssRes = await fetch(rssUrl, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!rssRes.ok) throw new Error(`Reddit RSS ${rssRes.status}`);
      xml = await rssRes.text();
      if (isBlockedHtml(xml)) {
        throw new Error('Cloudflare blocked HTML received instead of RSS XML');
      }
    } catch (err: any) {
      console.warn(`[reddit] native RSS fetch failed for ${rssUrl}, falling back to Playwright: ${err.message}`);
      xml = await scraplingFetchWithFallback(rssUrl, {
        mode: 'stealth',
        rawText: true,
        blockResources: true,
        waitMs: 1500,
      }, {
        rawText: true,
        blockHeavyResources: true,
        settleMs: 1500,
        userAgent: randomUA(),
      });
    }

    const items = (await parseForumFeedItems(xml)).slice(0, parsePositiveInt(process.env.MAX_ARTICLES_PER_SOURCE, 15));
    result.itemsFound = items.length;

    let enrichedCount = 0;
    const MAX_ENRICH_PER_RUN = 8;

    for (const item of items) {
      if (!item.link || !item.title) continue;

      const url = normalizePublicHttpUrl(item.link);
      if (!url) continue;
      forumStats.threadsSeen++;
      const existing = await getOne('SELECT id FROM articles WHERE url = $1', [url]);
      if (existing) {
        markForumSkip(forumStats, 'duplicate');
        continue;
      }

      const postPath = new URL(url).pathname;
      const rssContent = item.contentSnippet || item.content || '';
      let postContent = stripHtmlBasic(rssContent) || item.title;
      let outboundUrl: string | null = null;
      let discussionComments: ForumComment[] = [];

      if (hasRedditOAuth() || enrichedCount < MAX_ENRICH_PER_RUN) {
        enrichedCount++;
        await sleep(1200);
        const fetched = await fetchRedditCommentsForPost(postPath, postContent, forumStats);
        postContent = fetched.postContent;
        outboundUrl = fetched.outboundUrl;
        discussionComments = fetched.discussionComments;
      }

      const selectedRedditComments = selectForumComments(discussionComments, REDDIT_COMMENT_LIMIT);
      const skipReason = getForumSkipReason(discussionComments.length, REDDIT_MIN_COMMENTS, selectedRedditComments.length);
      if (skipReason) {
        markForumSkip(forumStats, skipReason);
        console.log(`[reddit] Skip ${postPath}: reason=${skipReason}, ${discussionComments.length} comments/replies, ${selectedRedditComments.length} useful`);
        continue;
      }

      const fullContent = buildRedditRawContent(postContent, outboundUrl, selectedRedditComments, discussionComments.length);
      const contentHash = createContentHash(item.title + fullContent.substring(0, 300));
      const hashExists = await getOne('SELECT id FROM articles WHERE content_hash = $1', [contentHash]);
      if (hashExists) {
        markForumSkip(forumStats, 'duplicate');
        continue;
      }

      const excerpt = truncate(stripHtmlBasic(rssContent) || item.title, 500);
      let imageUrl: string | null = null;
      const rawHtml = item.content || '';
      if (rawHtml) {
        const $ = cheerio.load(rawHtml);
        const imgSrc = $('img').first().attr('src');
        if (imgSrc) imageUrl = imgSrc;
      }

      const id = generateId('art');
      const publishedAt = normalizeDate(item.pubDate || null, { defaultTimezone: getDefaultTimezoneForLanguage(source.language) });

      const insertResult = await query(
        `INSERT INTO articles (id, source_id, external_id, url, title, author, published_at,
                               content_type, language, raw_excerpt, raw_content, content_hash,
                               image_url, summary_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'article', $8, $9, $10, $11, $12, 'pending')
         ON CONFLICT (url) DO NOTHING
         RETURNING id`,
        [
          id, source.id, item.guid || null, url,
          `[r/${subreddit}] ${item.title.trim()}`,
          item.creator || null, publishedAt,
          source.language, excerpt,
          truncate(fullContent || item.title, FORUM_RAW_CONTENT_MAX_LENGTH), contentHash, imageUrl,
        ]
      );
      if (insertResult.rowCount && insertResult.rowCount > 0) {
        result.itemsInserted++;
        forumStats.inserted++;
      }
    }
  } catch (err: any) {
    result.errors.push(err.message);
  }

  return result;
}

export async function scrapeVozSource(source: SourceRow): Promise<ScrapeResult> {
  const forumStats = createForumScrapeStats('voz');
  const result: ScrapeResult = { itemsFound: 0, itemsInserted: 0, errors: [], metadata: { forum: forumStats } };

  try {
    const sourceUrl = normalizePublicHttpUrl(source.url, false);
    if (!sourceUrl) throw new Error('Source URL must be a public http(s) URL');

    const xml = await fetchVozFeedXml(sourceUrl);
    const items = (await parseForumFeedItems(xml)).slice(0, parsePositiveInt(process.env.MAX_ARTICLES_PER_SOURCE, 15));
    result.itemsFound = items.length;

    for (const item of items) {
      if (!item.link || !item.title) continue;

      const url = normalizePublicHttpUrl(item.link);
      if (!url) continue;
      forumStats.threadsSeen++;
      const existing = await getOne('SELECT id FROM articles WHERE url = $1', [url]);
      if (existing) {
        markForumSkip(forumStats, 'duplicate');
        continue;
      }

      const rawItem = item as RssParser.Item & Record<string, any>;
      const rawExcerpt = item.contentSnippet || item.content || '';
      const contentHash = createContentHash(item.title + rawExcerpt.substring(0, 200));
      const hashExists = await getOne('SELECT id FROM articles WHERE content_hash = $1', [contentHash]);
      if (hashExists) {
        markForumSkip(forumStats, 'duplicate');
        continue;
      }

      let fullContent = '';
      let imageUrl: string | null = null;

      try {
        await sleep(2000);
        const pagesToVisit: string[] = [url];
        const visited = new Set<string>();
        const allPosts: VozPost[] = [];

        for (let pageIndex = 0; pageIndex < pagesToVisit.length && pageIndex < VOZ_MAX_THREAD_PAGES; pageIndex++) {
          const pageUrl = normalizePublicHttpUrl(pagesToVisit[pageIndex]);
          if (!pageUrl) continue;
          if (visited.has(pageUrl)) continue;
          visited.add(pageUrl);

          await sleep(1500);
          const threadHtml = await fetchVozThreadHtml(pageUrl);
          const pagePosts = parseVozPosts(threadHtml, pageIndex + 1);

          if (pagePosts.length === 0) throw new Error(`VOZ thread parse returned 0 posts${isBlockedHtml(threadHtml) ? ' (blocked HTML)' : ''}`);
          allPosts.push(...pagePosts);

          if (pageIndex === 0) {
            const pageLinks = extractVozPagination(threadHtml, url).slice(0, Math.max(0, VOZ_MAX_THREAD_PAGES - 1));
            for (const nextPage of pageLinks) {
              if (!pagesToVisit.includes(nextPage)) pagesToVisit.push(nextPage);
            }

            const $ = cheerio.load(threadHtml);
            imageUrl = $('meta[property="og:image"]').attr('content') || null;
            if (!imageUrl) {
              const firstImg = $('article.message--post').first().find('.message-body img').first().attr('src');
              if (firstImg) {
                try {
                  imageUrl = normalizePublicHttpUrl(new URL(firstImg, url).toString());
                } catch {}
              }
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
          const skipReason = getForumSkipReason(comments.length, FORUM_MIN_COMMENTS, selectedComments.length);
          if (skipReason) {
            markForumSkip(forumStats, skipReason);
            console.log(`[voz] Skip ${url}: reason=${skipReason}, ${comments.length} replies, ${selectedComments.length} useful`);
            continue;
          }

          fullContent = buildVozRawContent(allPosts, selectedComments, visited.size, comments.length);
        }
      } catch (err: any) {
        result.errors.push(`Failed to fetch VOZ thread ${item.link}: ${err.message}`);
      }

      if (!fullContent) {
        markForumSkip(forumStats, 'comment_fetch_failed');
        console.log(`[voz] Skip ${url}: reason=comment_fetch_failed, could not verify at least ${FORUM_MIN_COMMENTS} replies`);
        continue;
      }

      const id = generateId('art');
      const publishedAt = normalizeDate(item.pubDate || null, { defaultTimezone: getDefaultTimezoneForLanguage(source.language) });

      if (!imageUrl) {
        const rawHtmlContent = item.content || '';
        if (rawHtmlContent) {
          const $ = cheerio.load(rawHtmlContent);
          imageUrl = $('img').first().attr('src') || null;
        }
      }

      const insertResult = await query(
        `INSERT INTO articles (id, source_id, external_id, url, title, author, published_at,
                               content_type, language, raw_excerpt, raw_content, content_hash,
                               image_url, summary_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'article', $8, $9, $10, $11, $12, 'pending')
         ON CONFLICT (url) DO NOTHING
         RETURNING id`,
        [
          id, source.id, item.guid || null, url, item.title.trim(),
          item.creator || rawItem.author || null, publishedAt,
          source.language, truncate(stripHtml(rawExcerpt), 500),
          truncate(fullContent, FORUM_RAW_CONTENT_MAX_LENGTH), contentHash, imageUrl,
        ]
      );
      if (insertResult.rowCount && insertResult.rowCount > 0) {
        result.itemsInserted++;
        forumStats.inserted++;
      }

    }
  } catch (err: any) {
    result.errors.push(err.message);
  }

  if (result.itemsInserted === 0 && forumStats.fetchErrors > 0 && forumStats.fetchErrors + forumStats.skippedDuplicate >= forumStats.threadsSeen) {
    result.errors.push(`VOZ thread detail fetch failed for ${forumStats.fetchErrors}/${forumStats.threadsSeen} threads`);
  }

  return result;
}

function stripHtml(html: string): string {
  return cheerio.load(html).text().replace(/\s+/g, ' ').trim();
}

export function stripHtmlBasic(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getXmlText($item: cheerio.Cheerio<any>, selector: string): string {
  return normalizeWhitespace($item.find(selector).first().text());
}

function getXmlChildHtml($item: cheerio.Cheerio<any>, selector: string): string {
  const child = $item.find(selector).first();
  return child.html()?.trim() || child.text().trim();
}

function parseForumRssItems(xml: string): RssParser.Item[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('item').toArray().flatMap((element) => {
    const $item = $(element);
    const title = getXmlText($item, 'title');
    const link = getXmlText($item, 'link');
    if (!title || !link) return [];

    return [{
      title,
      link,
      guid: getXmlText($item, 'guid') || link,
      pubDate: getXmlText($item, 'pubDate') || getXmlText($item, 'published') || getXmlText($item, 'updated'),
      creator: getXmlText($item, 'creator') || getXmlText($item, 'dc\\:creator'),
      contentSnippet: stripHtmlBasic(getXmlChildHtml($item, 'description')),
      content: getXmlChildHtml($item, 'encoded') || getXmlChildHtml($item, 'content\\:encoded') || getXmlChildHtml($item, 'description'),
    }];
  });
}

async function parseForumFeedItems(xml: string): Promise<RssParser.Item[]> {
  try {
    const feed = await rssParser.parseString(xml);
    return feed.items;
  } catch {
    const items = parseForumRssItems(xml);
    if (items.length === 0) throw new Error('Feed not recognized as RSS 1 or 2.');
    return items;
  }
}

function buildVozProxyUrl(targetUrl: string): string {
  const proxy = new URL(VOZ_PROXY_URL);
  proxy.searchParams.set('url', targetUrl);
  return proxy.toString();
}

async function fetchVozViaProxy(targetUrl: string, accept: string, timeoutMs: number): Promise<string | null> {
  if (!VOZ_PROXY_URL) return null;

  try {
    const proxyUrl = buildVozProxyUrl(targetUrl);
    const proxyRes = await fetch(proxyUrl, {
      headers: {
        Accept: accept,
        ...(WORKER_PROXY_TOKEN ? { 'X-Proxy-Token': WORKER_PROXY_TOKEN } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const proxyText = await proxyRes.text();
    if (proxyRes.ok && !isBlockedHtml(proxyText)) {
      console.log(`[voz] proxy fetch ok ${targetUrl}`);
      return proxyText;
    }
    console.warn(`[voz] proxy fetch failed for ${targetUrl}: status=${proxyRes.status}`);
  } catch (err: any) {
    console.warn(`[voz] proxy fetch failed for ${targetUrl}: ${err.message}`);
  }

  return null;
}

async function fetchVozThreadHtml(pageUrl: string): Promise<string> {
  const proxyResult = await fetchVozViaProxy(pageUrl, 'text/html', 30000);
  if (proxyResult) return proxyResult;
  return scraplingFetchWithFallback(
    pageUrl,
    { mode: 'stealth', waitMs: 1500, blockResources: false, solveCloudflare: true, timeoutMs: 90000 },
    { waitUntil: 'domcontentloaded', blockHeavyResources: true, settleMs: 3000, timeoutMs: 90000, userAgent: randomUA() },
  );
}

async function fetchVozFeedXml(sourceUrl: string): Promise<string> {
  const proxyResult = await fetchVozViaProxy(sourceUrl, 'application/rss+xml', 30000);
  if (proxyResult) return proxyResult;
  return scraplingFetchWithFallback(
    sourceUrl,
    { mode: 'stealth', rawText: false, waitMs: 1500, blockResources: false, solveCloudflare: true, timeoutMs: 60000 },
    { rawText: true, blockHeavyResources: true, settleMs: 1500, userAgent: randomUA() },
  );
}

interface RedditRetryResult {
  checked: number;
  enriched: number;
  invalidUrl: number;
  pullpushFailed: number;
  pullpushEmpty: number;
  noUsefulComments: number;
}

// Retry lấy comment Reddit cho các bài chưa có comment (Pullpush index chậm)
export async function retryRedditComments(): Promise<RedditRetryResult> {
  const MAX_RETRY = 10;

  // Tìm bài Reddit tạo trong 48h qua, có raw_content chứa "Đã trích 0 comment"
  const articles = await getMany(
    `SELECT a.id, a.url, a.title, a.raw_content
     FROM articles a
     JOIN sources s ON a.source_id = s.id
     WHERE LOWER(s.name) LIKE '%reddit%'
       AND a.created_at > NOW() - INTERVAL '48 hours'
       AND a.raw_content LIKE '%Đã trích 0 comment%'
     ORDER BY a.created_at DESC
     LIMIT $1`,
    [MAX_RETRY]
  );

  if (articles.length === 0) {
    return { checked: 0, enriched: 0, invalidUrl: 0, pullpushFailed: 0, pullpushEmpty: 0, noUsefulComments: 0 };
  }

  const retryResult: RedditRetryResult = {
    checked: articles.length,
    enriched: 0,
    invalidUrl: 0,
    pullpushFailed: 0,
    pullpushEmpty: 0,
    noUsefulComments: 0,
  };

  for (const article of articles) {
    try {
      // Extract post ID from URL: /r/sub/comments/POST_ID/...
      const postIdMatch = article.url?.match(/\/comments\/([a-z0-9]+)/);
      if (!postIdMatch) {
        retryResult.invalidUrl++;
        continue;
      }
      const postId = postIdMatch[1];

      await sleep(1000);
      const pullpushUrl = `https://api.pullpush.io/reddit/comment/search?link_id=${postId}&size=${REDDIT_COMMENT_LIMIT}&sort=score&sort_type=score`;
      const pullpushRes = await curlFetch(pullpushUrl, 'application/json', 10);
      if (!pullpushRes.ok) {
        retryResult.pullpushFailed++;
        continue;
      }

      const pullpushData = await pullpushRes.json();
      const pullpushComments: ForumComment[] = (pullpushData.data || [])
        .filter((c: any) => c.body && c.body !== '[deleted]' && c.body !== '[removed]' && c.body.length > 20)
        .map((c: any, idx: number) => ({
          author: c.author || 'unknown',
          body: c.body.substring(0, 900),
          reactions: c.score || 0,
          page: 1,
          order: idx,
          score: scoreForumComment(c.body, c.score || 0, 1, idx),
        }));

      if (pullpushComments.length === 0) {
        retryResult.pullpushEmpty++;
        continue;
      }

      const selectedComments = selectForumComments(pullpushComments, FORUM_MAX_COMMENTS);
      if (selectedComments.length === 0) {
        retryResult.noUsefulComments++;
        continue;
      }

      // Reconstruct raw_content: keep original post content, replace comment section
      const existingContent = article.raw_content || '';
      const postContentMatch = existingContent.match(/\[Nội dung bài viết\]\n([\s\S]*?)\n\n\[/);
      const postContent = postContentMatch ? postContentMatch[1].trim() : article.title;

      // Check for outbound link
      const linkMatch = existingContent.match(/\[Link chia sẻ\]: (.+)/);
      const outboundUrl = linkMatch ? linkMatch[1].trim() : null;

      const newRawContent = buildRedditRawContent(postContent, outboundUrl, selectedComments, pullpushComments.length);

      await query(
        `UPDATE articles
         SET raw_content = $1,
             summary_status = 'pending',
             retry_count = 0,
             last_summary_error = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [truncate(newRawContent, FORUM_RAW_CONTENT_MAX_LENGTH), article.id]
      );

      console.log(`[reddit-retry] Enriched ${article.id} with ${selectedComments.length} comments (from ${pullpushComments.length} total)`);
      retryResult.enriched++;
    } catch (err: any) {
      console.log(`[reddit-retry] Failed for ${article.id}: ${err.message}`);
      retryResult.pullpushFailed++;
    }
  }

  return retryResult;
}
