import * as cheerio from 'cheerio';
import { getOne, query } from '../../db/index.js';
import { generateId, normalizePublicHttpUrl } from '../../lib/utils.js';

const DEFAULT_REMOVE_SELECTORS = 'script, style, noscript, iframe, svg, form, button, input, textarea, nav, header, footer, aside';
const GENERIC_CONTENT_SELECTORS = new Set(['html', 'body', '*', 'main', 'article', '[role="main"]']);

export interface SelectorProfileInput {
  contentSelectors: string[];
  removeSelectors?: string[];
  titleSelector?: string | null;
  imageSelector?: string | null;
  publishedAtSelector?: string | null;
  minTextLength?: number;
}

export interface SourceProfileRow {
  id: string;
  domain: string;
  mode: string;
  content_selectors: string[];
  remove_selectors: string[];
  title_selector: string | null;
  image_selector: string | null;
  published_at_selector: string | null;
  min_text_length: number;
  success_count: number;
  failure_count: number;
  is_enabled: boolean;
  last_error: string | null;
}

export interface NormalizedSelectorProfile {
  contentSelectors: string[];
  removeSelectors: string[];
  titleSelector: string | null;
  imageSelector: string | null;
  publishedAtSelector: string | null;
  minTextLength: number;
}

export interface SelectorExtractionResult {
  title: string;
  content: string;
  imageUrl: string | null;
  publishedAt: string | null;
  matchedSelector: string | null;
}

function normalizeOptionalSelector(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const selector = value.trim();
  if (!selector || selector.length > 180) return null;
  return selector;
}

function normalizeSelectorArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const selectors: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'string') continue;
    const selector = item.trim();
    if (!selector || selector.length > 180 || seen.has(selector)) continue;
    selectors.push(selector);
    seen.add(selector);
    if (selectors.length >= maxItems) break;
  }

  return selectors;
}

export function getDomainFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  } catch {
    return null;
  }
}

export function normalizeSelectorProfile(raw: any): NormalizedSelectorProfile | null {
  const contentSelectors = normalizeSelectorArray(raw?.contentSelectors, 8)
    .filter((selector) => !GENERIC_CONTENT_SELECTORS.has(selector.toLowerCase()));
  if (contentSelectors.length === 0) return null;

  return {
    contentSelectors,
    removeSelectors: normalizeSelectorArray(raw?.removeSelectors, 20),
    titleSelector: normalizeOptionalSelector(raw?.titleSelector),
    imageSelector: normalizeOptionalSelector(raw?.imageSelector),
    publishedAtSelector: normalizeOptionalSelector(raw?.publishedAtSelector),
    minTextLength: Number.isInteger(raw?.minTextLength) && raw.minTextLength > 0 ? raw.minTextLength : 500,
  };
}

export function rowToSelectorProfile(row: SourceProfileRow): NormalizedSelectorProfile {
  return {
    contentSelectors: row.content_selectors || [],
    removeSelectors: row.remove_selectors || [],
    titleSelector: row.title_selector,
    imageSelector: row.image_selector,
    publishedAtSelector: row.published_at_selector,
    minTextLength: row.min_text_length || 500,
  };
}

export async function getSourceProfile(domain: string, mode = 'article'): Promise<SourceProfileRow | null> {
  return getOne<SourceProfileRow>(
    `SELECT id, domain, mode, content_selectors, remove_selectors, title_selector, image_selector,
            published_at_selector, min_text_length, success_count, failure_count, is_enabled, last_error
     FROM source_profiles
     WHERE domain = $1 AND mode = $2 AND is_enabled = true
     LIMIT 1`,
    [domain, mode]
  );
}

