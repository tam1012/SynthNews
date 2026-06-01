// Firecrawl hosted fallback — the last-resort fetch layer for domains that
// defeat native fetch, the Cloudflare Worker proxy, and Scrapling stealth
// (e.g. Reuters/Bloomberg behind DataDome). Firecrawl runs its own residential
// proxy pool + real-browser rendering, so it can return clean HTML where the
// self-hosted stack gets a 401/challenge.
//
// Credit-gated by design: only domains in FIRECRAWL_DOMAINS are routed here, so
// a limited free-tier credit budget is never spent on sites that already work.
//
// Env:
//   FIRECRAWL_API_KEY=fc-...
//   FIRECRAWL_DOMAINS=reuters.com,bloomberg.com   # allowlist; empty = disabled
//   FIRECRAWL_API_URL=https://api.firecrawl.dev   # override for self-hosted

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const FIRECRAWL_API_URL = (process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/+$/, '');
const FIRECRAWL_DOMAINS = (process.env.FIRECRAWL_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export class FirecrawlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirecrawlUnavailableError';
  }
}

export function isFirecrawlConfigured(): boolean {
  return Boolean(FIRECRAWL_API_KEY && FIRECRAWL_DOMAINS.length > 0);
}

export function shouldUseFirecrawl(targetUrl: string): boolean {
  if (!isFirecrawlConfigured()) return false;
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    return FIRECRAWL_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

interface FirecrawlScrapeResponse {
  success?: boolean;
  error?: string;
  data?: {
    html?: string;
    rawHtml?: string;
    markdown?: string;
    metadata?: { statusCode?: number };
  };
}

// Returns rendered HTML for the page, or throws FirecrawlUnavailableError.
export async function firecrawlFetch(url: string, timeoutMs = 60000): Promise<string> {
  if (!isFirecrawlConfigured()) {
    throw new FirecrawlUnavailableError('FIRECRAWL_API_KEY or FIRECRAWL_DOMAINS not configured');
  }

  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_API_URL}/v1/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        formats: ['rawHtml'],
        onlyMainContent: false,
        timeout: timeoutMs,
      }),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
  } catch (err: any) {
    throw new FirecrawlUnavailableError(`Firecrawl unreachable: ${err.message}`);
  }

  if (res.status === 402) {
    throw new FirecrawlUnavailableError('Firecrawl out of credits (402)');
  }
  if (res.status === 429) {
    throw new FirecrawlUnavailableError('Firecrawl rate limited (429)');
  }
  if (!res.ok) {
    throw new FirecrawlUnavailableError(`Firecrawl returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as FirecrawlScrapeResponse;
  if (!data.success) {
    throw new Error(`Firecrawl scrape failed: ${data.error || 'unknown error'}`);
  }

  const html = data.data?.rawHtml || data.data?.html || '';
  if (!html) {
    throw new Error('Firecrawl returned empty HTML');
  }
  return html;
}
