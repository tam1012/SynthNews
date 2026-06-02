import { getCachePolicy, makeApiCacheKey } from './apiCache';
import type { AdminHealth } from '../pages/admin/adminHelpers';

const API_BASE = '/api';
const ADMIN_TOKEN_STORAGE_KEY = 'admin_token';
const responseCache = new Map<string, { expiresAt: number; data: unknown }>();
const inFlightRequests = new Map<string, Promise<unknown>>();

type ArticleFeedTab = 'all' | 'news' | 'tech' | 'voz' | 'reddit';
type ArticleSearchOptions = {
  limit?: number;
  date?: string;
  sourceId?: string;
  feedTab?: ArticleFeedTab;
};
type DigestSearchOptions = {
  limit?: number;
  date?: string;
};

function clearClientRequestState() {
  responseCache.clear();
  inFlightRequests.clear();
}

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '';
}

export function setAdminToken(token: string) {
  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token.trim());
  clearClientRequestState();
}

export function clearAdminToken() {
  localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  clearClientRequestState();
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const cachePolicy = getCachePolicy(path, options);
  const cacheKey = makeApiCacheKey(path);

  if (cachePolicy.cacheable) {
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data as T;

    const inFlight = inFlightRequests.get(cacheKey);
    if (inFlight) return inFlight as Promise<T>;
  }

  const doFetch = async (authToken: string) => {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...options?.headers,
        },
      });
      return res.json();
    } catch (err) {
      throw err;
    }
  };

  const run = async () => {
    const data = await doFetch(token);

    if (!data.success) {
      throw new Error(data.error?.message || data.message || 'API request failed');
    }

    if (!cachePolicy.cacheable) {
      clearClientRequestState();
    }

    if (cachePolicy.cacheable) {
      responseCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + cachePolicy.ttlMs,
      });
    }

    return data;
  };

  if (!cachePolicy.cacheable) return run();

  const promise = run().finally(() => {
    inFlightRequests.delete(cacheKey);
  });
  inFlightRequests.set(cacheKey, promise);
  return promise;
}

