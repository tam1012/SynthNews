import { getMany, query } from '../../db/index.js';

export interface BlocklistEntry {
  id: string;
  pattern: string;
  type: 'domain' | 'path';
  reason: string | null;
  is_enabled: boolean;
}

const CACHE_TTL_MS = 60_000;

interface CacheState {
  loadedAt: number;
  domains: BlocklistEntry[];
  paths: BlocklistEntry[];
  fallbackOnly: boolean;
}

const FALLBACK_DOMAINS: string[] = [
  'thestreet.com', 'timesofisrael.com', 'nytimes.com', 'eweek.com', 'kotaku.com',
  'theinformation.com', 'politico.com', 'politico.eu', 'bangkokpost.com', 'al.com',
  'jakartaglobe.id', 'boston25news.com', 'latimes.com', 'axios.com', 'wsj.com',
  'bloomberg.com', 'ft.com', 'economist.com', 'barrons.com', 'businessinsider.com',
  'seekingalpha.com', 'nikkei.com', 'washingtonpost.com', 'thetimes.com', 'thetimes.co.uk',
  'telegraph.co.uk', 'scmp.com', 'theglobeandmail.com', 'hbr.org',
  'reuters.com', 'qdnd.vn', 'usni.org', 'gothamist.com', 'gizmodo.com',
  'seattletimes.com', 'centerforpolitics.org',
];

const FALLBACK_PATHS: string[] = [
  'bbc.com/sport/', 'bbc.com/audio/', 'bbc.com/news/videos/', 'aljazeera.com/video',
];

let cache: CacheState | null = null;

function buildFallbackCache(): CacheState {
  return {
    loadedAt: Date.now(),
    domains: FALLBACK_DOMAINS.map((pattern, i) => ({
      id: `blk_fb_${i}`, pattern, type: 'domain', reason: 'fallback', is_enabled: true,
    })),
    paths: FALLBACK_PATHS.map((pattern, i) => ({
      id: `blk_fb_path_${i}`, pattern, type: 'path', reason: 'fallback', is_enabled: true,
    })),
    fallbackOnly: true,
  };
}

function envOverrideEntries(): BlocklistEntry[] | null {
  const raw = (process.env.BLOCKED_DOMAINS || process.env.BLOCKED_GOOGLE_NEWS_PUBLISHER_DOMAINS || '').trim();
  if (!raw) return null;
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map((pattern, i) => ({
      id: `blk_env_${i}`,
      pattern,
      type: pattern.includes('/') ? 'path' : 'domain',
      reason: 'env override',
      is_enabled: true,
    }));
}

async function loadCache(): Promise<CacheState> {
  const envEntries = envOverrideEntries();
  if (envEntries) {
    return {
      loadedAt: Date.now(),
      domains: envEntries.filter(e => e.type === 'domain'),
      paths: envEntries.filter(e => e.type === 'path'),
      fallbackOnly: false,
    };
  }

  try {
    const rows = await getMany<BlocklistEntry>(
      `SELECT id, pattern, type, reason, is_enabled FROM blocklist WHERE is_enabled = true`
    );
    if (rows.length === 0) {
      // DB empty (e.g. before migration ran) — use hardcoded fallback to stay safe.
      return buildFallbackCache();
    }
    return {
      loadedAt: Date.now(),
      domains: rows.filter(r => r.type === 'domain'),
      paths: rows.filter(r => r.type === 'path'),
      fallbackOnly: false,
    };
  } catch (err: any) {
    console.warn(`[blocklist] DB load failed, using fallback: ${err.message}`);
    return buildFallbackCache();
  }
}

async function getCache(): Promise<CacheState> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  cache = await loadCache();
  return cache;
}

export function invalidateBlocklistCache(): void {
  cache = null;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Path pattern matching. A `*` is a wildcard that matches any run of path
// characters (including slashes), so `edition.cnn.com/*/weather/video` matches
// `edition.cnn.com/2026/06/09/weather/video/...` regardless of the date segment.
// Patterns without `*` keep the original substring behaviour.
function pathMatches(normalized: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.split('*').map(escapeRegex).join('[^?#]*'));
    return regex.test(normalized);
  }
  return normalized.startsWith(pattern) || normalized.includes(`/${pattern}`);
}

export async function getBlocklistMatch(url: string): Promise<BlocklistEntry | null> {
  const state = await getCache();
  const hostname = getHostname(url);

  if (hostname) {
    const hit = state.domains.find(entry => domainMatches(hostname, entry.pattern));
    if (hit) return hit;
  }

  const normalized = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
  const pathHit = state.paths.find(entry => pathMatches(normalized, entry.pattern));
  return pathHit || null;
}

export async function isBlockedUrl(url: string): Promise<boolean> {
  return Boolean(await getBlocklistMatch(url));
}

export async function recordBlocklistHit(id: string): Promise<void> {
  if (id.startsWith('blk_fb_') || id.startsWith('blk_env_')) return;
  try {
    await query(
      `UPDATE blocklist SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE id = $1`,
      [id]
    );
  } catch (err: any) {
    console.warn(`[blocklist] hit count update failed: ${err.message}`);
  }
}
