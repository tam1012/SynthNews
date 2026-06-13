import { buildSitemapCandidates, parseSitemapIndexUrls, parseSitemapUrls } from '../services/fetchers/sitemap-discovery.js';
import { normalizePublicHttpUrlWithDns } from './utils.js';

type SourceType = 'rss' | 'web';

export interface SourceDetectResult {
  url: string;
  type: SourceType;
  name: string;
  detected: boolean;
  detected_kind: string;
  canonical_url: string;
  supported: boolean;
  warnings: string[];
  suggested_url?: string;
  parser_config?: any;
  rss_feeds: { url: string; title: string; type: string }[];
  preview?: any;
}

export interface ResolveFetchResponse {
  ok: boolean;
  status?: number;
  url?: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type ResolveFetch = (url: string, init?: RequestInit) => Promise<ResolveFetchResponse>;

const COMMON_FEED_PATHS = ['/feed', '/rss', '/rss.xml', '/atom.xml', '/index.xml'];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const defaultFetch: ResolveFetch = async (url, init) => {
  const safeUrl = await normalizePublicHttpUrlWithDns(url, false);
  if (!safeUrl) throw new Error('url must be a public http(s) URL');
  return fetch(safeUrl, init);
};

// Heuristic: a 200 response that is actually an anti-bot challenge page.
function looksBlocked(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 429) return true;
  if (body.length > 50000) return false;
  const lowered = body.toLowerCase();
  return lowered.includes('just a moment...') ||
    lowered.includes('challenges.cloudflare.com') ||
    lowered.includes('cf-browser-verification') ||
    lowered.includes('captcha-delivery.com') ||
    lowered.includes('access denied') ||
    lowered.includes('token.awswaf.com');
}

// Production-only resilient fetch for the primary document: native fetch, then
// Cloudflare Worker proxy (better IP reputation), then Scrapling stealth. Uses
// dynamic imports so unit tests (which inject their own fetcher) never load the
// browser/proxy stack. Returns a ResolveFetchResponse-compatible object.
async function fallbackResolveFetch(url: string, init?: RequestInit): Promise<ResolveFetchResponse> {
  const httpUtils = await import('../services/fetchers/http-utils.js');
  const safeUrl = await normalizePublicHttpUrlWithDns(url, false);
  if (!safeUrl) {
    return { ok: false, status: 400, url, headers: { get: () => 'text/plain' }, text: async () => '' };
  }

  // Native first. When the server answers with any non-blocked response
  // (200, 404, 500, ...), return it immediately — there is no point wasting
  // time on the Worker proxy or Scrapling for a URL that simply doesn't
  // exist. Fall through to the heavier methods only when native fetch throws
  // (network error / DNS / timeout) or the response looks like an anti-bot
  // challenge page.
  try {
    const res = await fetch(safeUrl, init);
    const text = await res.text();
    if (!looksBlocked(res.status, text)) {
      return { ok: res.ok, status: res.status, url: res.url || safeUrl, headers: res.headers, text: async () => text };
    }
  } catch {}

  // Worker proxy (skips CF-protected domains per WORKER_PROXY_SKIP_DOMAINS).
  if (httpUtils.isWorkerProxyConfigured() && !httpUtils.shouldSkipWorkerProxy(safeUrl)) {
    try {
      const result = await httpUtils.workerProxyFetch(safeUrl, { timeoutMs: 25000 });
      if (result.ok) {
        return { ok: true, status: 200, url: safeUrl, headers: { get: () => 'text/html' }, text: async () => result.body };
      }
    } catch {}
  }

  // Scrapling stealth (last resort; solves Cloudflare where possible).
  try {
    const { scraplingFetch } = await import('../services/fetchers/scrapling-fetch.js');
    const html = await scraplingFetch(safeUrl, { mode: 'stealth', blockResources: true, waitMs: 1000, timeoutMs: 60000 });
    if (html && !looksBlocked(200, html)) {
      return { ok: true, status: 200, url: safeUrl, headers: { get: () => 'text/html' }, text: async () => html };
    }
  } catch {}

  return { ok: false, status: 403, url: safeUrl, headers: { get: () => 'text/plain' }, text: async () => '' };
}

