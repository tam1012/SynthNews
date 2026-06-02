import RssParser from 'rss-parser';
import * as cheerio from 'cheerio';
import { decodeHTML } from 'entities';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { normalizePublicHttpUrl, truncate, sleep } from '../../lib/utils.js';
import { matchPromoKeyword } from '../../lib/promoFilter.js';
import { BROWSER_UA, GOOGLEBOT_UA, browserHeaders, randomUA, playwrightFetch, isBlockedHtml, workerProxyFetch, isWorkerProxyConfigured, shouldSkipWorkerProxy, WorkerProxyUnavailableError, cookieAwareFetch } from './http-utils.js';
import { scraplingFetchWithFallback } from './scrapling-fetch.js';
import { hostedFetch, shouldUseHostedFetch, hasHostedFetchKey, HostedFetchUnavailableError } from './hosted-fetch.js';
import { insertArticleIfNew, MIN_ARTICLE_TEXT_LENGTH } from './article-writer.js';
import { SourceFetcher } from './types.js';
import { learnSelectorProfileFromHtml } from './selector-learning.js';
import {
  extractWithSelectorProfile,
  getDomainFromUrl,
  getSourceProfile,
  isExtractionUsable,
  recordProfileFailure,
  recordProfileSuccess,
  rowToSelectorProfile,
  saveSourceProfile,
} from './selector-profile.js';
import { discoverSitemapArticles } from './sitemap-discovery.js';
import { getBlocklistMatch, recordBlocklistHit } from './blocklist.js';
import { normalizeDate as normalizeDateWithTz, getDefaultTimezoneForLanguage } from '../../lib/dateUtils.js';

const rssParser = new RssParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'NewsDigest/1.0 (RSS Reader)',
    Accept: 'application/rss+xml, application/xml, text/xml',
  },
});

interface RssDomainPolicy {
  allowSnippetFallback: boolean;
  snippetFallbackMinLength: number;
  skipBrowserFallback?: boolean;
  browserOptions?: any;
}

const DEFAULT_RSS_SNIPPET_FALLBACK_MIN_LENGTH = parsePositiveInt(process.env.RSS_SNIPPET_FALLBACK_MIN_LENGTH, 800);

let googleDecoderPromise: Promise<any | null> | null = null;

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function getRssDomainPolicy(url: string): RssDomainPolicy {
  const hostname = getHostname(url);
  const policy: RssDomainPolicy = {
    allowSnippetFallback: true,
    snippetFallbackMinLength: DEFAULT_RSS_SNIPPET_FALLBACK_MIN_LENGTH,
  };

  if (hostname === 'nytimes.com' || hostname.endsWith('.nytimes.com')) {
    return {
      ...policy,
      // Removed skipBrowserFallback so Playwright stealth fallback can run
      browserOptions: {
        waitUntil: 'networkidle2',
        blockHeavyResources: false,
        settleMs: 2000,
      },
    };
  }

  if (hostname.includes('kotaku.com') || hostname.includes('eweek.com')) {
    return {
      ...policy,
      browserOptions: {
        waitUntil: 'domcontentloaded',
        blockHeavyResources: true,
        settleMs: 1000,
      },
    };
  }

  return policy;
}

function getNormalizedTextLength(value: string): number {
  return value.replace(/\s+/g, ' ').trim().length;
}

function buildSnippetFallbackContent(rssContent: string, rssExcerpt: string, minLength: number): string | null {
  const contentLength = getNormalizedTextLength(rssContent);
  if (contentLength >= minLength) return rssContent;

  const excerptLength = getNormalizedTextLength(rssExcerpt);
  if (excerptLength >= minLength) return rssExcerpt;

  return null;
}

function isGoogleNewsArticleUrl(url: string): boolean {
  return url.includes('news.google.com/rss/articles/');
}

async function getGoogleNewsDecoder(): Promise<any | null> {
  if (!googleDecoderPromise) {
    // @ts-ignore
    googleDecoderPromise = import('google-news-url-decoder')
      .then((decoderModule: any) => {
        const GoogleDecoder = decoderModule.GoogleDecoder || decoderModule.default;
        return GoogleDecoder ? new GoogleDecoder() : null;
      })
      .catch(() => null);
  }
  return googleDecoderPromise;
}

