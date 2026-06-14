import { normalizePublicHttpUrlWithDns, truncate } from '../../lib/utils.js';
import { normalizeDate, getDefaultTimezoneForLanguage } from '../../lib/dateUtils.js';
import { SourceFetcher, SourceRow } from './types.js';
import type { DiscoveredArticle } from '../article-fetch-queue.js';
import type { ArticleInsertInput } from './article-writer.js';
import { insertArticleIfNew } from './article-writer.js';
import { browserHeaders, randomUA, isWorkerProxyConfigured, shouldSkipWorkerProxy, workerProxyFetch, WorkerProxyUnavailableError, isBlockedHtml } from './http-utils.js';

export function isSohuUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'sohu.com' || host.endsWith('.sohu.com');
  } catch {
    return false;
  }
}

export function isSohuSource(source: Pick<SourceRow, 'type' | 'url'>): boolean {
  return source.type === 'web' && isSohuUrl(source.url);
}

// Sohu xchannel pages: article list is embedded in `window.blockRenderData` JSON
// in the static SSR HTML (~6 articles). No browser needed.
// Sohu article detail pages on www.sohu.com are SPA shells, but m.sohu.com
// (mobile) serves full content in static HTML. We rewrite URLs to m.sohu.com
// for article fetch, making the entire pipeline browser-free.

// CJK minimum — matches article-writer.ts CJK_ARTICLE_TEXT_LENGTH
const SOHU_MIN_CONTENT_LENGTH = 160;

const DEFAULT_XCHANNEL = '/xchannel/TURBd01EQXhOVEl6'; // 000001523 = news homepage

interface SohuArticleItem {
  url: string;
  title: string;
  cover?: string | null;
}

interface SohuArticleExtraction {
  title: string;
  content: string;
  publishedAt: string | null;
  imageUrl: string | null;
}

// Sohu article IDs are numeric: /a/1035819867_161795
function extractSohuArticleId(url: string): string | null {
  const match = url.match(/\/a\/(\d+)/);
  return match ? match[1] : null;
}

