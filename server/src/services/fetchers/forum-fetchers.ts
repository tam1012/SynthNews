import RssParser from 'rss-parser';
import * as cheerio from 'cheerio';
import { query, getOne, getMany } from '../../db/index.js';
import { generateId, createContentHash, normalizePublicHttpUrl, truncate, sleep } from '../../lib/utils.js';
import { BROWSER_UA, browserFetch, cookieAwareFetch, curlFetch, isBlockedHtml, playwrightFetch, proxyFetchFollow, randomUA } from './http-utils.js';
import { scraplingFetchWithFallback } from './scrapling-fetch.js';
import { fetchVozThreadHtml, fetchVozFeedXml } from './voz-fetch-utils.js';
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
const WORKER_PROXY_TOKEN = process.env.WORKER_PROXY_TOKEN || '';
let redditToken: { access_token: string; expires_at: number } | null = null;

// Reddit blocks datacenter IPs: the .rss feed answers 429 on a burst and .json
// is a hard 403 without OAuth (which we can't register). Each IP we have (the
// VPS itself + the VN and SG residential proxies) gets roughly ONE .rss request
// before Reddit 429s it, and needs ~30s to recover. Probed directly: a real path
// after a 30s rest returns 200; the same path hit 8s apart returns 429.
//
// So the win isn't "try harder per request" — it's pacing. We model each IP as a
// lane with its own cooldown clock, SHARED across every fetch in the process. A
// fetch picks the lane that has rested longest; if none has rested enough it
// waits. Because the clock is shared across posts and subreddits, the whole
// enrich loop self-paces to Reddit's per-IP budget instead of burst-burning all
// three IPs on the first post and starving the rest.
const REDDIT_LANE_SUCCESS_COOLDOWN_MS = parseInt(process.env.REDDIT_LANE_COOLDOWN_MS || '30000', 10);
// A 429 means that IP is already annoyed — rest it a bit longer than a clean hit.
const REDDIT_LANE_PENALTY_COOLDOWN_MS = parseInt(process.env.REDDIT_LANE_PENALTY_MS || '45000', 10);
// Cap how long a single fetch will block waiting for a free lane. Past this we
// give up this one fetch (the post is skipped) rather than stall the whole run.
const REDDIT_LANE_MAX_WAIT_MS = parseInt(process.env.REDDIT_LANE_MAX_WAIT_MS || '40000', 10);

interface RedditLane {
  id: string;
  proxyUrl: string | null; // null = native VPS IP (no proxy)
  nextAvailableAt: number; // epoch ms; this lane is rested once now >= this
}

// Native IP first (free), then each residential proxy. Built once at module load.
const redditLanes: RedditLane[] = [
  { id: 'native', proxyUrl: null, nextAvailableAt: 0 },
  ...[process.env.VN_PROXY_URL || '', process.env.SCRAPLING_PROXY_URL || '']
    .filter(Boolean)
    .map((proxyUrl, i) => ({ id: `proxy${i + 1}`, proxyUrl, nextAvailableAt: 0 })),
];

