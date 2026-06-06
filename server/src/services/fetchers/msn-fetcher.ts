import * as cheerio from 'cheerio';
import { normalizePublicHttpUrl, normalizePublicHttpUrlWithDns, truncate } from '../../lib/utils.js';
import { SourceFetcher, SourceRow } from './types.js';
import { isMsnUrl, isMsnSource } from './registry.js';
import type { DiscoveredArticle } from '../article-fetch-queue.js';
import type { ArticleInsertInput } from './article-writer.js';
import { insertArticleIfNew } from './article-writer.js';
import { matchPromoKeyword } from '../../lib/promoFilter.js';
import { normalizeDate as normalizeDateWithTz, getDefaultTimezoneForLanguage } from '../../lib/dateUtils.js';

export { isMsnUrl, isMsnSource };

// MSN is a JavaScript-rendered aggregator: fetching the article HTML yields an
// almost-empty shell (~75 chars), tripping "content too short". But MSN exposes
// two public JSON endpoints used by its own web client:
//   - Detail API  → full article body by id (no apikey needed)
//   - channelfeed → a topic's article list (apikey required)
// We hit those directly instead of scraping HTML.

const MSN_FEED_APIKEY = process.env.MSN_FEED_APIKEY || '0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM';
const MSN_DETAIL_BASE = 'https://assets.msn.com/content/view/v2/Detail';
const MSN_FEED_BASE = 'https://assets.msn.com/service/news/feed/pages/channelfeed';
const MSN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_TOPIC = 'Top Stories';
const DEFAULT_LOCALE = 'en-us';
const DEFAULT_COUNT = 20;

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Article URLs end in `/ar-AA24HF1B`; channel URLs use `/tp-...`, so the `ar-`
// prefix cleanly isolates article ids.
export function extractMsnArticleId(url: string): string | null {
  const match = url.match(/\/ar-([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

// Locale is the first path segment on both article and channel URLs
// (e.g. /en-us/...). Fall back to en-us.
export function extractMsnLocale(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean)[0] || '';
    return /^[a-z]{2}-[a-z]{2}$/.test(seg) ? seg : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

// Topic comes from the channel path `/<locale>/channel/topic/<Topic>/tp-...`
// (URL-decoded), overridable via parser_config.msnTopic.
function parseChannelConfig(source: SourceRow): { topic: string; locale: string; count: number } {
  const config = source.parser_config || {};
  let topic = typeof config.msnTopic === 'string' && config.msnTopic.trim() ? config.msnTopic.trim() : '';
  let locale = typeof config.msnLocale === 'string' && config.msnLocale.trim() ? config.msnLocale.trim() : '';

  try {
    const u = new URL(source.url);
    if (!locale) locale = extractMsnLocale(source.url);
    if (!topic) {
      const segs = u.pathname.split('/').filter(Boolean);
      const topicIdx = segs.findIndex((s) => s.toLowerCase() === 'topic');
      if (topicIdx >= 0 && segs[topicIdx + 1]) {
        topic = decodeURIComponent(segs[topicIdx + 1]);
      }
      const queryTopic = u.searchParams.get('query');
      if (!topic && queryTopic) topic = queryTopic;
    }
  } catch {
    // fall through to defaults
  }

  return {
    topic: topic || DEFAULT_TOPIC,
    locale: locale || DEFAULT_LOCALE,
    count: parsePositiveInt(config.msnCount, DEFAULT_COUNT),
  };
}

function htmlToText(html: string): string {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg, figure figcaption').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
}

export interface MsnArticleContent {
  title: string;
  content: string;
  imageUrl: string | null;
  publishedAt: string | null;
  author: string | null;
  sourceHref: string | null;
  provider: string | null;
  metadata: any;
}

async function fetchMsnJson(url: string, timeoutMs = 15000): Promise<any> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': MSN_UA,
      Accept: 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`MSN API status ${res.status}`);
  return res.json();
}

export async function fetchMsnDetailById(articleId: string, locale: string, defaultTimezone = 'Z'): Promise<MsnArticleContent | null> {
  const data = await fetchMsnJson(`${MSN_DETAIL_BASE}/${locale}/${encodeURIComponent(articleId)}`);
  if (!data || typeof data !== 'object') return null;

  const content = htmlToText(typeof data.body === 'string' ? data.body : '');
  const title = typeof data.title === 'string' ? data.title : '';
  if (!title && !content) return null;

  const author = Array.isArray(data.authors) && data.authors[0]?.name ? String(data.authors[0].name) : null;
  const firstImage = Array.isArray(data.imageResources) && data.imageResources[0]?.url ? String(data.imageResources[0].url) : null;
  const imageUrl = firstImage ? normalizePublicHttpUrl(firstImage) : null;
  const publishedRaw = data.publishedDateTime || data.createdDateTime || null;
  const sourceHref = typeof data.sourceHref === 'string' && data.sourceHref ? data.sourceHref : null;
  const provider = data.provider?.name ? String(data.provider.name) : null;

  return {
    title,
    content,
    imageUrl,
    publishedAt: normalizeDateWithTz(publishedRaw, { defaultTimezone }),
    author,
    sourceHref,
    provider,
    metadata: { extractor: 'msn:detail-api', articleId, provider },
  };
}

export async function fetchMsnArticleByUrl(url: string, defaultTimezone = 'Z'): Promise<MsnArticleContent | null> {
  const articleId = extractMsnArticleId(url);
  if (!articleId) return null;
  return fetchMsnDetailById(articleId, extractMsnLocale(url), defaultTimezone);
}

interface MsnFeedCard {
  id: string;
  url: string;
  title: string;
  abstract: string | null;
  provider: string | null;
  publishedAt: string | null;
  img: string | null;
}

async function fetchMsnChannelFeed(topic: string, locale: string, count: number): Promise<MsnFeedCard[]> {
  const url = `${MSN_FEED_BASE}?apikey=${encodeURIComponent(MSN_FEED_APIKEY)}&cm=${encodeURIComponent(locale)}&contentType=article&query=${encodeURIComponent(topic)}&count=${count}`;
  const data = await fetchMsnJson(url, 20000);
  const sections = Array.isArray(data?.sections) ? data.sections : [];
  const cards: MsnFeedCard[] = [];
  const seen = new Set<string>();

  for (const section of sections) {
    const sectionCards = Array.isArray(section?.cards) ? section.cards : [];
    for (const card of sectionCards) {
      if (card?.type !== 'article' || !card.id || !card.url) continue;
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push({
        id: String(card.id),
        url: String(card.url),
        title: String(card.title || ''),
        abstract: typeof card.abstract === 'string' ? card.abstract : null,
        provider: card.provider?.name ? String(card.provider.name) : null,
        publishedAt: typeof card.publishedDateTime === 'string' ? card.publishedDateTime : null,
        img: typeof card.img === 'string' ? card.img : null,
      });
    }
  }

  return cards;
}

export const msnFetcher: SourceFetcher = {
  key: 'msn',
  canHandle: (source) => isMsnSource(source),

  async discover(source) {
    const { topic, locale, count } = parseChannelConfig(source);
    const cards = await fetchMsnChannelFeed(topic, locale, count);
    const defaultTimezone = getDefaultTimezoneForLanguage(source.language);

    const discovered: DiscoveredArticle[] = [];
    for (const card of cards) {
      const url = normalizePublicHttpUrl(card.url);
      if (!url || !extractMsnArticleId(url)) continue;
      discovered.push({
        sourceId: source.id,
        url,
        title: card.title || url,
        externalId: card.id,
        publishedAt: normalizeDateWithTz(card.publishedAt, { defaultTimezone }),
        payload: {
          discovery: 'msn-channelfeed',
          articleId: card.id,
          author: card.provider,
          rawExcerpt: card.abstract || '',
          imageUrl: card.img || null,
        },
      });
    }

    return discovered.slice(0, parsePositiveInt(process.env.MAX_ARTICLES_PER_SOURCE, 20));
  },

  async fetchArticle(job, source): Promise<ArticleInsertInput | null> {
    const jobUrl = await normalizePublicHttpUrlWithDns(job.url, false);
    if (!jobUrl) throw new Error('Article URL must be a public http(s) URL');

    const payload = job.payload_json || {};
    const articleId = (typeof payload.articleId === 'string' && payload.articleId) || extractMsnArticleId(jobUrl);
    if (!articleId) throw new Error('Could not extract MSN article id from URL');

    const detail = await fetchMsnDetailById(articleId, extractMsnLocale(jobUrl), getDefaultTimezoneForLanguage(source.language));
    if (!detail) throw new Error('MSN Detail API returned no article');

    const content = detail.content;
    const excerpt = content ? truncate(content, 500) : (payload.rawExcerpt || '');
    const title = detail.title || job.title;

    return {
      source,
      externalId: job.external_id || articleId,
      url: jobUrl,
      title,
      author: detail.author || payload.author || null,
      publishedAt: detail.publishedAt || job.published_at,
      rawExcerpt: excerpt,
      rawContent: content,
      contentHashSeed: `${title}${content || excerpt}`,
      imageUrl: detail.imageUrl || payload.imageUrl || null,
      metadata: detail.metadata,
    };
  },

  async fetch(source) {
    const result = { itemsFound: 0, itemsInserted: 0, errors: [] as string[], metadata: {} as Record<string, unknown> };

    try {
      const discovered = await msnFetcher.discover!(source);
      result.itemsFound = discovered.length;

      let promoSkipped = 0;
      for (const item of discovered) {
        const matchedKeyword = matchPromoKeyword(item.title);
        if (matchedKeyword) {
          promoSkipped++;
          console.log(`[promo-filter] Skipped "${item.title}" (matched: "${matchedKeyword}")`);
          continue;
        }
        try {
          const articleInput = await msnFetcher.fetchArticle!({
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
      if (promoSkipped > 0) result.metadata.promoSkipped = promoSkipped;
    } catch (err: any) {
      result.errors.push(err.message);
    }

    return result;
  },
};
