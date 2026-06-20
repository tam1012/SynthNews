import { getCachePolicy, makeApiCacheKey } from './apiCache';
import { loadPersistentApiCache, markPersistentData, savePersistentApiCache } from './persistentCache';
import type { AdminHealth } from '../pages/admin/adminHelpers';

const API_BASE = '/api';
const ADMIN_TOKEN_STORAGE_KEY = 'admin_token';
const responseCache = new Map<string, { expiresAt: number; data: unknown }>();
const inFlightRequests = new Map<string, Promise<unknown>>();

// Hard cap so a stalled request (international packet-loss spike) can't hang the
// UI forever; after this we fall back to saved data if any, else surface error.
const NETWORK_TIMEOUT_MS = 12_000;
// If the network is slower than this AND we have a saved copy, show the saved
// copy so the page paints instead of freezing. The real request keeps running
// in the background and refreshes the cache for the next render.
const SWR_SOFT_TIMEOUT_MS = 2_500;

type ArticleFeedTab = 'all' | 'news' | 'tech' | 'voz' | 'reddit' | 'saved';
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
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...options?.headers,
      },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    return res.json();
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
      savePersistentApiCache(path, data);
    }

    return data;
  };

  if (!cachePolicy.cacheable) return run();

  const promise = run().finally(() => {
    inFlightRequests.delete(cacheKey);
  });
  inFlightRequests.set(cacheKey, promise);

  // Stale-while-revalidate: when a saved copy exists and the network is slow
  // (international packet-loss spike to the Cloudflare edge), paint the saved
  // copy within SWR_SOFT_TIMEOUT_MS instead of freezing on a skeleton. The
  // request above keeps running and refreshes both caches for the next render.
  const saved = loadPersistentApiCache(path);
  if (saved) {
    promise.catch(() => {}); // returning stale: don't leak an unhandled rejection
    return new Promise<T>((resolve) => {
      const timer = setTimeout(
        () => resolve(markPersistentData(saved as Record<string, unknown>) as T),
        SWR_SOFT_TIMEOUT_MS
      );
      promise.then(
        (data) => { clearTimeout(timer); resolve(data as T); },
        () => { clearTimeout(timer); resolve(markPersistentData(saved as Record<string, unknown>) as T); }
      );
    });
  }

  // No saved copy yet: guard the hard hang, and fall back to any saved copy on failure.
  try {
    return await promise;
  } catch (err) {
    const fallback = loadPersistentApiCache(path);
    if (fallback) return markPersistentData(fallback as Record<string, unknown>) as T;
    throw err;
  }
}

export const api = {
  // Health
  getHealth: () => request<{ success: boolean; data: AdminHealth }>('/health'),

  // Stats
  getStats: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const query = qs.toString();
    return request<any>(`/stats${query ? `?${query}` : ''}`);
  },
  getVisitStats: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const query = qs.toString();
    return request<any>(`/stats/visits${query ? `?${query}` : ''}`);
  },

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
    // Saved tab: no date filter — show all saved articles regardless of date
    const isSaved = params?.feedTab === 'saved';
    if (params?.date && !isSaved) qs.set('date', params.date);
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
    // Saved tab: no date filter — show tags from all saved articles
    const isSaved = params?.feedTab === 'saved';
    if (params?.date && !isSaved) qs.set('date', params.date);
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

  // Saved articles
  saveArticle: (id: string) => request<any>(`/articles/${id}/save`, { method: 'POST' }),
  unsaveArticle: (id: string) => request<any>(`/articles/${id}/unsave`, { method: 'POST' }),
  saveExternalArticle: (url: string) => request<any>('/articles/save-external', { method: 'POST', body: JSON.stringify({ url }) }),

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
  fetchAiProviderModels: (data: { api_endpoint: string; api_key: string }) => request<any>('/ai-providers/fetch-models', { method: 'POST', body: JSON.stringify(data) }),
  getAiProviderModels: (id: string) => request<any>(`/ai-providers/${id}/models`),

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
