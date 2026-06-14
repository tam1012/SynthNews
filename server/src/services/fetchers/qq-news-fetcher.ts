import { normalizePublicHttpUrl, normalizePublicHttpUrlWithDns, truncate } from '../../lib/utils.js';
import { normalizeDate, getDefaultTimezoneForLanguage } from '../../lib/dateUtils.js';
import { SourceFetcher, SourceRow } from './types.js';
import type { DiscoveredArticle } from '../article-fetch-queue.js';
import type { ArticleInsertInput } from './article-writer.js';
import { insertArticleIfNew } from './article-writer.js';
import { browserHeaders, randomUA } from './http-utils.js';

// QQ News (news.qq.com / new.qq.com) is a Tencent news portal.
// Discovery: the homepage is a JS shell, but the public API at
//   i.news.qq.com/web_feed/getHotModuleList returns JSON article lists.
//   We first fetch a pac_uid (device fingerprint token) and pass it as
//   qimei36 so QQ's API accepts the request.
// Article fetch: article detail pages ship full content in static HTML
//   (inside #article-content .rich_media_content), so we can use cheap
//   native fetch before falling back to Scrapling.

function isQqNewsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'news.qq.com' || host === 'i.news.qq.com' || host.endsWith('.news.qq.com');
  } catch {
    return false;
  }
}

function isQqNewsSource(source: Pick<SourceRow, 'type' | 'url'>): boolean {
  return source.type === 'web' && isQqNewsUrl(source.url);
}

const QQ_NEWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAC_UID_URL = 'https://r.inews.qq.com/web_backend/getWebPacUid';
const HOT_MODULE_URL = 'https://i.news.qq.com/web_feed/getHotModuleList';
const MIN_CONTENT_LENGTH = 500;

const MAX_DISCOVER = parseInt(process.env.MAX_ARTICLES_PER_SOURCE ?? '20', 10);

// ---- Discovery helpers ----