async function fetchRedditLane(lane: RedditLane, url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; xml: string }> {
  if (lane.proxyUrl) {
    const res = await cookieAwareFetch(url, { proxyUrl: lane.proxyUrl, timeoutMs, userAgent: randomUA() });
    return { ok: res.ok && res.status === 200 && !isBlockedHtml(res.body), status: res.status, xml: res.body };
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': randomUA(), Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = res.ok ? await res.text() : '';
  return { ok: res.ok && !isBlockedHtml(body), status: res.status, xml: body };
}

// Fetch a Reddit .rss URL while respecting each IP's cooldown. Reddit's .rss is
// the only endpoint still open to us (.json => 403), so both listings and
// per-post comments go through here.
async function fetchRedditRss(url: string, timeoutMs = 15000): Promise<{ ok: boolean; status: number; xml: string }> {
  let lastStatus = 429;
  // At most one pass over the lanes per call: pick the soonest-rested lane, wait
  // for it (up to the cap), try it. On 429 penalize it and fall to the next lane.
  for (let attempt = 0; attempt < redditLanes.length; attempt++) {
    const lane = redditLanes.reduce((a, b) => (a.nextAvailableAt <= b.nextAvailableAt ? a : b));
    const waitMs = lane.nextAvailableAt - Date.now();
    if (waitMs > REDDIT_LANE_MAX_WAIT_MS) break; // every lane still cooling — bail
    if (waitMs > 0) await sleep(waitMs);

    try {
      const res = await fetchRedditLane(lane, url, timeoutMs);
      lastStatus = res.status;
      if (res.ok) {
        lane.nextAvailableAt = Date.now() + REDDIT_LANE_SUCCESS_COOLDOWN_MS;
        return res;
      }
      // 429 / block → rest this lane longer, try the next-soonest.
      lane.nextAvailableAt = Date.now() + REDDIT_LANE_PENALTY_COOLDOWN_MS;
    } catch {
      // Network/timeout error — give this lane a normal rest and move on.
      lane.nextAvailableAt = Date.now() + REDDIT_LANE_SUCCESS_COOLDOWN_MS;
    }
  }

  return { ok: false, status: lastStatus, xml: '' };
}

// old.reddit.com HTML comment pages behave completely differently from .rss/.json:
// probed directly, they return 200 on a 10x burst with NO rate-limit through a
// residential proxy (datacenter/native IP still gets a hard 403). A single page
// carries BOTH the post body and all comments, so one request replaces the whole
// "listing .rss + per-post comment .rss" dance that was burning the per-IP budget.
// Proxies only (native is 403); try VN then SG. Burst-safe, so no lane pacing.
const OLD_REDDIT_PROXIES: string[] = [
  process.env.VN_PROXY_URL || '',
  process.env.SCRAPLING_PROXY_URL || '',
].filter(Boolean);

async function fetchOldRedditHtml(postPath: string, timeoutMs = 20000): Promise<string | null> {
  const cleanPath = postPath.endsWith('/') ? postPath : `${postPath}/`;
  const url = `https://old.reddit.com${cleanPath}`;
  for (const proxyUrl of OLD_REDDIT_PROXIES) {
    try {
      // proxyFetchFollow (not cookieAwareFetch): old.reddit answers a chain of
      // 301s that the manual-redirect cookieAwareFetch can't walk (it bails after
      // 5 hops). undici auto-follows them, which is what probed 200 + comments.
      const res = await proxyFetchFollow(url, { proxyUrl, timeoutMs, userAgent: randomUA() });
      if (res.ok && res.status === 200 && res.body.includes('data-type="comment"')) {
        return res.body;
      }
    } catch {
      // try next proxy
    }
  }
  return null;
}

// Fetch old.reddit.com subreddit listing via residential proxy. The listing page
// carries all hot posts with title, link, author, and timestamp — one request
// replaces the .rss listing that Reddit rate-limits aggressively on AI-heavy subs.
// Uses the same burst-safe proxy path as comment enrichment.
async function fetchOldRedditListing(subreddit: string, timeoutMs = 20000): Promise<string | null> {
  const url = `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/`;
  for (const proxyUrl of OLD_REDDIT_PROXIES) {
    try {
      const res = await proxyFetchFollow(url, { proxyUrl, timeoutMs, userAgent: randomUA() });
      if (res.ok && res.status === 200 && res.body.includes('data-type="link"')) {
        return res.body;
      }
    } catch {
      // try next proxy
    }
  }
  return null;
}

interface OldRedditListingItem {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  creator: string;
  contentSnippet: string;
  content: string;
}

// Parse an old.reddit.com listing page into RSS-compatible items. Extracts
// title, permalink, author, and datetime from each div.thing[data-type="link"].
// The link is always the Reddit permalink (for dedup + comment fetching); for
// link posts the external URL is discarded here — the per-post enrichment step
// recovers it when fetching comments.
function parseOldRedditListingHtml(html: string): OldRedditListingItem[] {
  const $ = cheerio.load(html);
  const items: OldRedditListingItem[] = [];

  $('div.thing[data-type="link"]').each((_, el) => {
    const $el = $(el);

    // Permalink: a.comments always points to the Reddit post
    const commentsHref = $el.find('a.comments').first().attr('href') || '';
    const permalink = commentsHref.startsWith('/') ? `https://www.reddit.com${commentsHref}` : commentsHref;

    // Title
    const titleEl = $el.find('a.title').first();
    const title = normalizeWhitespace(titleEl.text());
    if (!title || !permalink) return;

    // Author (from data-author attribute on the thing div)
    const author = $el.attr('data-author') || '';

    // Timestamp
    const timeEl = $el.find('time').first();
    const pubDate = timeEl.attr('datetime') || new Date().toISOString();

    // Selftext (only for self-posts; empty for link posts)
    const selftext = normalizeWhitespace($el.find('.expando .usertext-body .md').first().text());
    const contentHtml = $el.find('.expando .usertext-body .md').first().html() || '';

    items.push({
      title,
      link: permalink,
      guid: permalink,
      pubDate,
      creator: author,
      contentSnippet: selftext || title,
      content: contentHtml || `<p>${title}</p>`,
    });
  });

  return items;
}

// Parse an old.reddit comment-page HTML into post content + comments. The page
// markup is stable server-rendered HTML: the link/self post is a single
// div.thing[data-type=link] (selftext lives in .usertext-body .md, an external
// link in a.title.outbound[href]); each comment is div.thing[data-type=comment]
// with data-author, a body in .entry > form .usertext-body .md, and the true
// (un-fuzzed) score in span.score.unvoted[title]. We keep top-level + shallow
// replies, mirroring REDDIT_COMMENT_DEPTH.
function parseOldRedditCommentHtml(html: string, fallbackPostContent: string): RedditCommentFetchResult {
  const $ = cheerio.load(html);

  let postContent = fallbackPostContent;
  let outboundUrl: string | null = null;

  const linkThing = $('div.thing[data-type="link"]').first();
  if (linkThing.length) {
    const selftext = normalizeWhitespace(linkThing.find('.expando .usertext-body .md').first().text() || '');
    if (selftext && selftext.length > postContent.length) postContent = selftext;

    const titleHref = linkThing.find('a.title').first().attr('href') || '';
    if (titleHref && !titleHref.startsWith('/') && !titleHref.includes('reddit.com')) {
      const normalized = normalizePublicHttpUrl(titleHref);
      if (normalized) outboundUrl = normalized;
    }
  }

  const comments: ForumComment[] = [];
  $('div.thing[data-type="comment"]').each((_, el) => {
    const $el = $(el);
    // depth = nesting level; top-level comments sit at .commentarea > .sitetable
    const depth = $el.parents('div.thing[data-type="comment"]').length + 1;
    if (depth > REDDIT_COMMENT_DEPTH) return;

    const author = $el.attr('data-author') || 'unknown';
    if (author === '[deleted]') return;

    // Only this comment's own body — .entry is the comment's own block; child
    // replies live in a nested .child we must not pull text from.
    const bodyEl = $el.find('> .entry .usertext-body .md').first();
    const body = normalizeWhitespace(bodyEl.text() || '');
    if (!body || body === '[deleted]' || body === '[removed]' || body.length < 20) return;

    const scoreTitle = $el.find('> .entry .score.unvoted').first().attr('title');
    const score = scoreTitle ? parseInt(scoreTitle, 10) || 0 : 0;

    comments.push({
      author,
      body: body.substring(0, 900),
      reactions: score,
      page: depth,
      order: comments.length,
      score: scoreForumComment(body, score, depth, comments.length + 1) + (depth === 1 ? 0.8 : 0.2),
    });
  });

  return {
    postContent,
    outboundUrl,
    discussionComments: selectForumComments(comments, REDDIT_COMMENT_LIMIT),
    strategyUsed: 'oldhtml',
  };
}

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

type ForumStrategyName = 'oauth' | 'proxy' | 'rss' | 'puppeteer' | 'pullpush' | 'oldhtml';

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
      oldhtml: { attempts: 0, successes: 0 },
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

  // Primary path: old.reddit.com HTML via residential proxy. One burst-safe
  // request returns the post body AND all comments, so it replaces the per-IP
  // .rss/.json dance that was 429-throttled and timing out whole subreddits.
  try {
    markRedditStrategy(stats, 'oldhtml', false);
    const html = await fetchOldRedditHtml(postPath);
    if (html) {
      const parsed = parseOldRedditCommentHtml(html, initialPostContent);
      if (parsed.discussionComments.length > 0) {
        markRedditStrategy(stats, 'oldhtml', true);
        console.log(`[reddit] comments strategy=oldhtml count=${parsed.discussionComments.length} path=${postPath}`);
        return parsed;
      }
    }
  } catch (e: any) {
    console.log(`[reddit] comments strategy=oldhtml failed path=${postPath}: ${e.message}`);
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
    const rssRes = await fetchRedditRss(commentRssUrl);
    if (rssRes.ok) {
      const feed = await rssParser.parseString(rssRes.xml);
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

  const MAX_ARTICLES_PER_SOURCE = parsePositiveInt(process.env.MAX_ARTICLES_PER_SOURCE, 15);

  try {
    // Primary: old.reddit.com listing via residential proxy (burst-safe — no
    // per-IP cooldown). Reddit's .rss endpoint 429s aggressively on AI-related
    // subs even through proxies; old.reddit HTML handles 10+ concurrent requests
    // without rate-limiting, same path proven by comment enrichment.
    let items: RssParser.Item[] = [];
    const oldRedditHtml = await fetchOldRedditListing(subreddit);
    if (oldRedditHtml) {
      const parsed = parseOldRedditListingHtml(oldRedditHtml);
      items = parsed.slice(0, MAX_ARTICLES_PER_SOURCE) as unknown as RssParser.Item[];
      console.log(`[reddit] listing strategy=oldhtml subreddit=r/${subreddit} count=${items.length}`);
    }

    // Fallback: existing .rss path (lane-based pacing + scrapling last resort).
    // Only triggered when old.reddit.com is unreachable or returns no posts.
    if (items.length === 0) {
      const rssUrl = `https://www.reddit.com/r/${subreddit}/hot/.rss`;
      const listing = await fetchRedditRss(rssUrl);
      let xml = listing.xml;
      if (!listing.ok) {
        console.warn(`[reddit] rss proxies failed for ${rssUrl} (status ${listing.status}), falling back to Playwright`);
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
      items = (await parseForumFeedItems(xml)).slice(0, MAX_ARTICLES_PER_SOURCE);
      console.log(`[reddit] listing strategy=rss subreddit=r/${subreddit} count=${items.length}`);
    }
    result.itemsFound = items.length;

    let enrichedCount = 0;
    // old.reddit HTML is burst-safe through the proxy (probed 10/10 with no
    // rate-limit), so we can enrich every post in the listing in one run instead
    // of rationing a slow per-IP budget. One HTML page = post + all its comments.
    const MAX_ENRICH_PER_RUN = parsePositiveInt(process.env.REDDIT_MAX_ENRICH_PER_RUN, 15);

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
