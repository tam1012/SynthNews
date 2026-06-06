import * as cheerio from 'cheerio';
import { normalizePublicHttpUrl, normalizePublicHttpUrlWithDns, truncate, sleep } from '../../lib/utils.js';
import { matchPromoKeyword } from '../../lib/promoFilter.js';
import { browserHeaders, isBlockedHtml, randomUA, playwrightFetch, workerProxyFetch, isWorkerProxyConfigured, shouldSkipWorkerProxy, WorkerProxyUnavailableError, cookieAwareFetch } from './http-utils.js';
import { scraplingFetchWithFallback, getScraplingProxyForUrl, isResidentialProxyConfigured } from './scrapling-fetch.js';
import { hostedFetch, shouldUseHostedFetch, hasHostedFetchKey, isDataDomeHost } from './hosted-fetch.js';
import { archiveTodayFetch, shouldUseArchiveFallback } from './archive-fetch.js';
import { extractStructuredArticle } from './structured-data.js';
import { insertArticleIfNew } from './article-writer.js';
import type { DiscoveredArticle } from '../article-fetch-queue.js';
import { SourceFetcher } from './types.js';
import { discoverSitemapArticles } from './sitemap-discovery.js';
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
import { getDefaultTimezoneForLanguage, normalizeDate } from '../../lib/dateUtils.js';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldDiscoverSitemap(config: any): boolean {
  return config?.discoverSitemap === true || process.env.ENABLE_SITEMAP_DISCOVERY === 'true';
}

function dedupeDiscovered<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function scoreArticleLink(url: string, title: string, sourceUrl: string): number {
  try {
    const parsed = new URL(url);
    const source = new URL(sourceUrl);
    if (parsed.hostname.replace(/^www\./, '') !== source.hostname.replace(/^www\./, '')) return 0;

    const path = parsed.pathname.toLowerCase();
    if (/\/(tag|tags|author|login|subscribe|search|category|privacy|about|contact)\b/.test(path)) return 0;
    if (/facebook|twitter|x\.com|linkedin|mailto:|javascript:/i.test(url)) return 0;

    const slug = path.split('/').filter(Boolean).pop() || '';
    let score = 0;
    if (/\/20\d{2}[/-]/.test(path) || /\/\d{4}\/\d{2}\//.test(path)) score += 5;
    if (/\/(news|world|business|technology|tech|article|story|politics|markets)\b/.test(path)) score += 4;
    if (slug.length >= 24 && /[-_]/.test(slug)) score += 4;
    if (title.length >= 24) score += 3;
    if (title.length >= 50) score += 2;
    if (path.split('/').filter(Boolean).length >= 2) score += 1;
    return score;
  } catch {
    return 0;
  }
}

function collectHeuristicArticleLinks($: cheerio.CheerioAPI, sourceUrl: string, sourceId: string): { sourceId: string; url: string; title: string; payload: any }[] {
  const candidates: { sourceId: string; url: string; title: string; payload: any; score: number }[] = [];

  $('a[href]').each((_: number, el: any) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const publicUrl = normalizePublicHttpUrl(new URL(href, sourceUrl).toString());
      if (!publicUrl) return;
      const title = $(el).text().replace(/\s+/g, ' ').trim();
      const score = scoreArticleLink(publicUrl, title, sourceUrl);
      if (score < 6) return;
      candidates.push({
        sourceId,
        url: publicUrl,
        title: title || publicUrl,
        payload: { discovery: 'web-heuristic', discoveryScore: score },
        score,
      });
    } catch {}
  });

  return dedupeDiscovered(candidates.sort((a, b) => b.score - a.score)).map(({ score, ...item }) => item);
}

function getMetaContent($: cheerio.CheerioAPI, selector: string): string {
  return $(selector).first().attr('content')?.trim() || '';
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
        return { extraction, matchedSelector: extraction.matchedSelector, sourceProfileId: cached.id };
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
    const extraction = extractWithSelectorProfile(html, pageUrl, learned.profile, defaultTimezone);
    return { extraction, matchedSelector: extraction.matchedSelector, sourceProfileId: saved.id };
  } catch (err: any) {
    console.warn(`Failed to learn selector profile for ${domain}: ${err.message}`);
    return null;
  }
}

