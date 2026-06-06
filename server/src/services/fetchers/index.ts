import { htmlFetcher } from './html-fetcher.js';
import { githubTrendingFetcher } from './github-trending-fetcher.js';
import { msnFetcher } from './msn-fetcher.js';
import { redditFetcher } from './reddit-fetcher.js';
import { rssFetcher } from './rss-fetcher.js';
import { vozFetcher } from './voz-fetcher.js';
import { SourceFetcher } from './types.js';

export const sourceFetchers: SourceFetcher[] = [
  redditFetcher,
  vozFetcher,
  githubTrendingFetcher,
  msnFetcher,
  rssFetcher,
  htmlFetcher,
];

export * from './types.js';
export * from './forum-fetchers.js';