// Normalize protocol-relative Sohu URLs to absolute HTTPS
function normalizeSohuUrl(rawUrl: string): string {
  if (rawUrl.startsWith('//')) return `https:${rawUrl}`;
  if (rawUrl.startsWith('http')) return rawUrl;
  return `https://www.sohu.com${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
}

// Rewrite www.sohu.com article URL to m.sohu.com for static HTML content
function toMobileSohuUrl(url: string): string {
  return url.replace(/\/\/(?:www\.)?sohu\.com\//, '//m.sohu.com/');
}

// Skip items that are clearly not news articles (social posts, videos, ads)
function isLikelyArticle(title: string): boolean {
  if (title.length < 10) return false;
  if (/^(视频|图片|组图|直播|广告|推广)/.test(title)) return false;
  return true;
}

// Extract the JSON object from `window.blockRenderData = {...};` in HTML.
// Uses brace-tracking to handle nested objects reliably.
function extractBlockRenderData(html: string): any | null {
  const marker = 'window.blockRenderData';
  const start = html.indexOf(marker);
  if (start === -1) return null;

  const eqPos = html.indexOf('=', start);
  if (eqPos === -1) return null;

  const bracePos = html.indexOf('{', eqPos);
  if (bracePos === -1) return null;

  let depth = 0;
  let end = bracePos;
  for (let i = bracePos; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  try {
    return JSON.parse(html.substring(bracePos, end));
  } catch {
    return null;
  }
}

// Walk the blockRenderData tree looking for article objects — objects that
// have both `url` (matching /a/\\d+) and `title` fields.
function findArticles(obj: any, depth: number = 0): SohuArticleItem[] {
  if (!obj || typeof obj !== 'object' || depth > 15) return [];
  if (Array.isArray(obj)) {
    return obj.flatMap(item => findArticles(item, depth + 1));
  }
  const results: SohuArticleItem[] = [];
  if (
    typeof obj.url === 'string' &&
    typeof obj.title === 'string' &&
    /\/a\/\d+/.test(obj.url) &&
    obj.title.length > 0
  ) {
    const cover = Array.isArray(obj.cover) && obj.cover.length > 0
      ? normalizeSohuUrl(obj.cover[0])
      : null;
    results.push({ url: normalizeSohuUrl(obj.url), title: obj.title, cover });
  }
  for (const v of Object.values(obj)) {
    results.push(...findArticles(v, depth + 1));
  }
  return results;
}

// Strip scm tracking params from Sohu URLs
function cleanSohuUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('scm');
    u.searchParams.delete('spm');
    return u.toString();
  } catch {
    return url;
  }
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToPlainText(html: string): string {
  return decodeBasicHtmlEntities(html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s*返回搜狐，查看更多\s*$/u, '')
    .trim();
}

function getMetaContent(html: string, selector: RegExp): string | null {
  const match = html.match(selector);
  return match ? decodeBasicHtmlEntities(match[1]).trim() : null;
}

function extractSohuArticleFromHtml(html: string, fallbackTitle: string, fallbackPublishedAt: string | null): SohuArticleExtraction {
  // m.sohu.com wraps article content in <article> tag
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const content = articleMatch ? htmlToPlainText(articleMatch[1]) : htmlToPlainText(html);

  const rawTitle =
    getMetaContent(html, /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    getMetaContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
    fallbackTitle;
  const title = rawTitle.replace(/[_\s]*搜狐.*$/u, '').trim() || fallbackTitle || rawTitle;

  const publishedAt =
    fallbackPublishedAt ||
    getMetaContent(html, /<meta[^>]*property=["']og:release_date["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    getMetaContent(html, /<meta[^>]*itemprop=["']datePublished["'][^>]*content=["']([^"']+)["'][^>]*>/i);

  const imageUrl =
    getMetaContent(html, /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    null;

  return { title, content, publishedAt, imageUrl };
}

async function fetchPageWithRetry(url: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: browserHeaders(randomUA()),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Status code ${response.status}`);
      const body = await response.text();
      if (isBlockedHtml(body)) throw new Error('blocked HTML');
      return body;
    } catch (err: any) {
      const isBlock = /blocked HTML|Status code (401|403|429)/.test(err.message || '');
      if (isBlock || attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error('native fetch failed');
}

async function fetchPageHtml(url: string): Promise<string> {
  try {
    return await fetchPageWithRetry(url);
  } catch (nativeErr: any) {
    if (isWorkerProxyConfigured() && !shouldSkipWorkerProxy(url)) {
      try {
        console.warn(`sohu-fetcher: native fetch failed for ${url}, trying Worker proxy: ${nativeErr.message}`);
        const result = await workerProxyFetch(url, { timeoutMs: 25000 });
        if (result.ok) return result.body;
      } catch (proxyErr: any) {
        if (!(proxyErr instanceof WorkerProxyUnavailableError)) {
          console.warn(`sohu-fetcher: worker proxy failed for ${url}: ${proxyErr.message}`);
        }
      }
    }
    throw nativeErr;
  }
}

export const sohuFetcher: SourceFetcher = {
  key: 'sohu',

  canHandle(source) {
    return isSohuSource(source);
  },

  async discover(source): Promise<DiscoveredArticle[]> {
    const baseUrl = source.url;
    const xchannelBase = baseUrl.includes('/xchannel/')
      ? new URL(baseUrl).origin
      : 'https://www.sohu.com';
    const xchannelPath = baseUrl.includes('/xchannel/')
      ? new URL(baseUrl).pathname
      : DEFAULT_XCHANNEL;
    const xchannelUrl = `${xchannelBase}${xchannelPath}`;

    console.log(`[sohu] discover: fetching xchannel ${xchannelUrl}`);

    // Static HTML only — no Scrapling. xchannel SSR includes ~6 articles
    // in window.blockRenderData. Scrape runs every 5 min, so ~72 articles/hour.
    const html = await fetchPageHtml(xchannelUrl);

    const data = extractBlockRenderData(html);
    if (!data) {
      throw new Error('Could not extract blockRenderData from Sohu page');
    }

    const articles = findArticles(data);
    const seen = new Set<string>();
    const discovered: DiscoveredArticle[] = [];

    for (const a of articles) {
      const id = extractSohuArticleId(a.url);
      if (!id || seen.has(id)) continue;
      if (!isLikelyArticle(a.title)) {
        console.log(`[sohu] discover: skipped non-article "${a.title}"`);
        continue;
      }
      seen.add(id);
      discovered.push({
        sourceId: source.id,
        url: cleanSohuUrl(a.url),
        title: a.title,
        externalId: id,
        payload: { discovery: 'sohu:xchannel', imageUrl: a.cover },
      });
    }

    const maxDiscover = parseInt(process.env.MAX_ARTICLES_PER_SOURCE || '20', 10);
    const limited = discovered.slice(0, maxDiscover);

    console.log(`[sohu] discover: found ${discovered.length} articles from blockRenderData, returning ${limited.length}`);
    return limited;
  },

  async fetchArticle(job, source, context): Promise<ArticleInsertInput | null> {
    const jobUrl = await normalizePublicHttpUrlWithDns(job.url, false);
    if (!jobUrl) throw new Error('Article URL must be a public http(s) URL');

    // Rewrite to mobile URL — m.sohu.com serves full content in static HTML,
    // while www.sohu.com is a SPA that needs browser rendering.
    const mobileUrl = toMobileSohuUrl(jobUrl);

    console.log(`[sohu] fetchArticle: fetching ${mobileUrl}`);

    const html = await fetchPageHtml(mobileUrl);
    if (!html || html.length < 200) {
      console.warn(`[sohu] fetchArticle: HTML too short (${html?.length || 0} bytes), skipping ${mobileUrl}`);
      return null;
    }

    const extracted = extractSohuArticleFromHtml(html, job.title, job.published_at);
    const content = extracted.content;

    if (!content || content.length < SOHU_MIN_CONTENT_LENGTH) {
      console.warn(`[sohu] fetchArticle: content too short (${content?.length || 0} < ${SOHU_MIN_CONTENT_LENGTH}), skipping ${mobileUrl}`);
      return null;
    }

    const excerpt = truncate(content, 500);
    const tz = getDefaultTimezoneForLanguage(source.language);

    return {
      source,
      externalId: job.external_id || extractSohuArticleId(job.url),
      url: jobUrl,
      title: extracted.title,
      publishedAt: normalizeDate(extracted.publishedAt, { defaultTimezone: tz }),
      rawExcerpt: excerpt,
      rawContent: content,
      contentHashSeed: `${extracted.title}${content.substring(0, 200)}`,
      imageUrl: job.payload_json?.imageUrl || extracted.imageUrl,
      metadata: { extractor: 'sohu:mobile-html' },
    };
  },

  async fetch(source) {
    const result = { itemsFound: 0, itemsInserted: 0, errors: [] as string[], metadata: {} as Record<string, unknown> };

    try {
      const discovered = await sohuFetcher.discover!(source);
      result.itemsFound = discovered.length;

      for (const item of discovered) {
        try {
          const articleInput = await sohuFetcher.fetchArticle!({
            id: '',
            source_id: source.id,
            url: item.url,
            title: item.title,
            external_id: item.externalId || null,
            published_at: item.publishedAt || null,
            payload_json: item.payload || null,
          }, source);
          if (!articleInput) continue;
          const inserted = await insertArticleIfNew({ ...articleInput });
          if (inserted) result.itemsInserted++;
        } catch (err: any) {
          result.errors.push(`Failed to fetch ${item.url}: ${err.message}`);
        }
      }
    } catch (err: any) {
      result.errors.push(err.message);
    }

    return result;
  },
};
