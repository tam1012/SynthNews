const READ_ARTICLES_STORAGE_KEY = 'read_articles';
const FEED_PREVIEW_MAX_CHARS = 180;
const DETAIL_IMAGE_MIN_HEIGHT = 120;

const DISPLAY_TIMEZONE = 'Asia/Ho_Chi_Minh';

export function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: DISPLAY_TIMEZONE });
}

export function formatDateHeading(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: DISPLAY_TIMEZONE });
}

export function extractSourceLabel(article: any): string {
  const name: string = article.source_name || '';
  // Reddit: extract subreddit from title like [r/technology]
  const m = article.title?.match(/^\[r\/([^\]]+)\]/);
  if (m) return `R/${m[1].toUpperCase()}`;
  // Otherwise shorten source name
  return name.replace(/ - .*$/, '').replace(/ RSS.*$/, '').toUpperCase();
}

export function cleanTitle(title: string): string {
  return title.replace(/^\[r\/[^\]]+\]\s*/, '');
}

export function stripPreviewMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeShortPreview(text: string, maxChars = FEED_PREVIEW_MAX_CHARS): string {
  const cleaned = stripPreviewMarkup(text);
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;

  const firstSentence = cleaned.match(/^(.{70,180}?[.!?])\s/)?.[1];
  if (firstSentence) return firstSentence.trim();

  const cut = cleaned.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : maxChars).trim()}…`;
}

export function buildFeedPreview(article: any): string {
  if (article.tldr && typeof article.tldr === 'string') {
    const preview = stripPreviewMarkup(article.tldr);
    if (preview.length >= 30) return preview;
  }

  const candidates = [
    article.raw_excerpt,
    article.summary_text,
    article.raw_content,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const preview = makeShortPreview(candidate);
    if (preview.length >= 30) return preview;
  }

  return '';
}

export function isArticleFresh(article: any, nowMs = Date.now(), maxAgeHours = 6): boolean {
  const timestamp = article?.published_at || article?.created_at;
  if (!timestamp) return false;

  const articleMs = new Date(timestamp).getTime();
  if (!Number.isFinite(articleMs)) return false;

  const ageMs = nowMs - articleMs;
  return ageMs >= 0 && ageMs <= maxAgeHours * 60 * 60 * 1000;
}

export function getVisibleArticleTags(article: any, limit = 2): string[] {
  if (!Array.isArray(article?.tags)) return [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const rawTag of article.tags) {
    if (typeof rawTag !== 'string') continue;
    const tag = rawTag.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= limit) break;
  }
  return tags;
}

/* ── image proxy helper ── */
type ImgPreset = 'thumb' | 'detail' | 'og';
export function proxyImgUrl(rawUrl: string | null | undefined, preset: ImgPreset = 'detail', baseUrl?: string | null): string {
  const url = String(rawUrl || '').trim();
  if (!url) return '';

  let sourceUrl = url;
  if (url.startsWith('/')) {
    try {
      sourceUrl = new URL(url, baseUrl || window.location.origin).toString();
    } catch {
      return '';
    }
  }

  return `/api/img?url=${encodeURIComponent(sourceUrl)}&p=${preset}`;
}

export function loadReadArticles(): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(READ_ARTICLES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveReadArticles(ids: string[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(READ_ARTICLES_STORAGE_KEY, JSON.stringify(ids.slice(0, 500)));
}

export function hideBrokenImage(img: HTMLImageElement) {
  img.style.display = 'none';
}

export function hideTinyImage(img: HTMLImageElement) {
  if (img.naturalHeight > 0 && img.naturalHeight < DETAIL_IMAGE_MIN_HEIGHT) hideBrokenImage(img);
}

/* ── main component ── */

export type FeedTab = 'all' | 'news' | 'tech' | 'voz' | 'reddit';

export function classifyArticle(article: any): FeedTab {
  const name = (article.source_name || '').toLowerCase();
  const url = (article.url || '').toLowerCase();
  const title = (article.title || '').toLowerCase();
  if (name.includes('reddit') || url.includes('reddit.com') || title.startsWith('[r/')) return 'reddit';
  if (name.includes('voz') || url.includes('voz.vn')) return 'voz';
  return 'all';
}

/** Estimate reading time in minutes from article text content */
export function estimateReadingTime(article: any): string {
  const text = article.summary_text || article.raw_content || article.raw_excerpt || '';
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  // Vietnamese averages ~200 words/min for reading
  const minutes = Math.max(1, Math.round(wordCount / 200));
  return `${minutes} phút đọc`;
}

