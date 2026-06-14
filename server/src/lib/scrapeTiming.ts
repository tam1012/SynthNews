export interface SourceTimingInput {
  name?: string | null;
  url?: string | null;
}

export function normalizeFetchIntervalMinutes(value: unknown, fallback = 60): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(5, Math.round(parsed));
}

export function addScrapeJitter(minutes: number, random = Math.random): number {
  if (minutes <= 10) return minutes;
  const jitterWindow = Math.min(10, Math.max(2, Math.floor(minutes * 0.1)));
  const jitter = Math.floor(random() * (jitterWindow * 2 + 1)) - jitterWindow;
  return Math.max(5, minutes + jitter);
}

export function computeScrapeNextDelayMinutes(
  fetchIntervalMinutes: unknown,
  hasErrors: boolean,
  random = Math.random
): number {
  const base = normalizeFetchIntervalMinutes(fetchIntervalMinutes);
  const delay = hasErrors ? Math.min(base * 2, 24 * 60) : base;
  return addScrapeJitter(delay, random);
}

export function computeScrapeFailureBackoffMinutes(fetchIntervalMinutes: unknown, failureCount: number): number {
  const base = normalizeFetchIntervalMinutes(fetchIntervalMinutes);
  const exponent = Math.max(0, failureCount - 1);
  return Math.min(base * Math.pow(2, exponent), 24 * 60);
}

export function getSourceScrapeTimeoutMs(source: SourceTimingInput, env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SOURCE_SCRAPE_TIMEOUT_MS || 0);
  if (Number.isFinite(configured) && configured >= 10_000) return configured;

  const name = String(source.name || '').toLowerCase();
  const url = String(source.url || '').toLowerCase();
  if (name.includes('reddit') || url.includes('reddit.com')) return 180_000;
  if (name.includes('voz') || url.includes('voz.vn')) return 600_000;
  return 90_000;
}