export const htmlFetcher: SourceFetcher = {
  key: 'html',
  canHandle: (source) => source.type === 'web',
  async discover(source) {
    const config = source.parser_config || {};
    const sitemapEnabled = shouldDiscoverSitemap(config);
    // No articleLinkSelector required: web sources fall back to heuristic link
    // scoring (collectHeuristicArticleLinks) and/or sitemap discovery. A bare
    // URL like https://www.reuters.com/world/ is enough to start crawling.

    const sourceUrl = await normalizePublicHttpUrlWithDns(source.url, false);
    if (!sourceUrl) throw new Error('Source URL must be a public http(s) URL');

    let html = '';
    let discoverOk = false;
    try {
      const response = await fetch(sourceUrl, {
        headers: browserHeaders(randomUA()),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Status code ${response.status}`);
      html = await response.text();
      if (isBlockedHtml(html)) throw new Error('blocked HTML');
      discoverOk = true;
    } catch (err: any) {
      if (isWorkerProxyConfigured() && !shouldSkipWorkerProxy(sourceUrl)) {
        try {
          console.warn(`html-fetcher: native discover failed for ${sourceUrl}, trying Worker proxy: ${err.message}`);
          const result = await workerProxyFetch(sourceUrl, { timeoutMs: 25000 });
          if (result.ok) {
            html = result.body;
            discoverOk = true;
          }
        } catch (proxyErr: any) {
          if (!(proxyErr instanceof WorkerProxyUnavailableError)) {
            console.warn(`html-fetcher: worker proxy discover failed for ${sourceUrl}: ${proxyErr.message}`);
          }
        }
      }
      if (!discoverOk) {
        console.warn(`html-fetcher: native+proxy discover failed for ${sourceUrl}, falling back to Scrapling: ${err.message}`);
        html = await scraplingFetchWithFallback(sourceUrl, {
          mode: 'stealth',
          blockResources: true,
          waitMs: 1000,
        }, {
          rawText: false,
          blockHeavyResources: true,
          settleMs: 1000,
          userAgent: randomUA(),
        });
      }
    }

    let $ = cheerio.load(html);

    const discovered: DiscoveredArticle[] = [];
    const collectLinks = () => {
      discovered.length = 0;
      if (!config.articleLinkSelector) return;
      $(config.articleLinkSelector).each((_: number, el: any) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
          const publicUrl = normalizePublicHttpUrl(new URL(href, sourceUrl).toString());
          if (!publicUrl) return;
          const title = $(el).text().replace(/\s+/g, ' ').trim() || publicUrl;
          discovered.push({ sourceId: source.id, url: publicUrl, title, payload: { discovery: 'web-selector' } });
        } catch {}
      });
    };

    collectLinks();
    const minDiscoveredLinks = Number.isInteger(config.minDiscoveredLinks) && config.minDiscoveredLinks > 0 ? config.minDiscoveredLinks : 3;
    if (discovered.length < minDiscoveredLinks) {
      discovered.push(...collectHeuristicArticleLinks($, sourceUrl, source.id));
    }

    if (discovered.length === 0) {
      console.warn(`html-fetcher: native discover found 0 links for ${sourceUrl}, falling back to Scrapling`);
      html = await scraplingFetchWithFallback(sourceUrl, {
        mode: 'stealth',
        blockResources: true,
        waitMs: 1000,
      }, {
        rawText: false,
        blockHeavyResources: true,
        settleMs: 1000,
        userAgent: randomUA(),
      });
      $ = cheerio.load(html);
      collectLinks();
      if (discovered.length < minDiscoveredLinks) {
        discovered.push(...collectHeuristicArticleLinks($, sourceUrl, source.id));
      }
    }

    if (sitemapEnabled) {
      const sitemapArticles = await discoverSitemapArticles(source, fetch, {
        limit: parsePositiveInt(process.env.MAX_SITEMAP_ARTICLES_PER_SOURCE, 20),
        maxAgeHours: parsePositiveInt(process.env.SITEMAP_MAX_AGE_HOURS, 72),
      });
      discovered.push(...sitemapArticles);
    }

    return dedupeDiscovered(discovered)
      .slice(0, parsePositiveInt(process.env.MAX_ARTICLES_PER_SOURCE, 20));
  },
  async fetchArticle(job, source) {
    const config = source.parser_config || {};
    const jobUrl = await normalizePublicHttpUrlWithDns(job.url, false);
    if (!jobUrl) throw new Error('Article URL must be a public http(s) URL');

    await sleep(500);
    // Try native fetch first, then worker proxy, then Scrapling stealth fallback
    let articleHtml = '';
    let fetchOk = false;
    // Track anti-bot blocking so a blocked page escalates to Firecrawl even when
    // the host isn't on the proactive allowlist. Genuine errors don't escalate.
    let sawBlock = false;
    try {
      const articleRes = await fetch(jobUrl, {
        headers: browserHeaders(randomUA()),
        signal: AbortSignal.timeout(15000),
      });
      if (!articleRes.ok) {
        if ([401, 403, 429].includes(articleRes.status)) sawBlock = true;
        throw new Error(`Status code ${articleRes.status}`);
      }
      articleHtml = await articleRes.text();
      if (isBlockedHtml(articleHtml)) { sawBlock = true; throw new Error('blocked HTML'); }
      fetchOk = true;
    } catch (firstErr: any) {
      // Attempt 1b: cookie-aware redirect fetch — handles sites (qdnd.vn) that
      // gate the article behind a 302 + Set-Cookie that plain fetch() drops.
      if (!fetchOk) {
        try {
          const result = await cookieAwareFetch(jobUrl, { timeoutMs: 20000, userAgent: randomUA() });
          if (result.ok) {
            articleHtml = result.body;
            fetchOk = true;
          } else if ([401, 403, 429].includes(result.status) || isBlockedHtml(result.body)) {
            sawBlock = true;
          }
        } catch (cookieErr: any) {
          console.warn(`html-fetcher: cookie-aware fetch failed for ${jobUrl}: ${cookieErr.message}`);
        }
      }
      if (!fetchOk && isWorkerProxyConfigured() && !shouldSkipWorkerProxy(jobUrl)) {
        try {
          console.warn(`html-fetcher: native fetch failed for ${jobUrl}, trying Worker proxy: ${firstErr.message}`);
          const result = await workerProxyFetch(jobUrl, { timeoutMs: 25000 });
          if (result.ok) {
            articleHtml = result.body;
            fetchOk = true;
          } else if ([401, 403, 429].includes(result.upstreamStatus) || isBlockedHtml(result.body)) {
            sawBlock = true;
          }
        } catch (proxyErr: any) {
          if (!(proxyErr instanceof WorkerProxyUnavailableError)) {
            console.warn(`html-fetcher: worker proxy failed for ${jobUrl}: ${proxyErr.message}`);
          }
        }
      }
      if (!fetchOk) {
        console.warn(`html-fetcher: native+proxy failed for ${jobUrl}, falling back to Scrapling: ${firstErr.message}`);
        try {
          // DataDome hosts NOT served by the proxy allowlist (Reuters/WSJ) only ever
          // get the ~1.5KB captcha-delivery shell from a datacenter-IP scrapling
          // render — it can never clear DataDome, so the render just burns a scarce
          // sidecar slot. Skip it and drop straight into the escalation chain below
          // (archive.today + hosted-fetch DATADOME_CHAIN, the only paths that work).
          // Bloomberg is excluded because getScraplingProxyForUrl serves it via the
          // residential proxy, where the stealth render DOES succeed.
          if (isDataDomeHost(jobUrl) && !getScraplingProxyForUrl(jobUrl)) {
            sawBlock = true;
            throw new Error('skip scrapling stealth for DataDome host (datacenter IP cannot clear it)');
          }
          articleHtml = await scraplingFetchWithFallback(jobUrl, {
            mode: 'stealth',
            blockResources: false,
            waitMs: 1000,
          }, {
            rawText: false,
            blockHeavyResources: false,
            settleMs: 1000,
            userAgent: randomUA(),
          });
          if (isBlockedHtml(articleHtml)) { sawBlock = true; throw new Error('blocked HTML'); }
          fetchOk = true;
        } catch (scrErr: any) {
          // Escalation 1: Scrapling THROUGH the paid residential proxy, when the
          // free pass was anti-bot blocked and the host isn't already proxied by
          // allowlist. One paid proxy covers any blocked site, and runs before the
          // metered hosted-fetch providers (free quota exhausted).
          if (sawBlock && isResidentialProxyConfigured() && !getScraplingProxyForUrl(jobUrl) && !isDataDomeHost(jobUrl)) {
            try {
              const proxied = await scraplingFetchWithFallback(jobUrl, {
                mode: 'stealth',
                forceProxy: true,
                timeoutMs: 180000,
              }, {
                rawText: false,
                blockHeavyResources: false,
                settleMs: 1500,
                userAgent: randomUA(),
              });
              if (!isBlockedHtml(proxied)) {
                console.warn(`html-fetcher: scrapling+residential proxy recovered ${jobUrl} (block-triggered)`);
                articleHtml = proxied;
                fetchOk = true;
              }
            } catch (proxyErr: any) {
              console.warn(`html-fetcher: scrapling+proxy failed for ${jobUrl}: ${proxyErr.message}`);
            }
          }
          // Escalation 2: archive.today, BEFORE hosted-fetch for paywalled hosts.
          // archive.today keeps full snapshots that clear both the DataDome wall
          // AND the paywall in one free request, where hosted-fetch burns a metered
          // residential credit and often returns only the non-subscriber lede.
          if (!fetchOk && shouldUseArchiveFallback(jobUrl)) {
            try {
              const archived = await archiveTodayFetch(jobUrl, 60000);
              if (archived) {
                console.warn(`html-fetcher: archive.today recovered ${jobUrl}`);
                articleHtml = archived;
                fetchOk = true;
              }
            } catch (archiveErr: any) {
              console.warn(`html-fetcher: archive.today failed for ${jobUrl}: ${archiveErr.message}`);
            }
          }
          // Escalation 3: hosted fetch (ScrapingAnt -> Scrape.do -> Firecrawl).
          // Fires for allowlist hosts OR any host blocked by anti-bot along the way.
          if (!fetchOk) {
            if (hasHostedFetchKey() && (shouldUseHostedFetch(jobUrl) || sawBlock)) {
              const { html, provider } = await hostedFetch(jobUrl, 60000);
              console.warn(`html-fetcher: scrapling failed for ${jobUrl}, used hosted fetch (${provider})${sawBlock ? ' (block-triggered)' : ''}: ${scrErr.message}`);
              articleHtml = html;
            } else {
              throw scrErr;
            }
          }
        }
      }
    }

    const aiExtraction = await extractWithAiSelector(articleHtml, jobUrl, getDefaultTimezoneForLanguage(source.language));
    if (aiExtraction) {
      const { extraction, matchedSelector, sourceProfileId } = aiExtraction;
      const title = extraction.title || job.title;
      const excerpt = truncate(extraction.content, 500);
      return {
        source,
        url: jobUrl,
        title,
        publishedAt: extraction.publishedAt || job.published_at,
        rawExcerpt: excerpt,
        rawContent: extraction.content,
        contentHashSeed: title + excerpt,
        imageUrl: extraction.imageUrl,
        metadata: { extractor: 'ai-selector', matchedSelector, sourceProfileId },
      };
    }

    const $article = cheerio.load(articleHtml);

    const title = $article(config.titleSelector || 'h1').first().text().trim() ||
      getMetaContent($article, 'meta[property="og:title"]') ||
      $article('title').first().text().trim() ||
      job.title;
    if (!title) return null;

    let imageUrl: string | null = null;
    const imgSrc = $article(config.imageSelector || 'article img, .article img, .content img').first().attr('src') ||
      getMetaContent($article, 'meta[property="og:image"]') ||
      getMetaContent($article, 'meta[name="twitter:image"]');
    if (imgSrc) {
      try {
        imageUrl = normalizePublicHttpUrl(new URL(imgSrc, jobUrl).toString());
      } catch {}
    }

    let publishedAt: string | null = job.published_at;
    if (config.publishedAtSelector) {
      const dateText = $article(config.publishedAtSelector).attr('datetime') ||
        $article(config.publishedAtSelector).text().trim();
      if (dateText) {
        publishedAt = normalizeDate(dateText, { defaultTimezone: getDefaultTimezoneForLanguage(source.language) }) || publishedAt;
      }
    }
    if (!publishedAt) {
      const fallbackDate =
        $article('time[datetime]').first().attr('datetime') ||
        $article('meta[property="article:published_time"]').first().attr('content') ||
        $article('meta[name="pubdate"]').first().attr('content') ||
        $article('meta[name="parsely-pub-date"]').first().attr('content') ||
        $article('[itemprop="datePublished"]').first().attr('content') ||
        $article('[itemprop="datePublished"]').first().attr('datetime') ||
        '';
      if (fallbackDate) {
        publishedAt = normalizeDate(fallbackDate, { defaultTimezone: getDefaultTimezoneForLanguage(source.language) });
      }
    }

    if (config.removeSelectors) {
      for (const sel of config.removeSelectors) $article(sel).remove();
    }

    let content = $article(config.contentSelector || 'article').text().replace(/\s+/g, ' ').trim();

    // Structured-data fallback: soft-paywall sites (Wired/Condé Nast, many
    // Next.js sites) ship the full article in JSON-LD articleBody or a
    // __NEXT_DATA__/__PRELOADED_STATE__ blob even when CSS hides it. Prefer it
    // when longer than the selector scrape — no extra request, no paid credit.
    let structuredImageUrl: string | null = null;
    let structuredPublishedAt: string | null = null;
    const structured = extractStructuredArticle(articleHtml);
    if (structured) {
      if (structured.articleBody.length > content.length) content = structured.articleBody;
      if (structured.imageUrl) {
        try { structuredImageUrl = normalizePublicHttpUrl(new URL(structured.imageUrl, jobUrl).toString()); } catch {}
      }
      structuredPublishedAt = structured.datePublished;
    }
    if (!imageUrl && structuredImageUrl) imageUrl = structuredImageUrl;
    if (!publishedAt && structuredPublishedAt) {
      publishedAt = normalizeDate(structuredPublishedAt, { defaultTimezone: getDefaultTimezoneForLanguage(source.language) });
    }

    const excerpt = truncate(content, 500);

    return {
      source,
      url: jobUrl,
      title,
      publishedAt,
      rawExcerpt: excerpt,
      rawContent: content,
      contentHashSeed: title + excerpt,
      imageUrl,
    };
  },
  async fetch(source) {
    const result = { itemsFound: 0, itemsInserted: 0, errors: [] as string[], metadata: {} as Record<string, unknown> };

    try {
      const discovered = await htmlFetcher.discover!(source);
      result.itemsFound = discovered.length;

      // Layer 1: keyword promo filter
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
        try {
          const articleInput = await htmlFetcher.fetchArticle!({
            id: '',
            source_id: source.id,
            url: item.url,
            title: item.title,
            external_id: null,
            published_at: null,
            payload_json: null,
          }, source);
          if (!articleInput) continue;
          const inserted = await insertArticleIfNew({
            ...articleInput,
          });
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