async function fetchPacUid(): Promise<string | null> {
  try {
    const res = await fetch(PAC_UID_URL, {
      headers: { 'User-Agent': QQ_NEWS_UA, 'Accept': 'application/json, */*' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.data?.pac_uid ?? null;
  } catch {
    return null;
  }
}

async function fetchQqNewsJson(feedUrl: string): Promise<any> {
  const res = await fetch(feedUrl, {
    headers: {
      'User-Agent': QQ_NEWS_UA,
      'Accept': 'application/json, */*',
      'Referer': 'https://news.qq.com/',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

interface QqNewsFeedItem {
  id: string;
  title: string;
  url: string;
  mediaName?: string;
  publishTime?: string;
  imageUrl?: string;
  category?: string;
  desc?: string;
}

function parseQqNewsFeed(json: any): QqNewsFeedItem[] {
  const items: QqNewsFeedItem[] = [];
  const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.newslist) ? json.newslist : []);
  for (const item of list) {
    const url = item?.link_info?.url ?? item?.url ?? '';
    const title = item?.title ?? '';
    if (!url || !title) continue;
    items.push({
      id: String(item.id ?? ''),
      title: String(title),
      url: String(url),
      mediaName: typeof item?.media_info?.chl_name === 'string' ? item.media_info.chl_name : undefined,
      publishTime: typeof item?.publish_time === 'string' ? item.publish_time : undefined,
      imageUrl: Array.isArray(item?.pic_info?.big_img) && item.pic_info.big_img.length > 0
        ? String(item.pic_info.big_img[0])
        : undefined,
      category: typeof item?.category?.cate1_name === 'string' ? item.category.cate1_name : undefined,
      desc: typeof item?.desc === 'string' ? item.desc : undefined,
    });
  }
  return items;
}

// ---- Article fetch helpers ----

function cleanSourceAttribution(text: string): string {
  return text.replace(/[\s\n]*[\(（]来源[：:][^)）]+[\)）][\s\n]*$/u, '').trim();
}

interface QqNewsArticleExtraction {
  title: string;
  content: string;
  author: string | null;
  publishedAt: string | null;
  imageUrl: string | null;
}

async function extractArticleFromStaticHtml(
  html: string,
  jobTitle: string,
  payload: any,
): Promise<QqNewsArticleExtraction> {
  const { load: cheerioLoad } = await import('cheerio');
  const $ = cheerioLoad(html);

  let title =
    $('h1#article-title').first().text().trim() ||
    $('#article-title').first().text().trim() ||
    $('h1').first().text().trim();
  if (!title) {
    const rawTitle = $('title').first().text().trim();
    title = rawTitle.replace(/[_\s-]*腾讯新闻[_\s-]*/g, '').trim() || jobTitle;
  }

  const author = $('.media-info .media-name').first().text().trim() || null;

  let content = $('#article-content .rich_media_content').text() || '';
  if (!content) {
    content = $('.rich_media_content').text() || $('article').text() || $('body').text() || '';
  }
  content = cleanSourceAttribution(content.replace(/\s+/g, ' ').trim());

  const publishedAt =
    $('.media-meta span').first().text().trim() ||
    $('meta[property="article:published_time"]').attr('content')?.trim() ||
    $('time[datetime]').first().attr('datetime') ||
    null;

  const imageUrl = payload?.imageUrl ?? null;

  return { title, content, author, publishedAt, imageUrl };
}

export const qqNewsFetcher: SourceFetcher = {
  key: 'qq-news',
  canHandle: (source) => isQqNewsSource(source),

  async discover(source) {
    const discovered: DiscoveredArticle[] = [];
    const defaultTimezone = getDefaultTimezoneForLanguage(source.language);

    try {
      const pacUid = await fetchPacUid();
      if (!pacUid) {
        console.warn('[qq-news] discover: failed to obtain pac_uid');
        return discovered;
      }

      // If source URL is a QQ News API endpoint, use it directly (replacing {PAC_UID} placeholders).
      // Otherwise build a default hot-module-list request from the channel page URL.
      let feedUrl: string;
      if (source.url.includes('i.news.qq.com')) {
        feedUrl = source.url.replace(/\{PAC_UID\}/g, pacUid);
      } else {
        const channelId = source.parser_config?.channel_id ?? 'news_news_top';
        feedUrl = `${HOT_MODULE_URL}?channel_id=${encodeURIComponent(channelId)}&qimei36=${encodeURIComponent(pacUid)}`;
      }

      const feed = await fetchQqNewsJson(feedUrl);
      const items = parseQqNewsFeed(feed);

      for (const item of items) {
        const url = normalizePublicHttpUrl(item.url);
        if (!url) continue;
        discovered.push({
          sourceId: source.id,
          url,
          title: item.title,
          externalId: item.id || null,
          publishedAt: item.publishTime
            ? normalizeDate(item.publishTime, { defaultTimezone })
            : null,
          payload: {
            discovery: 'qq-news:hot-module',
            mediaName: item.mediaName ?? null,
            abstract: item.desc ?? '',
            imageUrl: item.imageUrl ?? null,
            category: item.category ?? null,
          },
        });
      }
    } catch (err: any) {
      console.warn(`[qq-news] discover: ${err.message}`);
    }

    return discovered.slice(0, MAX_DISCOVER);
  },

  async fetchArticle(job, source): Promise<ArticleInsertInput | null> {
    const jobUrl = await normalizePublicHttpUrlWithDns(job.url, false);
    if (!jobUrl) throw new Error('Article URL must be a public http(s) URL');

    console.log(`[qq-news] fetchArticle: fetching ${jobUrl}`);

    const payload = job.payload_json ?? {};

    // Try static HTML first — QQ News articles ship full content in the HTML
    let extractor = 'qq-news:static-html';
    let html = '';
    let staticOk = false;
    try {
      const res = await fetch(jobUrl, {
        headers: { 'User-Agent': QQ_NEWS_UA },
        signal: AbortSignal.timeout(15000),
      });
      html = res.ok ? await res.text() : '';
      if (html && html.length >= 500) {
        const extracted = await extractArticleFromStaticHtml(html, job.title, payload);
        if (extracted.content.length >= MIN_CONTENT_LENGTH) {
          const excerpt = truncate(extracted.content, 500);
          const tz = getDefaultTimezoneForLanguage(source.language);
          staticOk = true;
          return {
            source,
            externalId: job.external_id ?? null,
            url: jobUrl,
            title: extracted.title,
            author: extracted.author ?? payload?.mediaName ?? null,
            publishedAt: job.published_at || normalizeDate(extracted.publishedAt, { defaultTimezone: tz }),
            rawExcerpt: excerpt,
            rawContent: extracted.content,
            contentHashSeed: `${extracted.title}${extracted.content.substring(0, 200)}`,
            imageUrl: extracted.imageUrl ?? null,
            metadata: { extractor },
          };
        }
        console.warn(`[qq-news] fetchArticle: static content too short (${extracted.content.length} < ${MIN_CONTENT_LENGTH}), trying Scrapling ${jobUrl}`);
      } else {
        console.warn(`[qq-news] fetchArticle: static HTML too short (${html.length} bytes), trying Scrapling ${jobUrl}`);
      }
    } catch (err: any) {
      console.warn(`[qq-news] fetchArticle: native fetch failed for ${jobUrl}, trying Scrapling: ${err.message}`);
    }

    // Static HTML path didn't work — fall back to Scrapling
    if (staticOk) return null; // Should not reach here, but guard

    extractor = 'qq-news:scrapling';
    const { scraplingFetch } = await import('./scrapling-fetch.js');
    html = await scraplingFetch(jobUrl, {
      mode: 'stealth',
      blockResources: true,
      waitMs: 3000,
      timeoutMs: 90000,
    });

    if (!html || html.length < 200) {
      throw new Error('Scrapling returned empty or too-short HTML');
    }

    const extracted = await extractArticleFromStaticHtml(html, job.title, payload);
    const content = extracted.content;

    if (!content || content.length < MIN_CONTENT_LENGTH) {
      console.warn(`[qq-news] fetchArticle: content too short after Scrapling (${content?.length ?? 0} < ${MIN_CONTENT_LENGTH}), skipping ${jobUrl}`);
      return null;
    }

    const excerpt = truncate(content, 500);
    const tz = getDefaultTimezoneForLanguage(source.language);

    return {
      source,
      externalId: job.external_id ?? null,
      url: jobUrl,
      title: extracted.title,
      author: extracted.author ?? payload?.mediaName ?? null,
      publishedAt: job.published_at || normalizeDate(extracted.publishedAt, { defaultTimezone: tz }),
      rawExcerpt: excerpt,
      rawContent: content,
      contentHashSeed: `${extracted.title}${content.substring(0, 200)}`,
      imageUrl: extracted.imageUrl ?? null,
      metadata: { extractor },
    };
  },

  async fetch(source) {
    const result = { itemsFound: 0, itemsInserted: 0, errors: [] as string[], metadata: {} as Record<string, unknown> };

    try {
      const discovered = await qqNewsFetcher.discover!(source);
      result.itemsFound = discovered.length;

      for (const item of discovered) {
        try {
          const articleInput = await qqNewsFetcher.fetchArticle!({
            id: '',
            source_id: source.id,
            url: item.url,
            title: item.title,
            external_id: item.externalId ?? null,
            published_at: item.publishedAt ?? null,
            payload_json: item.payload ?? null,
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