export { fallbackResolveFetch };

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '[::1]') return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;

  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function normalizeHttpUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (isPrivateHostname(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function resultBase(url: string): SourceDetectResult {
  return {
    url,
    type: 'web',
    name: '',
    detected: false,
    detected_kind: 'html',
    canonical_url: url,
    supported: true,
    warnings: [],
    rss_feeds: [],
  };
}

function getAttr(tag: string, attr: string): string {
  const re = new RegExp(`${attr}\\s*=\\s*(['"])(.*?)\\1`, 'i');
  return (tag.match(re)?.[2] || '').trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleFromHtml(html: string): string {
  const ogSite = html.match(/<meta\b[^>]*property=['"]og:site_name['"][^>]*>/i)?.[0];
  const ogTitle = html.match(/<meta\b[^>]*property=['"]og:title['"][^>]*>/i)?.[0];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  return getAttr(ogSite || '', 'content') || getAttr(ogTitle || '', 'content') || stripTags(title);
}

function descriptionFromHtml(html: string): string {
  const meta = html.match(/<meta\b[^>]*(?:name|property)=['"](?:description|og:description)['"][^>]*>/i)?.[0];
  return getAttr(meta || '', 'content');
}

function imageFromHtml(html: string): string {
  const meta = html.match(/<meta\b[^>]*property=['"]og:image['"][^>]*>/i)?.[0];
  return getAttr(meta || '', 'content');
}

function langFromHtml(html: string): string {
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || '';
  return getAttr(htmlTag, 'lang');
}

function canonicalFromHtml(html: string, fallbackUrl: string): string {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = getAttr(tag, 'rel').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical')) continue;
    const href = getAttr(tag, 'href');
    if (!href) continue;
    try {
      return new URL(href, fallbackUrl).toString();
    } catch {
      continue;
    }
  }
  return fallbackUrl;
}

function feedShape(text: string): boolean {
  const sample = text.slice(0, 3000);
  return /<rss[\s>]/i.test(sample) || /<feed[\s>]/i.test(sample);
}

function isHtmlLike(contentType: string, text: string): boolean {
  return contentType.toLowerCase().includes('text/html') || /<!doctype html|<html/i.test(text.slice(0, 1000));
}

function feedLinksFromHtml(html: string, baseUrl: string): { url: string; title: string; type: string }[] {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  const out: { url: string; title: string; type: string }[] = [];

  for (const tag of tags) {
    const rel = getAttr(tag, 'rel').toLowerCase().split(/\s+/);
    const type = getAttr(tag, 'type').toLowerCase();
    const href = getAttr(tag, 'href');
    if (!href || !rel.includes('alternate')) continue;
    if (!type.includes('application/rss+xml') && !type.includes('application/atom+xml')) continue;
    try {
      const url = new URL(href, baseUrl).toString();
      if (!out.some((feed) => feed.url === url)) {
        out.push({ url, title: getAttr(tag, 'title') || 'RSS Feed', type: 'rss' });
      }
    } catch {
      // Ignore bad feed links.
    }
  }

  return out;
}

function redditRssUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'reddit.com' && host !== 'www.reddit.com') return null;
    const match = parsed.pathname.match(/^\/r\/([^/]+)\/?$/i);
    if (!match) return null;
    return `https://www.reddit.com/r/${match[1]}/.rss`;
  } catch {
    return null;
  }
}

function isVozUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'voz.vn' || host === 'www.voz.vn';
  } catch {
    return false;
  }
}

function isYoutubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtube.com' || host === 'www.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

function isGithubTrendingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === 'github.com' && parsed.pathname.toLowerCase().startsWith('/trending');
  } catch {
    return false;
  }
}

function githubTrendingPreset(url: string): SourceDetectResult {
  const result = resultBase(url);
  result.type = 'web';
  result.name = 'GitHub Trending';
  result.detected = true;
  result.detected_kind = 'github-trending';
  result.canonical_url = url;
  result.parser_config = {
    kind: 'github-trending',
    articleLinkSelector: 'article.Box-row h2 a',
    titleSelector: 'strong[itemprop="name"] a, h1',
    contentSelector: 'article.markdown-body, #readme, main',
    removeSelectors: ['script', 'style', 'nav', 'footer'],
  };
  result.preview = {
    title: 'GitHub Trending',
    description: 'Trending repositories on GitHub',
    rss_count: 0,
  };
  return result;
}

async function probeFeed(url: string, fetcher: ResolveFetch): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return false;
    const text = await response.text();
    const contentType = response.headers?.get('content-type') || '';
    return !isHtmlLike(contentType, text) && feedShape(text);
  } catch {
    return false;
  }
}

async function probeSitemaps(url: string, fetcher: ResolveFetch): Promise<{ sitemapCount: number; recentSitemapCount: number }> {
  let sitemapCount = 0;
  let recentSitemapCount = 0;
  const candidates = buildSitemapCandidates(url).slice(0, 5);

  for (const candidate of candidates) {
    try {
      const response = await fetcher(candidate, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) continue;
      const xml = await response.text();
      const childUrls = parseSitemapIndexUrls(xml, candidate).slice(0, 5);
      const directEntries = parseSitemapUrls(xml, candidate, { maxAgeHours: 72 });
      sitemapCount += directEntries.length;
      recentSitemapCount += directEntries.length;

      for (const child of childUrls) {
        try {
          const childResponse = await fetcher(child, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(10000),
          });
          if (!childResponse.ok) continue;
          const childXml = await childResponse.text();
          const childEntries = parseSitemapUrls(childXml, child, { maxAgeHours: 72 });
          sitemapCount += childEntries.length;
          recentSitemapCount += childEntries.length;
        } catch {}
      }
    } catch {}
  }

  return { sitemapCount, recentSitemapCount };
}

