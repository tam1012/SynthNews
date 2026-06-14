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

// Sohu is a JS-rendered SPA. The homepage (news.sohu.com) is a pure shell with
// no article links in the static HTML. Article lists are embedded in
// `window.blockRenderData` JSON inside xchannel pages. Article detail pages
// are also SPA — content loads via JS, so we use Scrapling (headless browser)
// to render them.

// Sohu xchannel pages include social-media-style posts with very short content.
// Skip articles shorter than the summarizer minimum (500 chars) at fetch time
// to avoid wasting Scrapling bandwidth on content that will be skipped anyway.
const SOHU_MIN_CONTENT_LENGTH = 500;

const SOHU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
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

// Scan rendered HTML for Sohu article links (/a/{id}) in the DOM.
// After Scrapling renders + scrolls, new articles appear as <a> tags outside
// blockRenderData. This function extracts them from the full HTML.
function findArticlesInHtml(html: string): SohuArticleItem[] {
  const results: SohuArticleItem[] = [];
  const seen = new Set<string>();
  // Match <a> tags with href containing /a/{digits}
  const linkPattern = /<a[^>]+href=["']([^"']*\/a\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1];
    const idMatch = href.match(/\/a\/(\d+)/);
    if (!idMatch || seen.has(idMatch[1])) continue;
    seen.add(idMatch[1]);
    // Extract title from inner text (strip HTML tags)
    const innerText = match[2].replace(/<[^>]+>/g, '').trim();
    if (innerText.length > 0) {
      results.push({ url: normalizeSohuUrl(href), title: innerText, cover: null });
    }
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
  // Try native fetch up to 3 times
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
  // Native fetch with retries
  try {
    return await fetchPageWithRetry(url);
  } catch (nativeErr: any) {
    // Worker proxy fallback
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
    // If source URL is a bare homepage (news.sohu.com), use the default
    // xchannel path on www.sohu.com (the xchannel endpoint lives there).
    const xchannelBase = baseUrl.includes('/xchannel/')
      ? new URL(baseUrl).origin
      : 'https://www.sohu.com';
    const xchannelPath = baseUrl.includes('/xchannel/')
      ? new URL(baseUrl).pathname
      : DEFAULT_XCHANNEL;
    const xchannelUrl = `${xchannelBase}${xchannelPath}`;

    console.log(`[sohu] discover: fetching xchannel ${xchannelUrl}`);

    // Sohu xchannel uses infinite-scroll — SSR blockRenderData only has ~6 articles.
    // Use Scrapling with auto-scroll to render the full page and trigger lazy-loading.
    let html = '';
    let usedScrapling = false;
    try {
      const { scraplingFetch } = await import('./scrapling-fetch.js');
      html = await scraplingFetch(xchannelUrl, {
        mode: 'stealth',
        blockResources: false,
        networkIdle: false,
        scrollCount: 5,
        scrollDelayMs: 1500,
        waitMs: 12000,
        timeoutMs: 90000,
      });
      usedScrapling = true;
      console.log(`[sohu] discover: Scrapling auto-scroll render complete (${html.length} bytes)`);
    } catch (scrollErr: any) {
      console.warn(`[sohu] discover: Scrapling auto-scroll failed, falling back to static HTML: ${scrollErr.message}`);
      html = await fetchPageHtml(xchannelUrl);
    }

    const data = extractBlockRenderData(html);
    if (!data) {
      if (!usedScrapling) {
        throw new Error('Could not extract blockRenderData from Sohu page');
      }
      // Scrapling rendered but no blockRenderData — try static HTML as last resort
      console.warn('[sohu] discover: no blockRenderData in Scrapling render, trying static HTML');
      const staticHtml = await fetchPageHtml(xchannelUrl);
      const staticData = extractBlockRenderData(staticHtml);
      if (!staticData) throw new Error('Could not extract blockRenderData from Sohu page');
      const articles = findArticles(staticData);
      const seen = new Set<string>();
      const discovered: DiscoveredArticle[] = [];
      for (const a of articles) {
        const id = extractSohuArticleId(a.url);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        discovered.push({
          sourceId: source.id,
          url: cleanSohuUrl(a.url),
          title: a.title,
          externalId: id,
          payload: { discovery: 'sohu:xchannel', imageUrl: a.cover },
        });
      }
      console.log(`[sohu] discover: found ${discovered.length} articles (static fallback)`);
      return discovered;
    }

    const articles = findArticles(data);

    // Also scan the full rendered HTML for article links — after Scrapling
    // auto-scroll, new articles appear as <a> tags in the DOM outside
    // blockRenderData. Merge both sets, blockRenderData titles take priority.
    const htmlArticles = usedScrapling ? findArticlesInHtml(html) : [];
    const seen = new Set<string>();
    const discovered: DiscoveredArticle[] = [];

    // blockRenderData articles first (better metadata: title + cover)
    for (const a of articles) {
      const id = extractSohuArticleId(a.url);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      discovered.push({
        sourceId: source.id,
        url: cleanSohuUrl(a.url),
        title: a.title,
        externalId: id,
        payload: { discovery: 'sohu:xchannel', imageUrl: a.cover },
      });
    }

    // HTML-scraped articles (from DOM after scrolling)
    for (const a of htmlArticles) {
      const id = extractSohuArticleId(a.url);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      discovered.push({
        sourceId: source.id,
        url: cleanSohuUrl(a.url),
        title: a.title,
        externalId: id,
        payload: { discovery: 'sohu:html-scan' },
      });
    }

    const maxDiscover = parseInt(process.env.MAX_ARTICLES_PER_SOURCE || '20', 10);
    const limited = discovered.slice(0, maxDiscover);

    console.log(`[sohu] discover: found ${discovered.length} articles (${articles.length} from blockRenderData + ${htmlArticles.length} from HTML scan), returning ${limited.length}`);
    return limited;
  },

  async fetchArticle(job, source): Promise<ArticleInsertInput | null> {
    const jobUrl = await normalizePublicHttpUrlWithDns(job.url, false);
    if (!jobUrl) throw new Error('Article URL must be a public http(s) URL');

    console.log(`[sohu] fetchArticle: fetching ${jobUrl}`);

    let html = '';
    let extractor = 'sohu:static-html';
    try {
      html = await fetchPageHtml(jobUrl);
      const staticArticle = extractSohuArticleFromHtml(html, job.title, job.published_at);
      if (staticArticle.content.length >= SOHU_MIN_CONTENT_LENGTH) {
        const excerpt = truncate(staticArticle.content, 500);
        const tz = getDefaultTimezoneForLanguage(source.language);
        return {
          source,
          externalId: job.external_id || extractSohuArticleId(job.url),
          url: jobUrl,
          title: staticArticle.title,
          publishedAt: normalizeDate(staticArticle.publishedAt, { defaultTimezone: tz }),
          rawExcerpt: excerpt,
          rawContent: staticArticle.content,
          contentHashSeed: `${staticArticle.title}${staticArticle.content.substring(0, 200)}`,
          imageUrl: job.payload_json?.imageUrl || staticArticle.imageUrl,
          metadata: { extractor },
        };
      }
      console.warn(`[sohu] fetchArticle: static HTML content too short (${staticArticle.content.length} < ${SOHU_MIN_CONTENT_LENGTH}), trying Scrapling ${jobUrl}`);
    } catch (err: any) {
      console.warn(`[sohu] fetchArticle: native fetch failed for ${jobUrl}, trying Scrapling: ${err.message}`);
    }

    // Some Sohu surfaces are still SPA shells. Use Scrapling only after the
    // cheaper static HTML path fails, so short news pages don't occupy browser
    // slots until they hit the article-fetch timeout.
    extractor = 'sohu:scrapling';
    const { scraplingFetch } = await import('./scrapling-fetch.js');
    html = await scraplingFetch(jobUrl, {
      mode: 'stealth',
      blockResources: true,
      waitMs: 2000,
      timeoutMs: 90000,
    });

    if (!html || html.length < 200) {
      throw new Error('Scrapling returned empty or too-short HTML');
    }

    const extracted = extractSohuArticleFromHtml(html, job.title, job.published_at);
    const content = extracted.content;

    if (!content || content.length < SOHU_MIN_CONTENT_LENGTH) {
      console.warn(`[sohu] fetchArticle: content too short after Scrapling (${content?.length || 0} < ${SOHU_MIN_CONTENT_LENGTH}), skipping ${jobUrl}`);
      return null;
    }

    const excerpt = truncate(content, 500);
    const tz = getDefaultTimezoneForLanguage(source.language);

    return {
      source,
      externalId: job.external_id || extractSohuArticleId(jobUrl),
      url: jobUrl,
      title: extracted.title,
      publishedAt: normalizeDate(extracted.publishedAt, { defaultTimezone: tz }),
      rawExcerpt: excerpt,
      rawContent: content,
      contentHashSeed: `${extracted.title}${content.substring(0, 200)}`,
      imageUrl: job.payload_json?.imageUrl || extracted.imageUrl,
      metadata: { extractor },
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
