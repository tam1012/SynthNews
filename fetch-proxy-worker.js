// Generic fetch proxy Cloudflare Worker
//
// Purpose: Bypass datacenter IP blocks (Oracle/AWS/etc.) by routing requests
// through Cloudflare's edge network. Effective for sites that IP-block
// datacenters but are NOT themselves protected by Cloudflare/Turnstile.
//
// Deploy:
//   1. Cloudflare Dashboard → Workers & Pages → Create Worker
//   2. Paste this file as the worker code
//   3. Add a secret:  Settings → Variables → "PROXY_TOKEN" (any random string)
//   4. Deploy and copy the worker URL (e.g. https://fetch-proxy.tamhvt.workers.dev)
//   5. In server env: set WORKER_PROXY_URL + WORKER_PROXY_TOKEN
//
// Usage:
//   GET  https://fetch-proxy.tamhvt.workers.dev/?url=https://target.com/path
//        Header: X-Proxy-Token: <token>
//        Optional headers (forwarded): User-Agent, Accept, Accept-Language, Cookie, Referer
//
// Free tier: 100,000 requests/day, 10ms CPU/request — plenty for newstamhv.
//
// Limits:
//   - Does NOT bypass Cloudflare-protected sites (VOZ, etc.) — Worker IPs
//     are still on Cloudflare network and get challenged the same.
//   - Does NOT solve JS challenges (Turnstile, hCaptcha) — use scrapling for those.
//   - 30s timeout per request.

const ALLOWED_DOMAINS = [
  // Reddit (already proxied by reddit-proxy-worker, can route here too)
  'reddit.com',
  // Western news sites that block Oracle Cloud datacenter IPs
  'nytimes.com',
  'kotaku.com',
  'eweek.com',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
  'engadget.com',
  'techcrunch.com',
  'theguardian.com',
  'bbc.com',
  'bbc.co.uk',
  'cnn.com',
  'reuters.com',
  'bloomberg.com',
  'wsj.com',
  'ft.com',
  'economist.com',
  'forbes.com',
  'businessinsider.com',
];

const FORWARD_REQUEST_HEADERS = [
  'user-agent',
  'accept',
  'accept-language',
  'cookie',
  'referer',
];

function isDomainAllowed(hostname) {
  const host = hostname.replace(/^www\./, '').toLowerCase();
  return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'X-Proxy-Token, Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const expected = env.PROXY_TOKEN;
    if (!expected) {
      return new Response('PROXY_TOKEN secret not configured', { status: 500 });
    }
    if (request.headers.get('X-Proxy-Token') !== expected) {
      return new Response('Unauthorized', { status: 401 });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return new Response(JSON.stringify({ error: 'Only http(s) URLs allowed' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!isDomainAllowed(targetUrl.hostname)) {
      return new Response(
        JSON.stringify({ error: 'Domain not in allowlist', hostname: targetUrl.hostname }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const fwdHeaders = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) fwdHeaders.set(name, value);
    }
    if (!fwdHeaders.has('User-Agent')) {
      fwdHeaders.set(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      );
    }
    if (!fwdHeaders.has('Accept')) {
      fwdHeaders.set(
        'Accept',
        'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
      );
    }
    if (!fwdHeaders.has('Accept-Language')) {
      fwdHeaders.set('Accept-Language', 'en-US,en;q=0.9');
    }
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: fwdHeaders,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'follow',
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Upstream fetch failed', message: err.message }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const respHeaders = new Headers();
    const passthrough = ['content-type', 'content-language', 'last-modified', 'etag', 'date'];
    for (const name of passthrough) {
      const value = upstream.headers.get(name);
      if (value) respHeaders.set(name, value);
    }
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('X-Proxy-Upstream-Status', String(upstream.status));

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};