async function decodeGoogleNewsUrl(url: string): Promise<string> {
  if (!isGoogleNewsArticleUrl(url)) return url;

  const decoder = await getGoogleNewsDecoder();
  if (!decoder) throw new Error('Google News URL decoder is not available');

  const decoded = await decoder.decode(url);
  if (!decoded?.status || !decoded.decoded_url) {
    throw new Error(decoded?.message || 'Google News URL decoder returned no article URL');
  }

  const normalized = normalizePublicHttpUrl(decoded.decoded_url);
  if (!normalized) throw new Error('Google News decoded URL is not a public http(s) URL');
  return normalized;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldDiscoverSitemap(config: any): boolean {
  if (config?.discoverSitemap === false) return false;
  if (config?.discoverSitemap === true) return true;
  return process.env.ENABLE_SITEMAP_DISCOVERY !== 'false';
}

const SITEMAP_AUTO_TRIGGER_MIN_RSS_ITEMS = parsePositiveInt(process.env.SITEMAP_AUTO_TRIGGER_MIN_RSS_ITEMS, 5);

function mergeDiscoveredArticles<T extends { url: string }>(primary: T[], secondary: T[]): T[] {
  const seen = new Set(primary.map((item) => item.url));
  const merged = [...primary];
  for (const item of secondary) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    merged.push(item);
  }
  return merged;
}

function decodeText(value: string): string {
  return decodeHTML(value)
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(html: string): string {
  const normalized = html.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  return decodeText(cheerio.load(normalized).text());
}

function getText($item: cheerio.Cheerio<any>, selector: string): string {
  return decodeText($item.find(selector).first().text());
}

function getXmlChildHtml($item: cheerio.Cheerio<any>, selector: string): string {
  const child = $item.find(selector).first();
  return child.html()?.trim() || child.text().trim();
}

function getMetaContent($: cheerio.CheerioAPI, selector: string): string {
  return $(selector).first().attr('content')?.trim() || '';
}

function extractArticleText($: cheerio.CheerioAPI): string {
  $('script, style, noscript, iframe, svg, form, button, input, textarea, nav, header, footer, aside, .ads, .advertisement, .related, .social, .share, .comment, .comments').remove();

  const selectors = [
    'article [itemprop="articleBody"]',
    '[itemprop="articleBody"]',
    '[data-testid="article-body"]',
    '#article-container .caas-body',
    '#article-container [class*="body"]',
    '#article-container .caas-content-wrapper',
    'article',
    '.caas-body',
    '.maincontent',
    '.article-detail',
    '.article-content',
    '.ArticleContent',
    '.content-detail',
    '.detail-content',
    '.news-content',
    '.entry-content',
    '.post-content',
    '.story-body',
    'main',
  ];

  let best = '';
  for (const selector of selectors) {
    const text = $(selector).first().text().replace(/\s+/g, ' ').trim();
    if (text.length > best.length) best = text;
  }

  return best;
}

function extractWithReadability(html: string, url: string): string {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    dom.window.close();
    return article?.textContent?.replace(/\s+/g, ' ').trim() || '';
  } catch {
    return '';
  }
}

function normalizeDate(value: string | null, defaultTimezone = 'Z'): string | null {
  return normalizeDateWithTz(value, { defaultTimezone });
}

function extractJsonLdDate($: cheerio.CheerioAPI): string | null {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const raw = $(scripts[i]).html();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const candidate = item?.datePublished || item?.['@graph']?.[0]?.datePublished;
        if (candidate && typeof candidate === 'string') return candidate;
      }
    } catch {}
  }
  return null;
}

