// Hosted fetch orchestrator — the last-resort fetch layer for pages that defeat
// native fetch, the Cloudflare Worker proxy, and Scrapling stealth (DataDome /
// Cloudflare "Just a moment" interstitials). Each provider runs its own
// residential proxy pool + real-browser rendering, so they return clean HTML
// where the self-hosted stack only gets a challenge page.
//
// Providers are tried in order, most-abundant free credits first:
//   1. ScrapingAnt  (~10k credits/month free)
//   2. Scrape.do    (~1k credits/month free)
//   3. Firecrawl    (~1k credits/month free, strongest on DataDome e.g. Reuters)
// A provider is skipped when it has no key or has hit its rolling-24h cap; on
// error/429/empty it falls through to the next. The first usable HTML wins.
//
// Two ways a fetch reaches this layer (see callers):
//   - Proactive allowlist (HOSTED_FETCH_DOMAINS / legacy FIRECRAWL_DOMAINS):
//     known-hard hosts skip straight here.
//   - Block-triggered: ANY host that fails every free layer *because it was
//     blocked* (4xx / challenge page) auto-escalates. Genuinely short or 404
//     pages do NOT, so credits aren't spent on real thin content.
//
// Env (all optional — a provider with no key is simply skipped):
//   SCRAPINGANT_API_KEY=...        SCRAPINGANT_MAX_PER_DAY=300
//   SCRAPEDO_API_KEY=...           SCRAPEDO_MAX_PER_DAY=30
//   FIRECRAWL_API_KEY=fc-...       FIRECRAWL_MAX_PER_DAY=30
//   FIRECRAWL_API_URL=https://api.firecrawl.dev
//   HOSTED_FETCH_DOMAINS=reuters.com,bloomberg.com   (legacy: FIRECRAWL_DOMAINS)

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PROACTIVE_DOMAINS = (process.env.HOSTED_FETCH_DOMAINS || process.env.FIRECRAWL_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export class HostedFetchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedFetchUnavailableError';
  }
}

// A page returned by a provider that is still a challenge/empty shell — treat as
// failure so the chain falls through to the next provider.
function looksBlockedOrEmpty(html: string): boolean {
  if (!html || html.length < 500) return true;
  const lowered = html.slice(0, 4000).toLowerCase();
  return lowered.includes('just a moment...') ||
    lowered.includes('challenges.cloudflare.com') ||
    lowered.includes('enable javascript and cookies') ||
    lowered.includes('cf-browser-verification') ||
    // DataDome / PerimeterX challenge shells — ScrapingAnt & Scrape.do sometimes
    // return these for Reuters/Bloomberg, so fall through to the next provider
    // (Firecrawl is the strongest on DataDome).
    lowered.includes('captcha-delivery.com') ||
    lowered.includes('datadome') ||
    lowered.includes('px-captcha') ||
    lowered.includes('perimeterx');
}

interface HostedProvider {
  name: string;
  hasKey(): boolean;
  /** Throws on failure; returns raw HTML on success. */
  fetch(url: string, timeoutMs: number): Promise<string>;
  cap: number;
  // Rolling 24h budget. In-memory only: a restart resets it, which is fine — the
  // goal is a guardrail against runaway bursts, not exact accounting.
  windowStart: number;
  used: number;
}

function withinBudget(p: HostedProvider): boolean {
  const now = Date.now();
  if (now - p.windowStart > 24 * 60 * 60 * 1000) {
    p.windowStart = now;
    p.used = 0;
  }
  return p.used < p.cap;
}

// ── Provider: ScrapingAnt ──────────────────────────────────────────────────
const SCRAPINGANT_API_KEY = process.env.SCRAPINGANT_API_KEY || '';
async function scrapingAntFetch(url: string, timeoutMs: number): Promise<string> {
  const endpoint = `https://api.scrapingant.com/v2/general?url=${encodeURIComponent(url)}&x-api-key=${SCRAPINGANT_API_KEY}&browser=true`;
  let res: Response;
  try {
    res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs + 5000) });
  } catch (err: any) {
    throw new HostedFetchUnavailableError(`ScrapingAnt unreachable: ${err.message}`);
  }
  if (res.status === 429) throw new HostedFetchUnavailableError('ScrapingAnt rate limited (429)');
  if (!res.ok) throw new HostedFetchUnavailableError(`ScrapingAnt HTTP ${res.status}`);
  return res.text();
}

