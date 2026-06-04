import { scraplingFetch, ScraplingUnavailableError } from './scrapling-fetch.js';
import { isBlockedHtml } from './http-utils.js';

// ---------------------------------------------------------------------------
// archive.today fallback (hard paywalls)
// ---------------------------------------------------------------------------
// For HARD paywalls (Economist, WSJ, FT) the publisher ships only the lede to
// non-subscribers — there's no hidden articleBody to recover, so structured-data
// extraction can't help. The remaining lever is a third-party mirror:
// archive.today keeps full snapshots of these articles.
//
// Caveat that drives the design: archive.today aggressively CAPTCHAs datacenter
// IPs (Oracle/AWS), returning a "One more step / security check" interstitial.
// So we DON'T fetch it with plain fetch() — we route through the Scrapling sidecar
// (real Camoufox browser) which, on the VPS, can also carry the residential proxy
// configured via SCRAPLING_PROXY_URL/DOMAINS. That's the only combination with a
// real shot at a clean snapshot. From a bare datacenter IP it will still get
// CAPTCHA'd; that's expected and handled (returns '').
//
// Gated by env so it never fires unexpectedly and never burns browser time on
// sites that don't need it:
//   PAYWALL_ARCHIVE_DOMAINS=economist.com,wsj.com,ft.com
//   ARCHIVE_TODAY_HOST=archive.ph            (mirror; archive.ph is usually fastest)

const ARCHIVE_DOMAINS = (process.env.PAYWALL_ARCHIVE_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const ARCHIVE_HOST = (process.env.ARCHIVE_TODAY_HOST || 'archive.ph').replace(/^https?:\/\//, '').replace(/\/+$/, '');

function hostnameOf(targetUrl: string): string {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function shouldUseArchiveFallback(targetUrl: string): boolean {
  if (ARCHIVE_DOMAINS.length === 0) return false;
  const host = hostnameOf(targetUrl);
  if (!host) return false;
  return ARCHIVE_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

// archive.today's CAPTCHA wall has its own markers distinct from the Cloudflare /
// DataDome ones isBlockedHtml() knows about. Treat a hit as "no snapshot".
function looksLikeArchiveCaptcha(html: string): boolean {
  const lowered = html.slice(0, 4000).toLowerCase();
  return lowered.includes('one more step') ||
    lowered.includes('please complete the security check') ||
    lowered.includes('completing the captcha proves');
}

// Fetches the newest archive.today snapshot for the URL and returns its raw HTML
// (the archived article page). Returns '' when no usable snapshot is reachable —
// caller treats that as "fallback didn't help" and surfaces the original error.
export async function archiveTodayFetch(targetUrl: string, timeoutMs = 60000): Promise<string> {
  const snapshotUrl = `https://${ARCHIVE_HOST}/newest/${targetUrl}`;

  try {
    const html = await scraplingFetch(snapshotUrl, {
      mode: 'stealth',
      blockResources: false,
      waitMs: 1500,
      timeoutMs,
    });
    if (!html || html.length < 500) return '';
    if (looksLikeArchiveCaptcha(html) || isBlockedHtml(html)) return '';
    return html;
  } catch (err) {
    // Sidecar down / unreachable — nothing more to try here; let the caller's
    // existing error stand rather than masking it with an archive-specific one.
    if (err instanceof ScraplingUnavailableError) return '';
    return '';
  }
}
