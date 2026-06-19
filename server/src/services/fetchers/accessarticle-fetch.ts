// ---------------------------------------------------------------------------
// accessarticlenow.com fallback (paywall bypass via third-party service)
// ---------------------------------------------------------------------------
// removepaywalls.com uses accessarticlenow.com as its core engine. The API
// returns clean HTML of the full article behind the paywall — no CAPTCHA,
// no proxy needed on our end (the service handles residential IP routing).
//
// Gated by env so it never fires unexpectedly:
//   ACCESSARTICLE_DOMAINS=bloomberg.com
//
// Add more domains as the service expands coverage. The service may block
// some sites on its free tier (Reuters requires BrightData KYC, WSJ/NYT
// return empty). Test before adding.
//
// Usage: call accessArticleFetch(url) — returns full HTML string on success,
// '' on any failure. Caller extracts content from the returned HTML.

const ACCESSARTICLE_DOMAINS = (process.env.ACCESSARTICLE_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const ACCESSARTICLE_API = 'https://json.accessarticlenow.com/api/json';

function hostnameOf(targetUrl: string): string {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function shouldUseAccessArticle(targetUrl: string): boolean {
  if (ACCESSARTICLE_DOMAINS.length === 0) return false;
  const host = hostnameOf(targetUrl);
  if (!host) return false;
  return ACCESSARTICLE_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

// Fetches the full article HTML from accessarticlenow.com. Returns '' on any
// failure — caller treats that as "fallback didn't help" and continues to the
// next escalation step.
export async function accessArticleFetch(targetUrl: string, timeoutMs = 60000): Promise<string> {
  const apiUrl = `${ACCESSARTICLE_API}?q=${encodeURIComponent(targetUrl)}&format=html`;

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://removepaywalls.com/',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.warn(`accessarticle-fetch: HTTP ${res.status} for ${targetUrl}`);
      return '';
    }

    const html = await res.text();
    if (!html || html.length < 500) {
      console.warn(`accessarticle-fetch: returned ${html ? `short (${html.length} chars)` : 'empty'} for ${targetUrl}`);
      return '';
    }

    // The service returns error pages like "Webpage not available" when the
    // site is blocked on its free tier (e.g. Reuters needs BrightData KYC).
    if (html.includes('Webpage not available') || html.includes('Residential Failed')) {
      console.warn(`accessarticle-fetch: service blocked for ${targetUrl}`);
      return '';
    }

    return html;
  } catch (err: any) {
    console.warn(`accessarticle-fetch: fetch threw for ${targetUrl}: ${err.message}`);
    return '';
  }
}