async function extractArticleFromHtml(html: string, jobUrl: string, extractor: string, defaultTimezone: string = 'Z'): Promise<{ title: string; content: string; imageUrl: string | null; publishedAt: string | null; metadata?: any }> {
  const aiExtraction = await extractWithAiSelector(html, jobUrl, defaultTimezone);
  if (aiExtraction) {
    const { extraction, sourceProfileId } = aiExtraction;
    return {
      title: extraction.title,
      content: extraction.content,
      imageUrl: extraction.imageUrl,
      publishedAt: extraction.publishedAt,
      metadata: { extractor: `${extractor}:ai-selector`, matchedSelector: extraction.matchedSelector, sourceProfileId },
    };
  }

  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    getMetaContent($, 'meta[property="og:title"]') ||
    $('title').first().text().replace(/\s+/g, ' ').trim();
  let content = extractArticleText($);
  const selectorContentLength = content.length;
  const imageUrl = getMetaContent($, 'meta[property="og:image"]') || getMetaContent($, 'meta[name="twitter:image"]') || null;
  const publishedAt = $('time[datetime]').first().attr('datetime') ||
    getMetaContent($, 'meta[property="article:published_time"]') ||
    getMetaContent($, 'meta[name="pubdate"]') ||
    getMetaContent($, 'meta[name="parsely-pub-date"]') ||
    getMetaContent($, 'meta[property="og:article:published_time"]') ||
    getMetaContent($, 'meta[itemprop="datePublished"]') ||
    $('[itemprop="datePublished"]').first().attr('content') ||
    $('[itemprop="datePublished"]').first().attr('datetime') ||
    extractJsonLdDate($) ||
    null;

  // Fallback: Mozilla Readability when cheerio selectors produce short content
  if (content.length < MIN_ARTICLE_TEXT_LENGTH) {
    const readabilityContent = extractWithReadability(html, jobUrl);
    if (readabilityContent.length > content.length) {
      content = readabilityContent;
    }
  }

  return {
    title,
    content,
    imageUrl: imageUrl ? normalizePublicHttpUrl(new URL(imageUrl, jobUrl).toString()) : null,
    publishedAt: normalizeDate(publishedAt, defaultTimezone),
    metadata: { extractor: content.length >= MIN_ARTICLE_TEXT_LENGTH && selectorContentLength < MIN_ARTICLE_TEXT_LENGTH ? `${extractor}:readability` : `${extractor}:selectors` },
  };
}

async function extractWithAiSelector(html: string, pageUrl: string, defaultTimezone: string = 'Z') {
  const domain = getDomainFromUrl(pageUrl);
  if (!domain) return null;

  const cached = await getSourceProfile(domain);
  if (cached) {
    try {
      const profile = rowToSelectorProfile(cached);
      const extraction = extractWithSelectorProfile(html, pageUrl, profile, defaultTimezone);
      if (isExtractionUsable(extraction.content, profile.minTextLength)) {
        await recordProfileSuccess(cached.id);
        return { extraction, sourceProfileId: cached.id };
      }
      await recordProfileFailure(cached.id, new Error('Cached selector profile produced short content'));
    } catch (err) {
      await recordProfileFailure(cached.id, err);
    }
  }

  try {
    const learned = await learnSelectorProfileFromHtml(pageUrl, html);
    if (!learned) return null;
    const saved = await saveSourceProfile(domain, learned.profile);
    await recordProfileSuccess(saved.id);
    // Re-extract with the correct timezone since learnSelectorProfileFromHtml extracts with default UTC
    const extraction = extractWithSelectorProfile(html, pageUrl, learned.profile, defaultTimezone);
    return { extraction, sourceProfileId: saved.id };
  } catch (err: any) {
    console.warn(`Failed to learn selector profile for ${domain}: ${err.message}`);
    return null;
  }
}

