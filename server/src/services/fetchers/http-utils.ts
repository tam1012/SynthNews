import { execFile } from 'child_process';
import { chromium, ChromiumBrowser } from 'playwright';
import puppeteer from 'puppeteer-core';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { normalizePublicHttpUrlWithDns } from '../../lib/utils.js';

// ---------------------------------------------------------------------------
// User-Agent pool – realistic desktop browsers
// ---------------------------------------------------------------------------
export const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

let _uaIndex = Math.floor(Math.random() * UA_POOL.length);
export function randomUA(): string {
  // Round-robin-ish rotate so each call gets a different one
  const ua = UA_POOL[_uaIndex];
  _uaIndex = (_uaIndex + 1) % UA_POOL.length;
  return ua;
}

export const BROWSER_UA = UA_POOL[0];
export const GOOGLEBOT_UA = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// ---------------------------------------------------------------------------
// Full realistic browser headers
// ---------------------------------------------------------------------------
export function browserHeaders(ua?: string): Record<string, string> {
  return {
    'User-Agent': ua || BROWSER_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };
}

// ---------------------------------------------------------------------------
// curl wrapper
// ---------------------------------------------------------------------------
export async function curlFetch(url: string, _accept: string, timeoutSec: number, ua?: string): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
  const safeUrl = await normalizePublicHttpUrlWithDns(url);
  if (!safeUrl) throw new Error('URL must be a public http(s) URL');

  return new Promise((resolve, reject) => {
    const safeTimeout = Math.max(1, Math.min(timeoutSec, 60));
    const effectiveUA = ua || BROWSER_UA;
    const args = [
      '-s', '--compressed', '--max-time', String(safeTimeout),
      '-H', `User-Agent: ${effectiveUA}`,
      '-H', `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`,
      '-H', 'Accept-Language: en-US,en;q=0.9,vi;q=0.8',
      '-H', 'Accept-Encoding: gzip, deflate, br',
      '-H', 'Connection: keep-alive',
      '-H', 'Upgrade-Insecure-Requests: 1',
      '-H', 'Sec-Fetch-Dest: document',
      '-H', 'Sec-Fetch-Mode: navigate',
      '-H', 'Sec-Fetch-Site: none',
      '-H', 'Sec-Fetch-User: ?1',
      safeUrl,
    ];
    execFile('curl', args, { timeout: (safeTimeout + 2) * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const body = stdout || '';
      const isBlocked = body.includes('Just a moment...') || body.includes('<title>Blocked</title>');
      resolve({
        ok: !isBlocked && body.length > 100,
        status: isBlocked ? 403 : 200,
        text: async () => body,
        json: async () => JSON.parse(body),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Puppeteer core browser fetch (legacy – kept for compatibility)
// ---------------------------------------------------------------------------
let pupBrowserInstance: any = null;
let pupBrowserPromise: Promise<any> | null = null;

async function getPuppeteerBrowser(): Promise<any> {
  if (pupBrowserInstance && pupBrowserInstance.connected) return pupBrowserInstance;
  if (pupBrowserInstance && !pupBrowserInstance.connected) {
    pupBrowserInstance = null;
    pupBrowserPromise = null;
  }
  if (!pupBrowserPromise) {
    pupBrowserPromise = puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
      ],
    }).then((browser) => {
      pupBrowserInstance = browser;
      browser.on?.('disconnected', () => {
        if (pupBrowserInstance === browser) pupBrowserInstance = null;
        pupBrowserPromise = null;
      });
      return browser;
    }).catch((err) => {
      pupBrowserInstance = null;
      pupBrowserPromise = null;
      throw err;
    });
  }
  return pupBrowserPromise;
}

export interface BrowserFetchOptions {
  rawText?: boolean;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  blockHeavyResources?: boolean;
  settleMs?: number;
  userAgent?: string;
}

export async function browserFetch(url: string, timeoutMs: number = 30000, rawTextOrOptions: boolean | BrowserFetchOptions = false): Promise<string> {
  const safeUrl = await normalizePublicHttpUrlWithDns(url);
  if (!safeUrl) throw new Error('URL must be a public http(s) URL');

  const options: BrowserFetchOptions = typeof rawTextOrOptions === 'boolean' ? { rawText: rawTextOrOptions } : rawTextOrOptions;
  const browser = await getPuppeteerBrowser();
  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      (window as any).chrome = { runtime: {} };
    });
    await page.setRequestInterception(true);
    page.on('request', async (request: any) => {
      try {
        const resourceType = request.resourceType();
        if (options.blockHeavyResources && ['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
          await request.abort();
          return;
        }
        const safeRequestUrl = await normalizePublicHttpUrlWithDns(request.url(), false);
        if (!safeRequestUrl) {
          await request.abort();
          return;
        }
        await request.continue();
      } catch {
        try { await request.abort(); } catch {}
      }
    });
    await page.setUserAgent(options.userAgent || BROWSER_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(safeUrl, { waitUntil: options.waitUntil || 'networkidle2', timeout: timeoutMs });

    try {
      const acceptBtn = await page.$('button[aria-label="Accept all cookies"], button:has-text("Accept")');
      if (acceptBtn) await acceptBtn.click();
      await new Promise(r => setTimeout(r, options.settleMs ?? 500));
    } catch {}

    if (options.rawText) {
      return await page.evaluate(() => document.body?.innerText || document.documentElement?.textContent || '');
    }
    return await page.content();
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Playwright + stealth plugin fetch (primary stealth browser)
// ---------------------------------------------------------------------------

let pwBrowser: ChromiumBrowser | null = null;
let pwBrowserPromise: Promise<ChromiumBrowser> | null = null;

async function getPlaywrightBrowser(): Promise<ChromiumBrowser> {
  if (pwBrowser && pwBrowser.isConnected()) return pwBrowser;
  if (pwBrowser && !pwBrowser.isConnected()) {
    pwBrowser = null;
    pwBrowserPromise = null;
  }

  const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  if (!pwBrowserPromise) {
    pwBrowserPromise = chromium.launch({
      executablePath: execPath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--lang=en-US,en',
      ],
    }).then((browser) => {
      pwBrowser = browser;
      browser.on('disconnected', () => {
        if (pwBrowser === browser) pwBrowser = null;
        pwBrowserPromise = null;
      });
      return browser;
    }).catch((err) => {
      pwBrowser = null;
      pwBrowserPromise = null;
      throw err;
    });
  }
  return pwBrowserPromise;
}

export interface PlaywrightFetchOptions {
  /** Return only document.body.innerText instead of full HTML (saves bandwidth) */
  rawText?: boolean;
  /** When to consider page "loaded" */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  /** Block images/fonts/media/stylesheets to speed up fetch */
  blockHeavyResources?: boolean;
  /** Extra ms to wait after DOM settles */
  settleMs?: number;
  /** Override User-Agent; default is random from UA_POOL */
  userAgent?: string;
  /** Extra cookies to inject */
  cookies?: { name: string; value: string; domain: string; path?: string }[];
  /** Extra HTTP headers for every request */
  extraHeaders?: Record<string, string>;
  /** Custom page timeout (default 30000) */
  timeoutMs?: number;
}

const stealthEvasionScript = () => {
  // Run in every new page context before any JS executes
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  Object.defineProperty(screen, 'width', { get: () => 1920 });
  Object.defineProperty(screen, 'height', { get: () => 1080 });
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  (window as any).chrome = { runtime: {}, app: {} };
  // Remove automation-related global variables that some detectors check
  delete (window as any)['callSelenium'];
  delete (window as any)['__selenium'];
  delete (window as any)['__webdriver__'];
  delete (window as any)['__cdc__'];
  delete (window as any)['webdriver'];
  delete (window as any)['selenium'];
  delete (window as any)['_selenium'];
  delete (window as any)['cdc_asdjflasutopfhvc7mc5g'];
  // Patch Permissions API to return granted for everything
  const origQuery = (window as any).Permissions?.prototype?.query;
  if (origQuery) {
    (window as any).Permissions.prototype.query = async function (desc: any) {
      if (desc.name === 'notifications') {
        return { state: 'granted' };
      }
      return origQuery.call(this, desc);
    };
  }
};

export function isBlockedHtml(html: string): boolean {
  if (html.length > 50000) return false;
  const lowered = html.toLowerCase();
  return lowered.includes('just a moment...') ||
    lowered.includes('<title>blocked</title>') ||
    lowered.includes('challenges.cloudflare.com') ||
    lowered.includes('cf-browser-verification') ||
    lowered.includes('access denied') ||
    lowered.includes('token.awswaf.com') ||
    lowered.includes('awswafintegration') ||
    lowered.includes('awswafcookiedomainlist') ||
    lowered.includes('challenge-container') ||
    // DataDome (Reuters, Bloomberg, etc.) — interstitial + JS challenge markers
    lowered.includes('captcha-delivery.com') ||
    lowered.includes('geo.captcha-delivery.com') ||
    lowered.includes('datadome') ||
    // PerimeterX / HUMAN
    lowered.includes('_pxhd') ||
    lowered.includes('px-captcha') ||
    lowered.includes('perimeterx') ||
    lowered.includes("verify that you're not a robot");
}

export async function playwrightFetch(
  url: string,
  options: PlaywrightFetchOptions = {},
): Promise<string> {
  const safeUrl = await normalizePublicHttpUrlWithDns(url);
  if (!safeUrl) throw new Error('URL must be a public http(s) URL');

  const browser = await getPlaywrightBrowser();
  const context = await browser.newContext({
    userAgent: options.userAgent || randomUA(),
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      ...(options.extraHeaders || {}),
    },
    ...(options.cookies ? { cookies: options.cookies as any } : {}),
  });

  const page = await context.newPage();

  try {
    // ── Stealth: block automation signals before any script runs ─────────────
    await page.addInitScript(stealthEvasionScript);

    // ── Block unsafe redirects/subresources and optionally heavy resources ──
    await page.route('**/*', async (route) => {
      try {
        const req = route.request();
        const type = req.resourceType();
        if (options.blockHeavyResources && ['image', 'font', 'media', 'stylesheet'].includes(type)) {
          await route.abort();
          return;
        }
        const safeRequestUrl = await normalizePublicHttpUrlWithDns(req.url(), false);
        if (!safeRequestUrl) {
          await route.abort();
          return;
        }
        await route.continue();
      } catch {
        try { await route.abort(); } catch {}
      }
    });

    // ── Click cookie banners if present ────────────────────────────────────
    page.on('dialog', async (dialog) => {
      if (dialog.type() === 'alert' || dialog.type() === 'confirm') {
        // Auto-dismiss cookie/paywall modals that open as dialogs
        await dialog.dismiss();
      }
    });

    // Normalize waitUntil: playwright <1.61 only accepts load|domcontentloaded|networkidle|commit
    const waitMap: Record<string, string> = {
      networkidle2: 'networkidle',
      networkidle0: 'networkidle',
    };
    const waitVal = (options.waitUntil || 'networkidle2') as string;
    const normalizedWait = waitMap[waitVal] ?? waitVal;

    await page.goto(safeUrl, {
      waitUntil: normalizedWait as any,
      timeout: options.timeoutMs ?? 30000,
    });

    // Small settle delay
    await page.waitForTimeout(options.settleMs ?? 800);

    // Try to click common cookie / "Accept all" buttons
    try {
      const acceptBtn = await page.$(
        'button[aria-label*="Accept"], button[class*="cookie"] button, ' +
        '#onetrust-accept-btn-handler, button[class*="consent"]',
      );
      if (acceptBtn) {
        await acceptBtn.click();
        await page.waitForTimeout(500);
      }
    } catch {
      // Ignore – button may not exist on this site
    }

    if (options.rawText) {
      return await page.evaluate(() => document.body?.innerText || document.documentElement?.textContent || '');
    }
    return await page.content();
  } finally {
    await page.close();
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Cloudflare Worker proxy fetch
// ---------------------------------------------------------------------------
// Routes a request through a generic Cloudflare Worker (see fetch-proxy-worker.js).
// Cloudflare edge IPs have better reputation than Oracle/AWS datacenter IPs,
// so this often bypasses simple IP-based bot blocks.
//
// Configure via env:
//   WORKER_PROXY_URL=https://fetch-proxy.tamhvt.workers.dev
//   WORKER_PROXY_TOKEN=<secret>
//   WORKER_PROXY_SKIP_DOMAINS=voz.vn,vozforums.com   # CF-protected, Worker can't help
//
// Worker enforces its own domain allowlist; this helper is a simple wrapper.

const WORKER_PROXY_URL = process.env.WORKER_PROXY_URL || '';
const WORKER_PROXY_TOKEN = process.env.WORKER_PROXY_TOKEN || '';
const WORKER_PROXY_SKIP_DOMAINS = (process.env.WORKER_PROXY_SKIP_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export class WorkerProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerProxyUnavailableError';
  }
}

export function isWorkerProxyConfigured(): boolean {
  return Boolean(WORKER_PROXY_URL && WORKER_PROXY_TOKEN);
}

export function shouldSkipWorkerProxy(targetUrl: string): boolean {
  if (WORKER_PROXY_SKIP_DOMAINS.length === 0) return false;
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    return WORKER_PROXY_SKIP_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

export interface WorkerProxyFetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  accept?: string;
  acceptLanguage?: string;
  cookie?: string;
  referer?: string;
}

export async function workerProxyFetch(
  url: string,
  options: WorkerProxyFetchOptions = {},
): Promise<{ ok: boolean; status: number; upstreamStatus: number; body: string }> {
  if (!isWorkerProxyConfigured()) {
    throw new WorkerProxyUnavailableError('WORKER_PROXY_URL or WORKER_PROXY_TOKEN not configured');
  }
  if (shouldSkipWorkerProxy(url)) {
    throw new WorkerProxyUnavailableError(`Domain skipped per WORKER_PROXY_SKIP_DOMAINS: ${url}`);
  }

  const safeUrl = await normalizePublicHttpUrlWithDns(url);
  if (!safeUrl) throw new Error('URL must be a public http(s) URL');

  const proxyUrl = `${WORKER_PROXY_URL.replace(/\/+$/, '')}/?url=${encodeURIComponent(safeUrl)}`;
  const timeout = options.timeoutMs ?? 25000;

  const headers: Record<string, string> = {
    'X-Proxy-Token': WORKER_PROXY_TOKEN,
    'User-Agent': options.userAgent || randomUA(),
    Accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': options.acceptLanguage || 'en-US,en;q=0.9,vi;q=0.8',
  };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.referer) headers.Referer = options.referer;

  let res: Response;
  try {
    res = await fetch(proxyUrl, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err: any) {
    throw new WorkerProxyUnavailableError(`Worker proxy unreachable: ${err.message}`);
  }

  const upstreamStatus = parseInt(res.headers.get('X-Proxy-Upstream-Status') || '0', 10) || res.status;

  if (res.status === 401 || res.status === 403 || res.status === 500) {
    const body = await res.text().catch(() => '');
    throw new WorkerProxyUnavailableError(`Worker proxy rejected request (${res.status}): ${body.slice(0, 200)}`);
  }

  const body = await res.text();
  return {
    ok: res.ok && !isBlockedHtml(body) && body.length > 100,
    status: res.status,
    upstreamStatus,
    body,
  };
}

// ---------------------------------------------------------------------------
// Vietnam residential proxy (geo-block bypass)
// ---------------------------------------------------------------------------
// Vietnamese sites behind VEdge/VNPT CDN (e.g. en.qdnd.vn) geo-block any IP that
// isn't inside Vietnam — a datacenter IP gets a hard 403 ACCESS DENIED that no
// browser render or anti-bot trick clears, because it isn't an anti-bot wall at
// all, it's "you aren't in Vietnam". The fix is an egress IP physically in VN.
// This is a DIFFERENT axis from SCRAPLING_PROXY_URL (the Singapore residential
// proxy that clears foreign anti-bot walls like DataDome/PerimeterX). The two
// don't substitute for each other: the VN proxy is useless against DataDome, the
// SG proxy is useless against a VN geo-block. So we route by domain.
//
// Config via env:
//   VN_PROXY_URL=http://user:pass@host:port
//   VN_PROXY_DOMAINS=qdnd.vn          # comma-separated; default below
const VN_PROXY_URL = process.env.VN_PROXY_URL || '';
const VN_PROXY_DOMAINS = (process.env.VN_PROXY_DOMAINS || 'qdnd.vn')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

let _vnProxyAgent: ProxyAgent | null = null;
function getVnProxyAgent(): ProxyAgent | null {
  if (!VN_PROXY_URL) return null;
  if (!_vnProxyAgent) _vnProxyAgent = new ProxyAgent(VN_PROXY_URL);
  return _vnProxyAgent;
}

export function isVnProxyConfigured(): boolean {
  return Boolean(VN_PROXY_URL);
}

// Should this URL be routed through the VN proxy? True only for the configured
// VN domains, so we don't tunnel unrelated traffic through a single 4G line.
export function shouldUseVnProxy(targetUrl: string): boolean {
  if (!VN_PROXY_URL || VN_PROXY_DOMAINS.length === 0) return false;
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    return VN_PROXY_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cookie-aware redirect fetch
// ---------------------------------------------------------------------------
// Some sites (e.g. qdnd.vn) answer the first request with a 302 + Set-Cookie and
// only serve the full article to a client that replays that cookie on the
// redirect target. Node's global fetch follows redirects but does NOT carry
// Set-Cookie across hops, so the app lands on a tiny cookie-gate page (~400
// chars) that isn't an anti-bot block — it just looks like "content too short".
// This helper walks redirects manually, accumulating cookies between hops.
//
// When `proxyUrl` is set (or the host matches VN_PROXY_DOMAINS), the hops run
// through undici's ProxyAgent so the request egresses from a Vietnam IP — the
// only way past VEdge geo-blocking on en.qdnd.vn. We use undici's fetch rather
// than the global one because the `dispatcher` option is undici-specific.
export async function cookieAwareFetch(
  url: string,
  options: { timeoutMs?: number; userAgent?: string; maxRedirects?: number; proxyUrl?: string } = {},
): Promise<{ ok: boolean; status: number; body: string; finalUrl: string }> {
  const safeUrl = await normalizePublicHttpUrlWithDns(url);
  if (!safeUrl) throw new Error('URL must be a public http(s) URL');

  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRedirects = options.maxRedirects ?? 5;
  const ua = options.userAgent || BROWSER_UA;
  const cookieJar = new Map<string, string>();
  const deadline = Date.now() + timeoutMs;

  // Explicit proxyUrl wins; otherwise auto-apply the VN proxy for VN domains.
  const explicitAgent = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : null;
  const dispatcher = explicitAgent ?? (shouldUseVnProxy(safeUrl) ? getVnProxyAgent() : null);

  let currentUrl = safeUrl;
  let lastStatus = 0;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('cookieAwareFetch timed out');

    const headers: Record<string, string> = { ...browserHeaders(ua) };
    if (cookieJar.size > 0) {
      headers.Cookie = Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const res = await undiciFetch(currentUrl, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining),
      ...(dispatcher ? { dispatcher } : {}),
    });
    lastStatus = res.status;

    const setCookies = typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie() as string[]
      : [];
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        const body = await res.text();
        return { ok: false, status: res.status, body, finalUrl: currentUrl };
      }
      const nextUrl = await normalizePublicHttpUrlWithDns(new URL(location, currentUrl).toString());
      if (!nextUrl) throw new Error('Redirect to non-public URL blocked');
      currentUrl = nextUrl;
      continue;
    }

    const body = await res.text();
    return {
      ok: res.ok && body.length > 100 && !isBlockedHtml(body),
      status: res.status,
      body,
      finalUrl: currentUrl,
    };
  }

  throw new Error(`cookieAwareFetch exceeded ${maxRedirects} redirects (last status ${lastStatus})`);
}