export async function saveSourceProfile(domain: string, profile: NormalizedSelectorProfile, mode = 'article'): Promise<SourceProfileRow> {
  return (await getOne<SourceProfileRow>(
    `INSERT INTO source_profiles (id, domain, mode, content_selectors, remove_selectors, title_selector,
                                  image_selector, published_at_selector, min_text_length, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (domain, mode) DO UPDATE SET
       content_selectors = EXCLUDED.content_selectors,
       remove_selectors = EXCLUDED.remove_selectors,
       title_selector = EXCLUDED.title_selector,
       image_selector = EXCLUDED.image_selector,
       published_at_selector = EXCLUDED.published_at_selector,
       min_text_length = EXCLUDED.min_text_length,
       is_enabled = true,
       last_error = NULL,
       last_verified_at = NOW()
     RETURNING id, domain, mode, content_selectors, remove_selectors, title_selector, image_selector,
               published_at_selector, min_text_length, success_count, failure_count, is_enabled, last_error`,
    [
      generateId('spf'),
      domain,
      mode,
      profile.contentSelectors,
      profile.removeSelectors,
      profile.titleSelector,
      profile.imageSelector,
      profile.publishedAtSelector,
      profile.minTextLength,
    ]
  ))!;
}

export async function recordProfileSuccess(id: string): Promise<void> {
  await query(
    `UPDATE source_profiles
     SET success_count = success_count + 1,
         last_error = NULL,
         last_verified_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

export async function recordProfileFailure(id: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err || 'Unknown selector profile error');
  await query(
    `UPDATE source_profiles
     SET failure_count = failure_count + 1,
         last_error = $2
     WHERE id = $1`,
    [id, message.substring(0, 500)]
  );
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getMetaContent($: cheerio.CheerioAPI, selector: string): string {
  return $(selector).first().attr('content')?.trim() || '';
}

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

function resolveImageUrl(rawUrl: string | undefined, pageUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    return normalizePublicHttpUrl(new URL(rawUrl, pageUrl).toString());
  } catch {
    return null;
  }
}

export function isExtractionUsable(content: string, minLength = 500): boolean {
  const text = cleanText(content);
  if (text.length < minLength) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 80) return false;
  const sentenceChunks = text.split(/[.!?。！？]\s+/).filter((part) => part.trim().length > 30).length;
  return sentenceChunks >= 2 || text.length >= minLength * 2;
}

export function extractWithSelectorProfile(html: string, pageUrl: string, profile: NormalizedSelectorProfile, defaultTimezone: string = 'Z'): SelectorExtractionResult {
  const $ = cheerio.load(html);
  $(DEFAULT_REMOVE_SELECTORS).remove();
  for (const selector of profile.removeSelectors) $(selector).remove();

  let content = '';
  let matchedSelector: string | null = null;
  for (const selector of profile.contentSelectors) {
    const text = cleanText($(selector).first().text());
    if (text.length > content.length) {
      content = text;
      matchedSelector = selector;
    }
  }

  const title = cleanText(
    (profile.titleSelector ? $(profile.titleSelector).first().text() : '') ||
    $('h1').first().text() ||
    getMetaContent($, 'meta[property="og:title"]') ||
    $('title').first().text()
  );

  const profileImage = profile.imageSelector ? $(profile.imageSelector).first().attr('src') : undefined;
  const imageUrl = resolveImageUrl(
    profileImage || getMetaContent($, 'meta[property="og:image"]') || getMetaContent($, 'meta[name="twitter:image"]'),
    pageUrl
  );

  const publishedText = profile.publishedAtSelector
    ? ($(profile.publishedAtSelector).first().attr('datetime') || $(profile.publishedAtSelector).first().text().trim())
    : '';
  const publishedAt = normalizeDate(
    publishedText ||
    $('time[datetime]').first().attr('datetime') ||
    getMetaContent($, 'meta[property="article:published_time"]') ||
    getMetaContent($, 'meta[name="pubdate"]') ||
    getMetaContent($, 'meta[name="parsely-pub-date"]') ||
    $('[itemprop="datePublished"]').first().attr('content') ||
    $('[itemprop="datePublished"]').first().attr('datetime') ||
    extractJsonLdDate($) ||
    null,
    defaultTimezone
  );

  return { title, content, imageUrl, publishedAt, matchedSelector };
}
