// Firecrawl hosted fallback — the last-resort fetch layer for pages that defeat
// native fetch, the Cloudflare Worker proxy, and Scrapling stealth (DataDome /
// Cloudflare "Just a moment" interstitials). Firecrawl runs its own residential
// proxy pool + real-browser rendering, so it returns clean HTML where the
// self-hosted stack only gets a challenge page.
//
// Two ways a fetch reaches Firecrawl:
//   1. Proactive allowlist — hosts in FIRECRAWL_DOMAINS always try Firecrawl
//      (used for known-hard sites like Reuters/Bloomberg behind DataDome).
//   2. Block-triggered — ANY host that fails every free layer *because it was
//      blocked* (Cloudflare/anti-bot) auto-escalates to Firecrawl. Genuinely
//      short or 404 pages do NOT, so credits aren't wasted on real content.
//
// A rolling 24h credit cap (FIRECRAWL_MAX_PER_DAY) bounds spend so a burst of
// newly-blocked sources can never drain the credit balance in one run.
//
// Env:
//   FIRECRAWL_API_KEY=fc-...
//   FIRECRAWL_DOMAINS=reuters.com,bloomberg.com   # proactive allowlist (optional)
//   FIRECRAWL_API_URL=https://api.firecrawl.dev   # override for self-hosted
//   FIRECRAWL_MAX_PER_DAY=300                      # rolling 24h request cap

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const FIRECRAWL_API_URL = (process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/+$/, '');
const FIRECRAWL_DOMAINS = (process.env.FIRECRAWL_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const FIRECRAWL_MAX_PER_DAY = parsePositiveInt(process.env.FIRECRAWL_MAX_PER_DAY, 300);

// Rolling 24h budget. In-memory only: a process restart resets it, which is fine
// — the goal is a guardrail against runaway bursts, not exact accounting.
let creditWindowStart = Date.now();
let creditsUsed = 0;

function withinCreditBudget(): boolean {
  const now = Date.now();
  if (now - creditWindowStart > 24 * 60 * 60 * 1000) {
    creditWindowStart = now;
    creditsUsed = 0;
  }
  return creditsUsed < FIRECRAWL_MAX_PER_DAY;
}

export function firecrawlCreditsUsed(): number {
  return creditsUsed;
}

export class FirecrawlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirecrawlUnavailableError';
  }
}

// True when a key is present — enough for block-triggered escalation on any host.
export function hasFirecrawlKey(): boolean {
  return Boolean(FIRECRAWL_API_KEY);
}

// True when this host is on the proactive allowlist (skip straight to Firecrawl).
export function shouldUseFirecrawl(targetUrl: string): boolean {
  if (!FIRECRAWL_API_KEY || FIRECRAWL_DOMAINS.length === 0) return false;
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
  if (!FIRECRAWL_API_KEY) {
    throw new FirecrawlUnavailableError('FIRECRAWL_API_KEY not configured');
  }
  if (!withinCreditBudget()) {
    throw new FirecrawlUnavailableError(`Firecrawl daily cap reached (${FIRECRAWL_MAX_PER_DAY}/24h)`);
  }

  creditsUsed++;

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
