// Default timezone offsets per source language. Used as fallback when a source
// emits a datetime string without an explicit timezone suffix (e.g. VnExpress
// publishes "2026-05-20T15:30:00" meaning Vietnam local time, not UTC).
const LANGUAGE_TIMEZONE_OFFSETS: Record<string, string> = {
  vi: '+07:00',
  zh: '+08:00',
};

export function getDefaultTimezoneForLanguage(language: string | null | undefined): string {
  if (!language) return 'Z';
  return LANGUAGE_TIMEZONE_OFFSETS[language.toLowerCase()] || 'Z';
}

export interface NormalizeDateOptions {
  // Suffix to append when the input looks like an ISO datetime without timezone
  // info. Defaults to 'Z' (UTC) for backwards compatibility.
  defaultTimezone?: string;
}

// Plausible publish-date window. `new Date("...1 Jun 20261...")` happily yields
// year 20261, whose ISO form ("+020261-...") is rejected by Postgres timestamptz
// with "time zone displacement out of range". Bound the year so junk text from a
// mis-learned selector (e.g. aljazeera's doubled "1 Jun 20261 Jun 2026") is
// dropped to null instead of poisoning the insert.
const MIN_PLAUSIBLE_YEAR = 2000;
const MAX_PLAUSIBLE_YEAR = new Date().getUTCFullYear() + 1;

export function normalizeDate(value: string | Date | null | undefined, options: NormalizeDateOptions = {}): string | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  let normalized = value.trim();
  if (!normalized) return null;

  const defaultTz = options.defaultTimezone || 'Z';

  // ISO datetime without timezone suffix → append fallback offset
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) {
    normalized += defaultTz;
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    // "YYYY-MM-DD HH:mm[:ss]" (common in CMS dumps) → treat as ISO + tz fallback
    normalized = normalized.replace(' ', 'T') + defaultTz;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    // Date only → midnight in fallback tz
    normalized += `T00:00:00${defaultTz}`;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
  return date.toISOString();
}
