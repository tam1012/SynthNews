/**
 * Reuters proxy worker — runs on Cloudflare edge.
 * Cloudflare edge IPs have clean reputation, bypassing Reuters IP-based blocking.
 */
const ALLOWED_HOSTS = new Set(['reuters.com', 'www.reuters.com']);

function corsOrigin(env) {
  return env.CORS_ORIGIN || 'https://synthnews.site';
}

function createHeaders(contentType, status = 200, env = {}) {
  return {
    'Access-Control-Allow-Origin': corsOrigin(env),
    'Vary': 'Origin',
    'Content-Type': contentType || 'text/plain; charset=UTF-8',
    'Cache-Control': status < 400 ? 'public, max-age=120' : 'no-store',
  };
}

function errorResponse(message, status = 400, env = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: createHeaders('application/json; charset=UTF-8', status, env),
  });
}

function requireProxyToken(request, env) {
  const expected = env.PROXY_TOKEN;
  if (!expected) return errorResponse('PROXY_TOKEN secret not configured', 500, env);
  if (request.headers.get('X-Proxy-Token') !== expected) return errorResponse('Unauthorized', 401, env);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: createHeaders('application/json', 200, env),
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': corsOrigin(env),
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'X-Proxy-Token, Content-Type',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin',
        },
      });
    }

    const authError = requireProxyToken(request, env);
    if (authError) return authError;

    const target = url.searchParams.get('url');
    if (!target) return errorResponse('Missing ?url= parameter', 400, env);

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return errorResponse('Invalid url parameter', 400, env);
    }

    if (targetUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(targetUrl.hostname.toLowerCase())) {
      return errorResponse('Only https://reuters.com URLs are allowed', 400, env);
    }

    const isRss = targetUrl.pathname.includes('/feed') || targetUrl.pathname.endsWith('.rss');
    const accept = isRss
      ? 'application/rss+xml, application/xml, text/xml, */*;q=0.8'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

    try {
      const response = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': accept,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
        },
        redirect: 'follow',
      });

      const text = await response.text();
      const contentType = isRss ? 'application/rss+xml; charset=UTF-8' : 'text/html; charset=UTF-8';

      return new Response(text, {
        status: response.status,
        headers: createHeaders(contentType, response.status, env),
      });
    } catch (err) {
      return errorResponse(err.message || 'Fetch failed', 502, env);
    }
  },
};
