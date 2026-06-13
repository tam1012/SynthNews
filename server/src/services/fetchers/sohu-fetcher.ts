import { normalizePublicHttpUrlWithDns, truncate } from '../../lib/utils.js';
import { SourceFetcher, SourceRow } from './types.js';
import type { DiscoveredArticle } from '../article-fetch-queue.js';
import type { ArticleInsertInput } from './article-writer.js';
import { insertArticleIfNew } from './article-writer.js';
import { getDefaultTimezoneForLanguage } from '../../lib/dateUtils.js';
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

const SOHU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_XCHANNEL = '/xchannel/TURBd01EQXhOVEl6'; // 000001523 = news homepage

interface SohuArticleItem {
  url: string;
  title: string;
  cover?: string | null;
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
    const html = await fetchPageHtml(xchannelUrl);

    const data = extractBlockRenderData(html);
    if (!data) {
      console.warn('[sohu] discover: no blockRenderData found, trying Scrapling fallback');
      // Fallback: try Scrapling to render the page
      const { scraplingFetch } = await import('./scrapling-fetch.js');
      const rendered = await scraplingFetch(xchannelUrl, {
        mode: 'stealth',
        blockResources: true,
        waitMs: 2000,
        timeoutMs: 30000,
      });
      const renderedData = extractBlockRenderData(rendered);
      if (!renderedData) throw new Error('Could not extract blockRenderData from Sohu page');
      const articles = findArticles(renderedData);
      return articles.map(a => ({
        sourceId: source.id,
        url: cleanSohuUrl(a.url),
        title: a.title,
        externalId: extractSohuArticleId(a.url),
        payload: {
          discovery: 'sohu:xchannel',
          imageUrl: a.cover,
        },
      }));
    }

    const articles = findArticles(data);
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
        payload: {
          discovery: 'sohu:xchannel',
          imageUrl: a.cover,
        },
      });
    }

    console.log(`[sohu] discover: found ${discovered.length} articles`);
    return discovered;
  },

  async fetchArticle(job, source): Promise<ArticleInsertInput | null> {
    const jobUrl = await normalizePublicHttpUrlWithDns(job.url, false);
    if (!jobUrl) throw new Error('Article URL must be a public http(s) URL');

    console.log(`[sohu] fetchArticle: rendering ${jobUrl} via Scrapling`);

    // Sohu article pages are SPAs — content loads via JS. Use Scrapling
    // headless browser to render the page and extract the <article> body.
    const { scraplingFetch } = await import('./scrapling-fetch.js');
    const html = await scraplingFetch(jobUrl, {
      mode: 'stealth',
      blockResources: true,
      waitMs: 2000,
      timeoutMs: 120000, // Sohu articles are 800KB+ SPAs; Scrapling has limited concurrency
    });

    if (!html || html.length < 200) {
      throw new Error('Scrapling returned empty or too-short HTML');
    }

    // Extract article content from <article> tag
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    let content = '';
    if (articleMatch) {
      content = articleMatch[1]
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      // Fallback: strip tags from full body
      content = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (!content || content.length < 100) {
      throw new Error('Article content too short');
    }

    // Extract title from <title> tag as fallback
    let title = job.title;
    if (!title || title.length < 2) {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) {
        const rawTitle = titleMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
        // Sohu titles end with "_频道_搜狐" or similar suffixes
        title = rawTitle.replace(/[_\s]*[_\s]*_.*$/, '').trim() || rawTitle;
      }
    }

    // Extract published date from meta
    let publishedAt = job.published_at;
    if (!publishedAt) {
      const dateMatch = html.match(/<meta[^>]*property=["']og:release_date["'][^>]*content=["']([^"']+)["'][^>]*>/i)
        || html.match(/<meta[^>]*itemprop=["']datePublished["'][^>]*content=["']([^"']+)["'][^>]*>/i);
      if (dateMatch) {
        const tz = getDefaultTimezoneForLanguage(source.language);
        publishedAt = dateMatch[1]; // already ISO-ish
      }
    }

    const excerpt = truncate(content, 500);

    return {
      source,
      externalId: job.external_id || extractSohuArticleId(jobUrl),
      url: jobUrl,
      title,
      publishedAt,
      rawExcerpt: excerpt,
      rawContent: content,
      contentHashSeed: `${title}${content.substring(0, 200)}`,
      imageUrl: job.payload_json?.imageUrl || null,
      metadata: { extractor: 'sohu:scrapling' },
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