// ── Provider: Scrape.do ────────────────────────────────────────────────────
const SCRAPEDO_API_KEY = process.env.SCRAPEDO_API_KEY || '';
async function scrapeDoFetch(url: string, timeoutMs: number): Promise<string> {
  const endpoint = `https://api.scrape.do/?token=${SCRAPEDO_API_KEY}&url=${encodeURIComponent(url)}&render=true`;
  let res: Response;
  try {
    res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs + 5000) });
  } catch (err: any) {
    throw new HostedFetchUnavailableError(`Scrape.do unreachable: ${err.message}`);
  }
  if (res.status === 429) throw new HostedFetchUnavailableError('Scrape.do rate limited (429)');
  if (!res.ok) throw new HostedFetchUnavailableError(`Scrape.do HTTP ${res.status}`);
  return res.text();
}

// ── Provider: Firecrawl ────────────────────────────────────────────────────
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const FIRECRAWL_API_URL = (process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/+$/, '');
async function firecrawlFetchRaw(url: string, timeoutMs: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_API_URL}/v1/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ['rawHtml'], onlyMainContent: false, timeout: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
  } catch (err: any) {
    throw new HostedFetchUnavailableError(`Firecrawl unreachable: ${err.message}`);
  }
  if (res.status === 402) throw new HostedFetchUnavailableError('Firecrawl out of credits (402)');
  if (res.status === 429) throw new HostedFetchUnavailableError('Firecrawl rate limited (429)');
  if (!res.ok) throw new HostedFetchUnavailableError(`Firecrawl HTTP ${res.status}`);
  const data = (await res.json()) as { success?: boolean; error?: string; data?: { html?: string; rawHtml?: string } };
  if (!data.success) throw new HostedFetchUnavailableError(`Firecrawl scrape failed: ${data.error || 'unknown error'}`);
  return data.data?.rawHtml || data.data?.html || '';
}

const PROVIDERS: HostedProvider[] = [
  {
    name: 'scrapingant',
    hasKey: () => Boolean(SCRAPINGANT_API_KEY),
    fetch: scrapingAntFetch,
    cap: parsePositiveInt(process.env.SCRAPINGANT_MAX_PER_DAY, 300),
    windowStart: Date.now(),
    used: 0,
  },
  {
    name: 'scrapedo',
    hasKey: () => Boolean(SCRAPEDO_API_KEY),
    fetch: scrapeDoFetch,
    cap: parsePositiveInt(process.env.SCRAPEDO_MAX_PER_DAY, 30),
    windowStart: Date.now(),
    used: 0,
  },
  {
    name: 'firecrawl',
    hasKey: () => Boolean(FIRECRAWL_API_KEY),
    fetch: firecrawlFetchRaw,
    cap: parsePositiveInt(process.env.FIRECRAWL_MAX_PER_DAY, 30),
    windowStart: Date.now(),
    used: 0,
  },
];

// True when at least one provider has a key — enough for block-triggered escalation.
export function hasHostedFetchKey(): boolean {
  return PROVIDERS.some((p) => p.hasKey());
}

// True when this host is on the proactive allowlist (skip straight to hosted fetch).
export function shouldUseHostedFetch(targetUrl: string): boolean {
  if (!hasHostedFetchKey() || PROACTIVE_DOMAINS.length === 0) return false;
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    return PROACTIVE_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// Returns {html, provider} for the first provider that yields usable HTML, or
// throws HostedFetchUnavailableError when every provider is unavailable/failed.
export async function hostedFetch(url: string, timeoutMs = 60000): Promise<{ html: string; provider: string }> {
  const errors: string[] = [];
  let anyAttempted = false;

  for (const provider of PROVIDERS) {
    if (!provider.hasKey()) continue;
    if (!withinBudget(provider)) {
      errors.push(`${provider.name}: daily cap reached (${provider.cap}/24h)`);
      continue;
    }

    anyAttempted = true;
    provider.used++;
    try {
      const html = await provider.fetch(url, timeoutMs);
      if (looksBlockedOrEmpty(html)) {
        errors.push(`${provider.name}: returned blocked/empty page`);
        continue;
      }
      return { html, provider: provider.name };
    } catch (err: any) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  if (!anyAttempted) {
    throw new HostedFetchUnavailableError('No hosted fetch provider available (no key or all capped)');
  }
  throw new HostedFetchUnavailableError(`All hosted providers failed: ${errors.join('; ')}`);
}