export const api = {
  // Health
  getHealth: () => request<{ success: boolean; data: AdminHealth }>('/health'),

  // Sources
  getSources: () => request<any>('/sources'),
  getPublicSources: () => request<any>('/sources/public'),
  getSource: (id: string) => request<any>(`/sources/${id}`),
  createSource: (data: any) => request<any>('/sources', { method: 'POST', body: JSON.stringify(data) }),
  updateSource: (id: string, data: any) => request<any>(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSource: (id: string) => request<any>(`/sources/${id}`, { method: 'DELETE' }),
  toggleSource: (id: string) => request<any>(`/sources/${id}/toggle`, { method: 'POST' }),
  scrapeSource: (id: string) => request<any>(`/sources/${id}/scrape`, { method: 'POST' }),
  detectSource: (url: string) => request<any>('/sources/detect', { method: 'POST', body: JSON.stringify({ url }) }),

  // Articles
  getArticles: (params?: { page?: number; limit?: number; sourceId?: string; status?: string; date?: string; tag?: string; minScore?: number; feedTab?: ArticleFeedTab; sort?: 'latest' | 'hot'; qualityIssue?: string }) => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.sourceId) qs.set('sourceId', params.sourceId);
    if (params?.status) qs.set('status', params.status);
    if (params?.date) qs.set('date', params.date);
    if (params?.tag) qs.set('tag', params.tag);
    if (params?.minScore) qs.set('minScore', String(params.minScore));
    if (params?.feedTab) qs.set('feedTab', params.feedTab);
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.qualityIssue) qs.set('qualityIssue', params.qualityIssue);
    return request<any>(`/articles?${qs}`);
  },
  getArticleDates: (sourceId?: string) => {
    const qs = new URLSearchParams();
    if (sourceId) qs.set('sourceId', sourceId);
    return request<any>(`/articles/dates?${qs}`);
  },
  getArticleTags: (params?: { feedTab?: string; date?: string }) => {
    const qs = new URLSearchParams();
    if (params?.feedTab) qs.set('feedTab', params.feedTab);
    if (params?.date) qs.set('date', params.date);
    return request<any>(`/articles/tags?${qs}`);
  },
  searchArticles: (q: string, options?: number | ArticleSearchOptions) => {
    const qs = new URLSearchParams({ q });
    const params = typeof options === 'number' ? { limit: options } : options;
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.date) qs.set('date', params.date);
    if (params?.sourceId) qs.set('sourceId', params.sourceId);
    if (params?.feedTab) qs.set('feedTab', params.feedTab);
    return request<any>(`/articles/search?${qs}`);
  },
  getArticle: (id: string) => request<any>(`/articles/${id}`),
  resetArticleSummary: (id: string) => request<any>(`/articles/${id}/reset-summary`, { method: 'POST' }),
  batchResetArticleSummaries: (ids: string[]) => request<any>('/articles/batch/reset-summary', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),
  rescrapeArticle: (id: string) => request<any>(`/articles/${id}/rescrape`, { method: 'POST' }),
  unclusterArticle: (id: string) => request<any>(`/articles/${id}/uncluster`, { method: 'POST' }),
  clusterArticle: (id: string, parentArticleId: string) => request<any>(`/articles/${id}/cluster`, {
    method: 'POST',
    body: JSON.stringify({ parent_article_id: parentArticleId }),
  }),
  deleteArticle: (id: string) => request<any>(`/articles/${id}`, { method: 'DELETE' }),
  batchDeleteArticles: (ids: string[]) => request<any>('/articles/batch/delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),
  getArticleFetchJobs: (params?: { page?: number; limit?: number; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.status) qs.set('status', params.status);
    return request<any>(`/articles/fetch-jobs?${qs}`);
  },
  retryArticleFetchJob: (id: string) => request<any>(`/articles/fetch-jobs/${id}/retry`, { method: 'POST' }),
  deleteArticleFetchJob: (id: string) => request<any>(`/articles/fetch-jobs/${id}`, { method: 'DELETE' }),
  batchRetryArticleFetchJobs: (ids: string[]) => request<any>('/articles/fetch-jobs/batch/retry', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),
  batchDeleteArticleFetchJobs: (ids: string[]) => request<any>('/articles/fetch-jobs/batch/delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),

  // Digests
  getLatestDigest: (lang?: string) => request<any>(`/digests/latest?lang=${lang || 'vi'}`),
  getDigests: (page?: number) => request<any>(`/digests?page=${page || 1}`),
  searchDigests: (q: string, options?: DigestSearchOptions) => {
    const qs = new URLSearchParams({ q });
    if (options?.limit) qs.set('limit', String(options.limit));
    if (options?.date) qs.set('date', options.date);
    return request<any>(`/digests/search?${qs}`);
  },
  getDigest: (id: string) => request<any>(`/digests/${id}`),
  deleteDigest: (id: string) => request<any>(`/digests/${id}`, { method: 'DELETE' }),

  // AI Providers
  getAiProviders: () => request<any>('/ai-providers'),
  getAiProvider: (id: string) => request<any>(`/ai-providers/${id}`),
  getAiProviderRouting: () => request<any>('/ai-providers/routing'),
  updateAiProviderRouting: (data: any) => request<any>('/ai-providers/routing', { method: 'PATCH', body: JSON.stringify(data) }),
  createAiProvider: (data: any) => request<any>('/ai-providers', { method: 'POST', body: JSON.stringify(data) }),
  updateAiProvider: (id: string, data: any) => request<any>(`/ai-providers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAiProvider: (id: string) => request<any>(`/ai-providers/${id}`, { method: 'DELETE' }),
  activateAiProvider: (id: string) => request<any>(`/ai-providers/${id}/activate`, { method: 'POST' }),
  testAiProvider: (id: string) => request<any>(`/ai-providers/${id}/test`, { method: 'POST' }),

  // Settings
  getPromptConfig: () => request<any>('/settings/prompt'),
  getDefaultPromptConfig: () => request<any>('/settings/prompt/default'),
  updatePromptConfig: (data: any) => request<any>('/settings/prompt', { method: 'PATCH', body: JSON.stringify(data) }),
  resetPromptConfig: () => request<any>('/settings/prompt/reset', { method: 'POST' }),

  // Admin triggers
  triggerScrape: () => request<any>('/health/trigger/scrape', { method: 'POST' }),
  triggerFetchArticles: () => request<any>('/health/trigger/fetch-articles', { method: 'POST' }),
  triggerSummarize: () => request<any>('/health/trigger/summarize', { method: 'POST' }),
  triggerDigest: () => request<any>('/health/trigger/digest', { method: 'POST' }),

  // Blocklist
  getBlocklist: () => request<any>('/blocklist'),
  createBlocklistEntry: (data: { pattern: string; type: 'domain' | 'path'; reason?: string }) =>
    request<any>('/blocklist', { method: 'POST', body: JSON.stringify(data) }),
  updateBlocklistEntry: (id: string, data: { pattern?: string; type?: 'domain' | 'path'; reason?: string; is_enabled?: boolean }) =>
    request<any>(`/blocklist/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBlocklistEntry: (id: string) => request<any>(`/blocklist/${id}`, { method: 'DELETE' }),
  testBlocklistUrl: (url: string) =>
    request<any>('/blocklist/test', { method: 'POST', body: JSON.stringify({ url }) }),
};