// ---------------------------------------------------------------------------
// Proxy fetch with automatic redirect following
// ---------------------------------------------------------------------------
// Like a plain fetch but egressing through an explicit ProxyAgent and letting
// undici follow redirects itself. cookieAwareFetch walks redirects MANUALLY
// (redirect: 'manual') to carry Set-Cookie across hops for sites like qdnd.vn —
// but old.reddit.com answers with a chain of 301s (www<->old, cookie gate) that
// the manual walker treats as a redirect loop and aborts after maxRedirects.
// Auto-follow handles that chain transparently, which is what we need here.
export async function proxyFetchFollow(
  url: string,
  options: { timeoutMs?: number; userAgent?: string; proxyUrl?: string } = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const safeUrl = await normalizePublicHttpUrlWithDns(url);
  if (!safeUrl) throw new Error('URL must be a public http(s) URL');

  const timeoutMs = options.timeoutMs ?? 20000;
  const ua = options.userAgent || BROWSER_UA;
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;

  const res = await undiciFetch(safeUrl, {
    headers: { ...browserHeaders(ua) },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Convenience: fetch with Googlebot UA (bypasses paywalls that check UA)
// ---------------------------------------------------------------------------
export async function curlFetchGooglebot(url: string, timeoutSec = 20) {
  return curlFetch(url, 'text/html', timeoutSec, GOOGLEBOT_UA);
}

// ---------------------------------------------------------------------------
// Health-check: ensure both browsers can launch
// ---------------------------------------------------------------------------
export async function browserHealthCheck(): Promise<{ puppeteer: boolean; playwright: boolean }> {
  let puppeteer = false;
  let playwright = false;

  try {
    const b1 = await getPuppeteerBrowser();
    puppeteer = !!b1;
  } catch {}

  try {
    const b2 = await getPlaywrightBrowser();
    playwright = !!b2;
  } catch {}

  return { puppeteer, playwright };
}
