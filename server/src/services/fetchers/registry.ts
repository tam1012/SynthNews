import { SourceFetcher, SourceRow } from './types.js';

function isHost(url: string, hosts: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hosts.includes(hostname);
  } catch {
    return false;
  }
}

// MSN is a JS-rendered aggregator served via its public JSON APIs (see
// msn-fetcher.ts). Defined here, not in msn-fetcher, so the fetcher can import
// it the same way reddit/voz do — and so this module stays import-free for the
// vm-sandboxed registry test.
export function isMsnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'msn.com' || host.endsWith('.msn.com');
  } catch {
    return false;
  }
}

export function isMsnSource(source: Pick<SourceRow, 'type' | 'url'>): boolean {
  return source.type === 'web' && isMsnUrl(source.url);
}

export function isSohuUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'sohu.com' || host.endsWith('.sohu.com');
  } catch {
    return false;
  }
}

export function isSohuSource(source: Pick<SourceRow, 'type' | 'url'>): boolean {
  return source.type === 'web' && isSohuUrl(source.url);
}

export function isQqNewsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'news.qq.com' || host === 'i.news.qq.com' || host.endsWith('.news.qq.com');
  } catch {
    return false;
  }
}

export function isQqNewsSource(source: Pick<SourceRow, 'type' | 'url'>): boolean {
  return source.type === 'web' && isQqNewsUrl(source.url);
}

export function isRedditSource(source: Pick<SourceRow, 'url'>): boolean {
  return isHost(source.url, ['reddit.com', 'www.reddit.com']);
}

export function isVozSource(source: Pick<SourceRow, 'url'>): boolean {
  return isHost(source.url, ['voz.vn', 'www.voz.vn']);
}

export function isGitHubTrendingSource(source: Pick<SourceRow, 'type' | 'url'>): boolean {
  if (source.type !== 'web') return false;
  try {
    const parsed = new URL(source.url);
    return parsed.hostname.toLowerCase() === 'github.com' && parsed.pathname.toLowerCase().startsWith('/trending');
  } catch {
    return false;
  }
}

export function getFetcherKeyForSource(source: Pick<SourceRow, 'type' | 'url'>): string {
  if (isRedditSource(source)) return 'reddit';
  if (isVozSource(source)) return 'voz';
  if (isMsnSource(source)) return 'msn';
  if (isSohuSource(source)) return 'sohu';
  if (isQqNewsSource(source)) return 'qq-news';
  if (isGitHubTrendingSource(source)) return 'github-trending';
  if (source.type === 'rss') return 'rss';
  if (source.type === 'web') return 'html';
  throw new Error(`No fetcher registered for source type ${source.type}`);
}

export function getFetcherForSource(source: Pick<SourceRow, 'type' | 'url'>, fetchers: SourceFetcher[]): SourceFetcher {
  const fetcher = fetchers.find((candidate) => candidate.canHandle(source));
  if (!fetcher) throw new Error(`No fetcher registered for source type ${source.type}`);
  return fetcher;
}