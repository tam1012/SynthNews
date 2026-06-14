import type { DiscoveredArticle } from '../article-fetch-queue.js';
import type { ArticleInsertInput } from './article-writer.js';

export interface SourceRow {
  id: string;
  type: string;
  name: string;
  url: string;
  language: string;
  category: string | null;
  fetch_interval_minutes: number;
  parser_config: any;
}

export interface ArticleFetchJobForFetcher {
  id: string;
  source_id: string;
  url: string;
  title: string;
  external_id: string | null;
  published_at: string | null;
  payload_json: any;
}

export interface ScrapeResult {
  itemsFound: number;
  itemsInserted: number;
  errors: string[];
  metadata?: Record<string, unknown>;
}

export interface FetcherRunContext {
  signal?: AbortSignal;
}

export interface SourceFetcher {
  key: string;
  canHandle(source: Pick<SourceRow, 'type' | 'url'>): boolean;
  fetch(source: SourceRow, context?: FetcherRunContext): Promise<ScrapeResult>;
  discover?(source: SourceRow, context?: FetcherRunContext): Promise<DiscoveredArticle[]>;
  fetchArticle?(job: ArticleFetchJobForFetcher, source: SourceRow, context?: FetcherRunContext): Promise<ArticleInsertInput | null>;
}
