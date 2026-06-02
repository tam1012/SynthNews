// Cloudflare Worker proxy for Reddit API
// Deploy to Cloudflare Workers (free tier: 100k requests/day)
// Set REDDIT_PROXY_URL env var in your app to the Worker URL

function corsOrigin(env) {
  return env.CORS_ORIGIN || 'https://synthnews.site';
}

function jsonHeaders(env, status = 200) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin(env),
    'Vary': 'Origin',
    'Cache-Control': status < 400 ? 'public, max-age=60' : 'no-store',
  };
}

function errorResponse(message, status, env) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: jsonHeaders(env, status),
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
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin(env),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'X-Proxy-Token, Content-Type',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin',
        },
      });
    }

    const authError = requireProxyToken(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const redditPath = url.searchParams.get('path');
    if (!redditPath) {
      return errorResponse('Missing ?path= parameter', 400, env);
    }

    // Only allow Reddit paths
    if (!redditPath.startsWith('/r/') && !redditPath.startsWith('/comments/')) {
      return errorResponse('Invalid path', 400, env);
    }

    // Build downstream query: copy all params except `path`
    const forward = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (k !== 'path') forward.append(k, v);
    }
    const qs = forward.toString();
    const redditUrl = `https://www.reddit.com${redditPath}${qs ? `?${qs}` : ''}`;

    try {
      const resp = await fetch(redditUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: jsonHeaders(env, resp.status),
      });
    } catch (e) {
      return errorResponse(e.message || 'Fetch failed', 500, env);
    }
  },
};
