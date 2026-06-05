import { playwrightFetch, type PlaywrightFetchOptions } from './http-utils.js';

const SCRAPLING_SERVICE_URL = process.env.SCRAPLING_SERVICE_URL || '';
const SCRAPLING_SERVICE_TOKEN = process.env.SCRAPLING_SERVICE_TOKEN || '';

// Residential/rotating proxy applied ONLY to hard-blocked domains (Reuters,
// Bloomberg, ...) so we don't burn paid proxy bandwidth on sites that work from
// the datacenter IP. SCRAPLING_PROXY_URL is the proxy connection string
// (http://user:pass@host:port); SCRAPLING_PROXY_DOMAINS is a comma-separated
// allowlist of hostnames that should route through it.
const SCRAPLING_PROXY_URL = process.env.SCRAPLING_PROXY_URL || '';
const SCRAPLING_PROXY_DOMAINS = (process.env.SCRAPLING_PROXY_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export function getScraplingProxyForUrl(targetUrl: string): string | undefined {
  if (!SCRAPLING_PROXY_URL || SCRAPLING_PROXY_DOMAINS.length === 0) return undefined;
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    const matched = SCRAPLING_PROXY_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
    return matched ? SCRAPLING_PROXY_URL : undefined;
  } catch {
    return undefined;
  }
}

export class ScraplingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScraplingUnavailableError';
  }
}

export interface ScraplingFetchOptions {
  mode?: 'stealth' | 'fast';
  rawText?: boolean;
  waitSelector?: string;
  waitMs?: number;
  blockResources?: boolean;
  timeoutMs?: number;
  solveCloudflare?: boolean;
  /** Override proxy. When omitted, a domain-gated residential proxy is auto-applied. */
  proxy?: string;
}

interface ScraplingResponse {
  ok: boolean;
  html?: string;
  error?: string;
  status_code: number;
  elapsed_ms: number;
}

export async function scraplingFetch(url: string, options: ScraplingFetchOptions = {}): Promise<string> {
  if (!SCRAPLING_SERVICE_URL) {
    throw new ScraplingUnavailableError('SCRAPLING_SERVICE_URL not configured');
  }
  if (process.env.NODE_ENV === 'production' && !SCRAPLING_SERVICE_TOKEN) {
    throw new Error('SCRAPLING_SERVICE_TOKEN not configured');
  }

  const timeout = options.timeoutMs || 60000;
  const autoProxy = getScraplingProxyForUrl(url);
  const proxy = options.proxy ?? autoProxy;

  // Domains that only reach the proxy via auto-gating (Bloomberg, ...) sit behind
  // a PerimeterX bot wall that clears simply by loading the page in a real browser
  // over a residential IP — there is NO Cloudflare challenge to solve. The default
  // fetch profile (block_resources=true, short timeout) starves that: blocking
  // resources stops the page JS, and a full residential render runs ~60s, past the
  // 60s default. So when the proxy is auto-applied, force the heavy profile: full
  // resources + a long timeout.
  //
  // Critically, do NOT enable solve_cloudflare here. Bloomberg is PerimeterX, not
  // Cloudflare; turning it on makes Scrapling hunt for a CF challenge that never
  // appears, looping "No Cloudflare challenge found" until it times out at 120s —
  // which then forces a needless escalation to the paid hosted-fetch layer. With
  // solve off, the same fetch returns the full article in ~60s, every time.
  const isHardProxiedDomain = Boolean(autoProxy) && !options.proxy;
  const solveCloudflare = options.solveCloudflare ?? false;
  const blockResources = isHardProxiedDomain ? false : (options.blockResources ?? true);
  const waitMs = isHardProxiedDomain ? Math.max(options.waitMs ?? 0, 3000) : options.waitMs;
  const effectiveTimeout = isHardProxiedDomain ? Math.max(timeout, 120000) : timeout;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (SCRAPLING_SERVICE_TOKEN) headers['X-Sidecar-Token'] = SCRAPLING_SERVICE_TOKEN;

  let res: Response;
  try {
    res = await fetch(`${SCRAPLING_SERVICE_URL}/fetch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url,
        mode: options.mode || 'stealth',
        options: {
          wait_selector: options.waitSelector,
          wait_ms: waitMs,
          block_resources: blockResources,
          raw_text: options.rawText ?? false,
          timeout_ms: effectiveTimeout,
          solve_cloudflare: solveCloudflare,
          proxy: proxy || undefined,
        },
      }),
      signal: AbortSignal.timeout(effectiveTimeout + 5000),
    });
  } catch (err: any) {
    throw new ScraplingUnavailableError(`Scrapling service unreachable: ${err.message}`);
  }

  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(`Scrapling service rejected request with HTTP ${res.status}`);
    }
    throw new ScraplingUnavailableError(`Scrapling service returned HTTP ${res.status}`);
  }

  const data: ScraplingResponse = await res.json();

  if (!data.ok) {
    throw new Error(`Scrapling fetch failed: ${data.error || 'unknown error'}`);
  }

  return data.html || '';
}

export async function scraplingFetchWithFallback(
  url: string,
  scraplingOpts: ScraplingFetchOptions,
  playwrightOpts: PlaywrightFetchOptions,
): Promise<string> {
  try {
    return await scraplingFetch(url, scraplingOpts);
  } catch (err: any) {
    if (err instanceof ScraplingUnavailableError) {
      console.warn(`[scrapling] Service unavailable, falling back to Playwright for ${url}`);
      return playwrightFetch(url, playwrightOpts);
    }
    throw err;
  }
}
