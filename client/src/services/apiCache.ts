export type ApiCachePolicy =
  | { cacheable: true; ttlMs: number }
  | { cacheable: false; ttlMs?: never };

export function getCachePolicy(path: string, options?: RequestInit): ApiCachePolicy {
  const method = (options?.method || 'GET').toUpperCase();
  if (method !== 'GET') return { cacheable: false };

  if (path.startsWith('/articles')) return { cacheable: true, ttlMs: 60_000 };
  if (path === '/sources') return { cacheable: true, ttlMs: 300_000 };
  if (path.startsWith('/digests/search')) return { cacheable: true, ttlMs: 60_000 };
  if (path.startsWith('/digests/latest')) return { cacheable: true, ttlMs: 60_000 };

  return { cacheable: false };
}

export function makeApiCacheKey(path: string): string {
  return `GET ${path}`;
}
