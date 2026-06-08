import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Structured-data article extraction
// ---------------------------------------------------------------------------
// Many "soft paywall" sites (Condé Nast/Wired, plenty of Next.js news sites)
// ship the FULL article text inside the page even when CSS hides it behind a
// subscribe overlay. The cleanest copy lives in:
//   1. <script type="application/ld+json"> as NewsArticle.articleBody
//   2. embedded JSON state blobs (__NEXT_DATA__, __PRELOADED_STATE__, …) under
//      an "articleBody" / "body" key
// Pulling that text needs no browser, no proxy, and no paid credit — it's just
// parsing JSON that's already in the HTML we fetched. This is the same trick the
// Bypass-Paywalls-Clean extension uses for these publishers.

export interface StructuredArticle {
  articleBody: string;
  title: string | null;
  datePublished: string | null;
  imageUrl: string | null;
}

export interface StructuredVideo {
  title: string | null;
  description: string | null;
  transcript: string;
  datePublished: string | null;
  imageUrl: string | null;
  captionUrl: string | null;
}

// articleBody in JSON-LD is sometimes HTML, sometimes an array of paragraph
// strings, sometimes plain text. Normalize all shapes to clean plain text.
function normalizeBody(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    // Strip tags if the body is HTML; cheerio.load on plain text is a no-op.
    if (trimmed.includes('<') && trimmed.includes('>')) {
      return cheerio.load(`<div>${trimmed}</div>`)('div').text().replace(/\s+/g, ' ').trim();
    }
    return trimmed.replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeBody(v)).filter(Boolean).join('\n\n');
  }
  return '';
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function imageFrom(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return imageFrom(value[0]);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return firstString(obj.url, obj.contentUrl);
  }
  return null;
}

const ARTICLE_LD_TYPES = new Set([
  'article',
  'newsarticle',
  'reportagenewsarticle',
  'report',
  'blogposting',
  'liveblogposting',
  'techarticle',
  'scholarlyarticle',
  'backgroundnewsarticle',
  'opinionnewsarticle',
  'analysisnewsarticle',
  'reviewnewsarticle',
]);

const VIDEO_LD_TYPES = new Set([
  'videoobject',
]);

function ldTypeMatches(type: unknown): boolean {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && ARTICLE_LD_TYPES.has(t.toLowerCase()));
}

function videoLdTypeMatches(type: unknown): boolean {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && VIDEO_LD_TYPES.has(t.toLowerCase()));
}

// Walk a parsed JSON-LD value (object, array, or @graph wrapper) and collect any
// node that carries an articleBody.
function collectLdArticles(node: unknown, out: Record<string, unknown>[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectLdArticles(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj['@graph'])) collectLdArticles(obj['@graph'], out);
  if (typeof obj.articleBody === 'string' || Array.isArray(obj.articleBody)) {
    out.push(obj);
  }
}

function collectLdVideos(node: unknown, out: Record<string, unknown>[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectLdVideos(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj['@graph'])) collectLdVideos(obj['@graph'], out);
  if (videoLdTypeMatches(obj['@type'])) out.push(obj);
}

function extractFromJsonLd($: cheerio.CheerioAPI): StructuredArticle | null {
  const scripts = $('script[type="application/ld+json"]');
  const articles: Record<string, unknown>[] = [];

  for (let i = 0; i < scripts.length; i++) {
    const raw = $(scripts[i]).contents().text() || $(scripts[i]).html();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    collectLdArticles(parsed, articles);
  }

  if (articles.length === 0) return null;

  // Prefer the node whose normalized body is longest (the real article, not a
  // related-item stub) and, all else equal, a recognized Article @type.
  let best: { article: StructuredArticle; length: number } | null = null;
  for (const node of articles) {
    const body = normalizeBody(node.articleBody);
    if (!body) continue;
    const typeBonus = ldTypeMatches(node['@type']) ? 1 : 0;
    const score = body.length + typeBonus;
    if (best && score <= best.length) continue;
    best = {
      length: score,
      article: {
        articleBody: body,
        title: firstString(node.headline, node.name),
        datePublished: firstString(node.datePublished, node.dateCreated, node.dateModified),
        imageUrl: imageFrom(node.image),
      },
    };
  }

  return best?.article || null;
}

function extractVideoNodesFromJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const scripts = $('script[type="application/ld+json"]');
  const videos: Record<string, unknown>[] = [];

  for (let i = 0; i < scripts.length; i++) {
    const raw = $(scripts[i]).contents().text() || $(scripts[i]).html();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    collectLdVideos(parsed, videos);
  }

  return videos;
}

function captionUrlFrom(value: unknown): string | null {
  const captions = Array.isArray(value) ? value : (value ? [value] : []);
  for (const caption of captions) {
    if (typeof caption === 'string' && caption.trim()) return caption.trim();
    if (!caption || typeof caption !== 'object') continue;
    const obj = caption as Record<string, unknown>;
    const url = firstString(obj.url, obj.contentUrl);
    if (url) return url;
  }
  return null;
}

function cleanCaptionText(text: string): string {
  return text
    .replace(/^\uFEFF?WEBVTT[^\n\r]*(?:\r?\n)+/i, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/^\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[.,]\d{3}.*$/gm, '')
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^NOTE\b/i.test(line) && !/^STYLE\b/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Recursively hunt for an article-body string inside an arbitrary parsed JSON
// blob (Next.js __NEXT_DATA__, Condé Nast __PRELOADED_STATE__, Apollo cache, …).
// Only the canonical "articleBody"/"bodyText" keys are honored: a bare "body"
// key is often a rich-text AST (nodes typed "div"/"p"/"span"), and flattening it
// injects tag-name tokens into the text. Picks the longest qualifying string.
function deepFindArticleBody(node: unknown, depth = 0): string {
  if (depth > 12 || !node || typeof node !== 'object') return '';
  let best = '';
  const consider = (candidate: unknown) => {
    const text = normalizeBody(candidate);
    if (text.length > best.length) best = text;
  };

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindArticleBody(item, depth + 1);
      if (found.length > best.length) best = found;
    }
    return best;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === 'articleBody' || key === 'bodyText') &&
        (typeof value === 'string' || Array.isArray(value))) {
      consider(value);
    } else if (value && typeof value === 'object') {
      const found = deepFindArticleBody(value, depth + 1);
      if (found.length > best.length) best = found;
    }
  }
  return best;
}

const STATE_BLOB_PATTERNS = [
  /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
  /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
  /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
];

function extractFromStateBlob(html: string): string {
  for (const pattern of STATE_BLOB_PATTERNS) {
    const match = html.match(pattern);
    if (!match || !match[1]) continue;
    try {
      const parsed = JSON.parse(match[1].trim());
      const body = deepFindArticleBody(parsed);
      if (body) return body;
    } catch {
      // Blob isn't valid standalone JSON (trailing assignments etc.) — skip.
    }
  }
  return '';
}

// Returns the best structured-data article found in the HTML, or null. Callers
// compare its body length against their selector/readability extraction and keep
// whichever is longer.
export function extractStructuredArticle(html: string): StructuredArticle | null {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  const fromLd = extractFromJsonLd($);
  const fromState = extractFromStateBlob(html);

  if (!fromLd && !fromState) return null;

  // Keep whichever body is longer; carry metadata from the JSON-LD node when present.
  if (fromLd && fromLd.articleBody.length >= fromState.length) return fromLd;

  return {
    articleBody: fromState,
    title: fromLd?.title || null,
    datePublished: fromLd?.datePublished || null,
    imageUrl: fromLd?.imageUrl || null,
  };
}

export async function extractStructuredVideo(
  html: string,
  fetchCaption: (url: string) => Promise<string> = async (url: string) => {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Caption fetch status ${response.status}`);
    return response.text();
  },
): Promise<StructuredVideo | null> {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  const videos = extractVideoNodesFromJsonLd($);
  for (const video of videos) {
    const captionUrl = captionUrlFrom(video.caption);
    if (!captionUrl) continue;
    try {
      const captionText = await fetchCaption(captionUrl);
      const transcript = cleanCaptionText(captionText);
      if (!transcript) continue;
      return {
        title: firstString(video.headline, video.name, video.alternativeHeadline),
        description: firstString(video.description),
        transcript,
        datePublished: firstString(video.uploadDate, video.datePublished, video.dateCreated, video.dateModified),
        imageUrl: imageFrom(video.thumbnailUrl) || imageFrom(video.image),
        captionUrl,
      };
    } catch {
      continue;
    }
  }

  return null;
}
