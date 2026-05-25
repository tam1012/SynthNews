type ArticleMetaInput = {
  id: string;
  title?: string | null;
  translated_title?: string | null; // Added
  tldr?: string | null;
  summary_text?: string | null;
  raw_excerpt?: string | null;
  image_url?: string | null;
};

const DEFAULT_DESCRIPTION = 'SynthNews - tong hop tin tuc ca nhan hoa voi AI.';

function stripPreviewMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : maxLength).trim()}...`;
}

function pickDescription(article: ArticleMetaInput): string {
  const text = article.tldr || article.summary_text || article.raw_excerpt || '';
  const preview = stripPreviewMarkup(text);
  return preview ? truncate(preview, 220) : DEFAULT_DESCRIPTION;
}

function normalizeImageUrl(imageUrl: string | null | undefined, articleUrl: string): string {
  const trimmed = String(imageUrl || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith('/')) return '';

  const origin = articleUrl.match(/^https?:\/\/[^/]+/i)?.[0];
  return origin ? `${origin}${trimmed}` : '';
}

export function buildArticleMeta({
  article,
  articleUrl,
}: {
  article: ArticleMetaInput;
  articleUrl: string;
}): string {
  const articleTitle = article.translated_title || article.title || 'SynthNews';
  const title = stripPreviewMarkup(articleTitle);
  const description = pickDescription(article);
  const rawImageUrl = normalizeImageUrl(article.image_url, articleUrl);
  // Route through image proxy for optimized WebP delivery
  const siteOrigin = articleUrl.match(/^https?:\/\/[^/]+/i)?.[0] || '';
  const imageUrl = rawImageUrl
    ? `${siteOrigin}/api/img?url=${encodeURIComponent(rawImageUrl)}&p=og`
    : '';
  const cardType = imageUrl ? 'summary_large_image' : 'summary';

  return [
    `<title>${escapeHtml(title)} | SynthNews</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="SynthNews" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(articleUrl)}" />`,
    imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}" />` : '',
    `<meta name="twitter:card" content="${cardType}" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />` : '',
  ].filter(Boolean).join('\n  ');
}

export function injectArticleMeta(indexHtml: string, meta: string): string {
  const withoutGeneratedMeta = indexHtml
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/i, '')
    .replace(/<meta\s+(?:name|property)=["'](?:og:[^"']+|twitter:[^"']+)["'][^>]*>\s*/gi, '');

  return withoutGeneratedMeta.replace('</head>', `  ${meta}\n</head>`);
}