async function fetchFullArticle(jobUrl: string, policy = getRssDomainPolicy(jobUrl), defaultTimezone: string = 'Z'): Promise<{ title: string; content: string; imageUrl: string | null; publishedAt: string | null; metadata?: any }> {
  let fetchError: Error | null = null;
  let browserError: Error | null = null;
  // Track whether the free layers failed because of anti-bot blocking (vs. a
  // genuinely short/empty page). Only blocked pages escalate to Firecrawl, so
  // credits aren't spent on real 404s or thin content.
  let sawBlock = false;
  const noteBlock = (status?: number, html?: string) => {
    if (status === 401 || status === 403 || status === 429) sawBlock = true;
    if (html && isBlockedHtml(html)) sawBlock = true;
  };

  // ── Attempt 1: native fetch with random browser UA + full headers ────────
  try {
    const ua = randomUA();
    const response = await fetch(jobUrl, {
      headers: browserHeaders(ua),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { noteBlock(response.status); throw new Error(`Status code ${response.status}`); }

    const html = await response.text();
    if (isBlockedHtml(html)) { sawBlock = true; throw new Error('blocked HTML'); }
    const article = await extractArticleFromHtml(html, jobUrl, 'fetch', defaultTimezone);
    if (article.content.length >= MIN_ARTICLE_TEXT_LENGTH) return article;
    fetchError = new Error(`fetch extraction too short (${article.content.length} characters)`);
  } catch (err: any) {
    fetchError = err instanceof Error ? err : new Error(String(err));
  }

  // ── Attempt 2: native fetch with Googlebot UA ────────────────────────────────
  try {
    console.warn(`Retrying RSS article with Googlebot UA ${jobUrl}: ${fetchError?.message || 'short content'}`);
    const response = await fetch(jobUrl, {
      headers: browserHeaders(GOOGLEBOT_UA),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { noteBlock(response.status); throw new Error(`Status code ${response.status}`); }

    const html = await response.text();
    if (isBlockedHtml(html)) { sawBlock = true; throw new Error('blocked HTML'); }
    const article = await extractArticleFromHtml(html, jobUrl, 'fetch:googlebot', defaultTimezone);
    if (article.content.length >= MIN_ARTICLE_TEXT_LENGTH) return article;
    fetchError = new Error(`googlebot extraction too short (${article.content.length} characters)`);
  } catch (err: any) {
    fetchError = err instanceof Error ? err : new Error(String(err));
  }

  // ── Attempt 2b: cookie-aware redirect fetch ──────────────────────────────────
  // Sites like qdnd.vn gate the article behind a 302 + Set-Cookie that plain
  // fetch() drops across the redirect, leaving a ~400-char cookie page. Replaying
  // the cookie across hops yields the full article without spending any credits.
  try {
    const result = await cookieAwareFetch(jobUrl, { timeoutMs: 20000, userAgent: randomUA() });
    if (!result.ok) { noteBlock(result.status, result.body); throw new Error(`cookie-aware fetch status ${result.status}`); }
    const article = await extractArticleFromHtml(result.body, jobUrl, 'fetch:cookie', defaultTimezone);
    if (article.content.length >= MIN_ARTICLE_TEXT_LENGTH) return article;
    fetchError = new Error(`cookie-aware extraction too short (${article.content.length} characters)`);
  } catch (err: any) {
    fetchError = err instanceof Error ? err : new Error(String(err));
  }

  // ── Attempt 3: Cloudflare Worker proxy (better IP reputation than Oracle datacenter) ──
  if (isWorkerProxyConfigured() && !shouldSkipWorkerProxy(jobUrl)) {
    try {
      console.warn(`Retrying RSS article via Worker proxy ${jobUrl}`);
      const result = await workerProxyFetch(jobUrl, { timeoutMs: 25000 });
      if (!result.ok) { noteBlock(result.upstreamStatus, result.body); throw new Error(`worker proxy upstream ${result.upstreamStatus}`); }
      const article = await extractArticleFromHtml(result.body, jobUrl, 'worker-proxy', defaultTimezone);
      if (article.content.length >= MIN_ARTICLE_TEXT_LENGTH) return article;
      fetchError = new Error(`worker proxy extraction too short (${article.content.length} characters)`);
    } catch (err: any) {
      if (!(err instanceof WorkerProxyUnavailableError)) {
        fetchError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  // ── Attempt 4: Scrapling stealth (replaces Playwright + host browser proxy) ──
  try {
    console.warn(`Retrying RSS article with Scrapling stealth fetch ${jobUrl}`);
    await sleep(1500);
    const html = await scraplingFetchWithFallback(jobUrl, {
      mode: 'stealth',
      blockResources: true,
      waitMs: 1000,
      timeoutMs: 60000,
    }, {
      ...(policy.browserOptions || {}),
      userAgent: randomUA(),
      blockHeavyResources: true,
      settleMs: 1000,
    });
    if (isBlockedHtml(html)) { sawBlock = true; throw new Error('blocked HTML'); }
    const article = await extractArticleFromHtml(html, jobUrl, 'scrapling-stealth', defaultTimezone);
    if (article.content.length >= MIN_ARTICLE_TEXT_LENGTH) return article;
    browserError = new Error(`scrapling extraction too short (${article.content.length} characters)`);
  } catch (err: any) {
    browserError = err instanceof Error ? err : new Error(String(err));
  }

  // ── Attempt 5: Hosted fetch (ScrapingAnt -> Scrape.do -> Firecrawl) ──
  // Fires when the host is on the proactive allowlist OR the free layers were
  // blocked by anti-bot (sawBlock). Skipped for genuinely short/missing pages.
  if (hasHostedFetchKey() && (shouldUseHostedFetch(jobUrl) || sawBlock)) {
    try {
      const { html, provider } = await hostedFetch(jobUrl, 60000);
      console.warn(`Retrying RSS article via hosted fetch (${provider}) ${jobUrl}${sawBlock ? ' (block-triggered)' : ''}`);
      const article = await extractArticleFromHtml(html, jobUrl, provider, defaultTimezone);
      if (article.content.length >= MIN_ARTICLE_TEXT_LENGTH) return article;
      browserError = new Error(`hosted fetch (${provider}) extraction too short (${article.content.length} characters)`);
    } catch (err: any) {
      if (!(err instanceof HostedFetchUnavailableError)) {
        browserError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  throw new Error(`Full article fetch failed: ${fetchError?.message || 'unknown fetch error'}; browser fallback failed: ${browserError?.message || 'unknown browser error'}`);
}

export function parseRssItems(xml: string): RssParser.Item[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('item').toArray().flatMap((element) => {
    const $item = $(element);
    const title = getText($item, 'title');
    const link = getText($item, 'link');
    if (!title || !link) return [];

    return [{
      title,
      link,
      guid: getText($item, 'guid') || link,
      pubDate: getText($item, 'pubDate') || getText($item, 'published') || getText($item, 'updated'),
      creator: getText($item, 'creator') || getText($item, 'dc\\:creator'),
      contentSnippet: stripHtml(getXmlChildHtml($item, 'description')),
      content: getXmlChildHtml($item, 'encoded') || getXmlChildHtml($item, 'content\\:encoded') || getXmlChildHtml($item, 'description'),
      enclosure: { url: $item.find('enclosure').first().attr('url') || '' },
    }];
  });
}

async function parseFeedItems(xml: string): Promise<RssParser.Item[]> {
  try {
    const feed = await rssParser.parseString(xml);
    return feed.items;
  } catch {
    const items = parseRssItems(xml);
    if (items.length === 0) throw new Error('Feed not recognized as RSS 1 or 2.');
    return items;
  }
}

function normalizeFeedUrl(url: string): string {
  if (url === 'https://www.theguardian.com/international/rss') {
    return 'https://www.theguardian.com/world/rss';
  }
  return url;
}

export const rssFetcher: SourceFetcher = {
  key: 'rss',
  canHandle: (source) => source.type === 'rss',
  async discover(source) {
    const normalizedUrl = normalizePublicHttpUrl(source.url, false);
    const sourceUrl = normalizedUrl ? normalizeFeedUrl(normalizedUrl) : null;
    if (!sourceUrl) throw new Error('Source URL must be a public http(s) URL');

    let xml = '';
    let xmlOk = false;
    try {
      const response = await fetch(sourceUrl, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml;q=0.9, */*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) throw new Error(`Status code ${response.status}`);
      xml = await response.text();

      // Some anti-bot pages return 200 OK but with HTML challenge instead of XML
      if (isBlockedHtml(xml)) {
        throw new Error('Cloudflare blocked HTML received instead of RSS XML');
      }
      xmlOk = true;
    } catch (err: any) {
      if (isWorkerProxyConfigured() && !shouldSkipWorkerProxy(sourceUrl)) {
        try {
          console.warn(`rss-fetcher: native discover failed for ${sourceUrl}, trying Worker proxy: ${err.message}`);
          const result = await workerProxyFetch(sourceUrl, {
            timeoutMs: 25000,
            accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml;q=0.9, */*;q=0.8',
          });
          if (result.ok && !isBlockedHtml(result.body)) {
            xml = result.body;
            xmlOk = true;
          }
        } catch (proxyErr: any) {
          if (!(proxyErr instanceof WorkerProxyUnavailableError)) {
            console.warn(`rss-fetcher: worker proxy discover failed for ${sourceUrl}: ${proxyErr.message}`);
          }
        }
      }
      if (!xmlOk) {
        console.warn(`rss-fetcher: native+proxy failed for ${sourceUrl}, falling back to Scrapling: ${err.message}`);
        xml = await scraplingFetchWithFallback(sourceUrl, {
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
    }

    const items = (await parseFeedItems(xml)).slice(0, parsePositiveInt(process.env.MAX_ARTICLES_PER_SOURCE, 20));

    const results = [];
    for (const item of items) {
      const rawItem = item as RssParser.Item & Record<string, any>;
      if (!item.link || !item.title) continue;
      let url = normalizePublicHttpUrl(item.link);
      if (!url) continue;
      const googleNewsUrl = isGoogleNewsArticleUrl(url) ? url : null;

      if (googleNewsUrl) {
        try {
          url = await decodeGoogleNewsUrl(googleNewsUrl);
        } catch (err: any) {
          console.warn(`Failed to decode Google News URL ${googleNewsUrl}: ${err.message}`);
          continue;
        }
      }

      // Block check runs on ALL URLs (direct RSS + decoded Google News)
      const blockMatch = await getBlocklistMatch(url);
      if (blockMatch) {
        console.log(`[blocklist] Skipped "${item.title}" from blocked URL ${url} (pattern=${blockMatch.pattern})`);
        recordBlocklistHit(blockMatch.id).catch(() => {});
        continue;
      }

      const rawExcerpt = item.contentSnippet || item.content || '';
      const rawContent = item.content || rawItem['content:encoded'] || '';
      let imageUrl: string | null = null;
      if (item.enclosure?.url) {
        imageUrl = item.enclosure.url;
      } else if (rawContent) {
        const $ = cheerio.load(rawContent);
        imageUrl = $('img').first().attr('src') || null;
      }

      results.push({
        sourceId: source.id,
        url,
        title: decodeText(item.title),
        externalId: item.guid || null,
        publishedAt: normalizeDate(item.pubDate || null, getDefaultTimezoneForLanguage(source.language)),
        payload: {
          discovery: googleNewsUrl ? 'google-news-rss' : 'rss',
          author: item.creator || rawItem.author || null,
          rawExcerpt: stripHtml(rawExcerpt),
          rawContent: stripHtml(rawContent),
          contentHashSeed: decodeText(item.title) + rawExcerpt,
          imageUrl,
          googleNewsUrl,
        },
      });
    }

    if (shouldDiscoverSitemap(source.parser_config) || results.length < SITEMAP_AUTO_TRIGGER_MIN_RSS_ITEMS) {
      const sitemapArticles = await discoverSitemapArticles(source, fetch, {
        limit: parsePositiveInt(process.env.MAX_SITEMAP_ARTICLES_PER_SOURCE, 20),
        maxAgeHours: parsePositiveInt(process.env.SITEMAP_MAX_AGE_HOURS, 72),
      });
      if (sitemapArticles.length > 0) {
        const beforeCount = results.length;
        const merged = mergeDiscoveredArticles(results, sitemapArticles).slice(0, parsePositiveInt(process.env.MAX_ARTICLES_PER_SOURCE, 20));
        if (merged.length > beforeCount) {
          console.log(`[sitemap] ${source.url}: RSS=${beforeCount}, sitemap added ${merged.length - beforeCount}, total=${merged.length}`);
        }
        return merged;
      }
    }

    return results;
  },
  async fetchArticle(job, source) {
    const payload = job.payload_json || {};
    const rssExcerpt = payload.rawExcerpt || '';
    const rssContent = payload.rawContent || '';
    let fullArticle: Awaited<ReturnType<typeof fetchFullArticle>> | null = null;

    let articleUrl = job.url;
    if (isGoogleNewsArticleUrl(articleUrl)) {
      try {
        articleUrl = await decodeGoogleNewsUrl(articleUrl);
      } catch (err: any) {
        throw new Error(`Google News URL decode failed for queued article: ${err.message}`);
      }
    }

    const blockMatch = await getBlocklistMatch(articleUrl);
    if (blockMatch) {
      recordBlocklistHit(blockMatch.id).catch(() => {});
      console.log(`[blocklist] Skipped queued job for ${articleUrl} (pattern=${blockMatch.pattern})`);
      return null;
    }

    const policy = getRssDomainPolicy(articleUrl);
    let fullArticleError: string | null = null;
    try {
      fullArticle = await fetchFullArticle(articleUrl, policy, getDefaultTimezoneForLanguage(source.language));
    } catch (err: any) {
      fullArticleError = err.message;
      console.warn(`Failed to fetch full RSS article ${articleUrl}: ${err.message}`);
    }

    const fullContent = fullArticle?.content || '';
    const snippetFallbackContent = fullArticle ? null : buildSnippetFallbackContent(rssContent, rssExcerpt, policy.snippetFallbackMinLength);
    const rawContent = fullContent.length > rssContent.length ? fullContent : (snippetFallbackContent || rssContent);
    const rawExcerpt = rawContent ? truncate(rawContent, 500) : rssExcerpt;

    return {
      source,
      externalId: job.external_id,
      url: articleUrl,
      title: fullArticle?.title || job.title,
      author: payload.author || null,
      publishedAt: fullArticle?.publishedAt || job.published_at,
      rawExcerpt,
      rawContent,
      contentHashSeed: `${fullArticle?.title || job.title}${rawContent || rssExcerpt}`,
      imageUrl: fullArticle?.imageUrl || payload.imageUrl || null,
      metadata: fullArticle?.metadata || (snippetFallbackContent ? {
        extractor: 'rss:snippet-fallback',
        fullArticleError,
        snippetFallbackMinLength: policy.snippetFallbackMinLength,
        sourceUrl: articleUrl,
        googleNewsUrl: payload.googleNewsUrl || null,
      } : null),
    };
  },
  async fetch(source) {
    const result = { itemsFound: 0, itemsInserted: 0, errors: [] as string[], metadata: {} as Record<string, unknown> };

    try {
      const discovered = await rssFetcher.discover!(source);
      result.itemsFound = discovered.length;

      // Layer 1: keyword promo filter — drop deal/sale articles before DB insert
      const filtered: typeof discovered = [];
      let promoSkipped = 0;
      for (const item of discovered) {
        const matchedKeyword = matchPromoKeyword(item.title);
        if (matchedKeyword) {
          promoSkipped++;
          console.log(`[promo-filter] Skipped "${item.title}" (matched: "${matchedKeyword}")`);
          continue;
        }
        filtered.push(item);
      }
      if (promoSkipped > 0) {
        result.metadata.promoSkipped = promoSkipped;
      }

      for (const item of filtered) {
        const articleInput = await rssFetcher.fetchArticle!({
          id: '',
          source_id: source.id,
          url: item.url,
          title: item.title,
          external_id: item.externalId || null,
          published_at: item.publishedAt || null,
          payload_json: item.payload || null,
        }, source);
        if (!articleInput) continue;
        const inserted = await insertArticleIfNew({
          ...articleInput,
        });
        if (inserted) result.itemsInserted++;
      }
    } catch (err: any) {
      result.errors.push(err.message);
    }

    return result;
  },
};
