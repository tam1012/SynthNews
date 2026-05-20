import * as cheerio from 'cheerio';
import { normalizePublicHttpUrl } from '../../lib/utils.js';
import { browserHeaders, randomUA } from './http-utils.js';
import type { DiscoveredArticle } from '../article-fetch-queue.js';
import type { SourceRow } from './types.js';

export interface SitemapArticleEntry {
  url: string;
  title: string;
  publishedAt: string | null;
  sitemapUrl?: string;
}

export interface SitemapParseOptions {
  maxAgeHours?: number;
  now?: Date;
  defaultTimezone?: string;
}

export interface SitemapFetchResponse {
  ok: boolean;
  status?: number;
  text(): Promise<string>;
}

export type SitemapFetch = (url: string, init?: RequestInit) => Promise<SitemapFetchResponse>;

const SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/news-sitemap.xml',
  '/news_sitemap.xml',
  '/sitemap_news.xml',
  '/post-sitemap.xml',
  '/sitemaps/news.xml',
  '/sitemap-news.xml',
  '/google-news-sitemap.xml',
  '/sitemap-google-news.xml',
];

const SITEMAP_CACHE_TTL_MS = (() => {
  const parsed = parseInt(process.env.SITEMAP_CACHE_TTL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();

const sitemapXmlCache = new Map<string, { xml: string; ts: number }>();

function normalizeDate(value: string | null, defaultTimezone: string = 'Z'): string | null {
  if (!value) return null;
  let normalized = value.trim();
  if (!normalized) return null;
  // If datetime looks like ISO but has no timezone suffix, assume defaultTimezone
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) {
    normalized += defaultTimezone;
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    normalized = normalized.replace(' ', 'T') + defaultTimezone;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized += `T00:00:00${defaultTimezone}`;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isRecentEnough(value: string | null, options: SitemapParseOptions): boolean {
  if (!options.maxAgeHours || !value) return true;
  const published = new Date(value);
  if (Number.isNaN(published.getTime())) return true;
  const now = options.now || new Date();
  return now.getTime() - published.getTime() <= options.maxAgeHours * 60 * 60 * 1000;
}

function getText($node: cheerio.Cheerio<any>, selector: string): string {
  return $node.find(selector).first().text().replace(/\s+/g, ' ').trim();
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(last).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || url;
  } catch {
    return url;
  }
}

export function buildSitemapCandidates(siteUrl: string): string[] {
  const normalized = normalizePublicHttpUrl(siteUrl, false);
  if (!normalized) return [];

  try {
    const origin = new URL(normalized).origin;
    return SITEMAP_PATHS.map((path) => `${origin}${path}`);
  } catch {
    return [];
  }
}

export function parseSitemapIndexUrls(xml: string, baseUrl: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const seen = new Set<string>();
  const urls: string[] = [];

  $('sitemap').each((_: number, element: any) => {
    const rawLoc = getText($(element), 'loc');
    if (!rawLoc) return;
    try {
      const normalized = normalizePublicHttpUrl(new URL(rawLoc, baseUrl).toString());
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      urls.push(normalized);
    } catch {}
  });

  return urls;
}

export function parseSitemapUrls(xml: string, baseUrl: string, options: SitemapParseOptions = {}): SitemapArticleEntry[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const seen = new Set<string>();
  const entries: SitemapArticleEntry[] = [];

  $('url').each((_: number, element: any) => {
    const $url = $(element);
    const rawLoc = getText($url, 'loc');
    if (!rawLoc) return;

    try {
      const normalized = normalizePublicHttpUrl(new URL(rawLoc, baseUrl).toString());
      if (!normalized || seen.has(normalized)) return;

      const newsTitle = getText($url, 'news\\:title') || getText($url, 'title');
      const newsPublishedAt = normalizeDate(getText($url, 'news\\:publication_date'), options.defaultTimezone);
      const lastModifiedAt = normalizeDate(getText($url, 'lastmod'), options.defaultTimezone);
      const publishedAt = newsPublishedAt || lastModifiedAt;
      if (!isRecentEnough(publishedAt, options)) return;

      seen.add(normalized);
      entries.push({
        url: normalized,
        title: newsTitle || titleFromUrl(normalized),
        publishedAt,
      });
    } catch {}
  });

  return entries;
}

export async function discoverSitemapArticles(
  source: Pick<SourceRow, 'id' | 'url'> & { language?: string },
  fetcher: SitemapFetch = fetch,
  options: SitemapParseOptions & { limit?: number; candidates?: string[] } = {},
): Promise<DiscoveredArticle[]> {
  const candidates = options.candidates || buildSitemapCandidates(source.url);
  const sitemapUrls = [...candidates];
  const seenSitemaps = new Set<string>();
  const seenArticles = new Set<string>();
  const articles: DiscoveredArticle[] = [];
  const limit = Math.max(1, options.limit || 20);
  // Inherit language-based default timezone if caller didn't supply one
  const effectiveOptions: SitemapParseOptions & { limit?: number; candidates?: string[] } =
    options.defaultTimezone
      ? options
      : { ...options, defaultTimezone: source.language === 'vi' ? '+07:00' : 'Z' };

  for (let index = 0; index < sitemapUrls.length && articles.length < limit; index++) {
    const sitemapUrl = sitemapUrls[index];
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const cached = sitemapXmlCache.get(sitemapUrl);
      const now = Date.now();
      let xml: string | null = null;

      if (cached && now - cached.ts < SITEMAP_CACHE_TTL_MS) {
        xml = cached.xml;
      } else {
        const response = await fetcher(sitemapUrl, {
          headers: browserHeaders(randomUA()),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) continue;
        xml = await response.text();
        sitemapXmlCache.set(sitemapUrl, { xml, ts: now });
      }

      for (const child of parseSitemapIndexUrls(xml, sitemapUrl)) {
        if (!seenSitemaps.has(child) && sitemapUrls.length < candidates.length + 20) {
          sitemapUrls.push(child);
        }
      }

      for (const entry of parseSitemapUrls(xml, sitemapUrl, effectiveOptions)) {
        if (seenArticles.has(entry.url)) continue;
        seenArticles.add(entry.url);
        articles.push({
          sourceId: source.id,
          url: entry.url,
          title: entry.title,
          externalId: entry.url,
          publishedAt: entry.publishedAt,
          payload: {
            discovery: 'sitemap',
            sitemapUrl,
            rawExcerpt: '',
            rawContent: '',
          },
        });
        if (articles.length >= limit) break;
      }
    } catch {}
  }

  return articles;
}
