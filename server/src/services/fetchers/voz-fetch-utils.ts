import { isBlockedHtml, randomUA } from './http-utils.js';
import { scraplingFetchWithFallback } from './scrapling-fetch.js';

const VOZ_PROXY_URL = process.env.BROWSER_PROXY_URL || process.env.VOZ_PROXY_URL || '';
const WORKER_PROXY_TOKEN = process.env.WORKER_PROXY_TOKEN || '';

function buildVozProxyUrl(targetUrl: string): string {
  const proxy = new URL(VOZ_PROXY_URL);
  proxy.searchParams.set('url', targetUrl);
  return proxy.toString();
}

export async function fetchVozViaProxy(targetUrl: string, accept: string, timeoutMs: number): Promise<string | null> {
  if (!VOZ_PROXY_URL) return null;

  try {
    const proxyUrl = buildVozProxyUrl(targetUrl);
    const proxyRes = await fetch(proxyUrl, {
      headers: {
        Accept: accept,
        ...(WORKER_PROXY_TOKEN ? { 'X-Proxy-Token': WORKER_PROXY_TOKEN } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const proxyText = await proxyRes.text();
    if (proxyRes.ok && !isBlockedHtml(proxyText)) {
      console.log(`[voz] proxy fetch ok ${targetUrl}`);
      return proxyText;
    }
    console.warn(`[voz] proxy fetch failed for ${targetUrl}: status=${proxyRes.status}`);
  } catch (err: any) {
    console.warn(`[voz] proxy fetch failed for ${targetUrl}: ${err.message}`);
  }

  return null;
}

export async function fetchVozThreadHtml(pageUrl: string): Promise<string> {
  const proxyResult = await fetchVozViaProxy(pageUrl, 'text/html,application/xhtml+xml', 30000);
  if (proxyResult) return proxyResult;
  return scraplingFetchWithFallback(
    pageUrl,
    { mode: 'stealth', waitMs: 1500, blockResources: false, solveCloudflare: true, timeoutMs: 90000 },
    { waitUntil: 'domcontentloaded', blockHeavyResources: true, settleMs: 3000, timeoutMs: 90000, userAgent: randomUA() },
  );
}

export async function fetchVozFeedXml(sourceUrl: string): Promise<string> {
  const proxyResult = await fetchVozViaProxy(sourceUrl, 'application/rss+xml', 30000);
  if (proxyResult) return proxyResult;
  return scraplingFetchWithFallback(
    sourceUrl,
    { mode: 'stealth', rawText: false, waitMs: 1500, blockResources: false, solveCloudflare: true, timeoutMs: 60000 },
    { rawText: true, blockHeavyResources: true, settleMs: 1500, userAgent: randomUA() },
  );
}