export async function resolveSourceUrl(rawUrl: string, fetcher: ResolveFetch = defaultFetch): Promise<SourceDetectResult> {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) throw new Error('url must be a public http(s) URL');

  const reddit = redditRssUrl(normalized);
  if (reddit) {
    const result = resultBase(normalized);
    const subredditName = new URL(normalized).pathname.match(/^\/r\/([^/]+)/i)?.[1] || 'reddit';
    result.type = 'rss';
    result.name = `Reddit r/${subredditName}`;
    result.detected = true;
    result.detected_kind = 'reddit';
    result.suggested_url = reddit;
    result.rss_feeds = [{ url: reddit, title: `Reddit r/${subredditName}`, type: 'rss' }];
    result.preview = { title: result.name, description: 'Reddit subreddit feed', rss_count: 1 };
    return result;
  }

  if (isYoutubeUrl(normalized)) {
    const result = resultBase(normalized);
    result.name = 'YouTube';
    result.detected = true;
    result.detected_kind = 'youtube';
    result.supported = false;
    result.warnings.push('YouTube sources are disabled. Use the YouTube app for videos.');
    return result;
  }

  if (isGithubTrendingUrl(normalized)) {
    return githubTrendingPreset(normalized);
  }

  const result = resultBase(normalized);
  if (isVozUrl(normalized)) {
    result.detected_kind = 'voz';
  }

  try {
    const response = await fetcher(normalized, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(response.status ? `Status code ${response.status}` : 'Source URL returned a non-OK response');
    }
    const body = await response.text();
    const responseUrl = response.url || normalized;
    const contentType = response.headers?.get('content-type') || '';
    result.canonical_url = responseUrl;

    if (!isHtmlLike(contentType, body) && feedShape(body)) {
      result.type = 'rss';
      result.name = titleFromHtml(body) || new URL(responseUrl).hostname;
      result.detected = true;
      result.detected_kind = result.detected_kind === 'voz' ? 'voz' : 'rss';
      result.preview = { title: result.name, description: '', items_count: 0, rss_count: 1 };
      return result;
    }

    result.canonical_url = canonicalFromHtml(body, responseUrl);
    result.name = titleFromHtml(body) || new URL(result.canonical_url).hostname;
    result.rss_feeds = feedLinksFromHtml(body, result.canonical_url);

    const canonical = new URL(result.canonical_url);
    for (const path of COMMON_FEED_PATHS) {
      const candidate = `${canonical.origin}${path}`;
      if (result.rss_feeds.some((feed) => feed.url === candidate)) continue;
      if (await probeFeed(candidate, fetcher)) {
        result.rss_feeds.push({ url: candidate, title: 'RSS Feed', type: 'rss' });
      }
    }

    const sitemapPreview = await probeSitemaps(result.canonical_url, fetcher);

    result.detected = true;
    if (result.rss_feeds.length > 0) {
      result.type = 'rss';
      result.suggested_url = result.rss_feeds[0].url;
      if (result.detected_kind === 'html') result.detected_kind = 'rss';
    } else if (sitemapPreview.sitemapCount > 0) {
      result.type = 'web';
      result.parser_config = { discoverSitemap: true };
    } else {
      // No RSS and no sitemap detected: keep it crawlable anyway. The html
      // fetcher runs heuristic link scoring + sitemap discovery without needing
      // a hand-written articleLinkSelector, so a bare section URL still works.
      result.type = 'web';
      result.parser_config = { discoverSitemap: true };
    }

    result.preview = {
      title: titleFromHtml(body),
      description: descriptionFromHtml(body),
      image: imageFromHtml(body),
      language: langFromHtml(body),
      rss_count: result.rss_feeds.length,
      sitemap_count: sitemapPreview.sitemapCount,
      recent_sitemap_count: sitemapPreview.recentSitemapCount,
    };
  } catch (err: any) {
    result.warnings.push(err.message || 'Failed to inspect source URL');
  }

  return result;
}
