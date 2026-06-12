const STORAGE_PREFIX = 'synthnews:api-cache:';

function isCacheablePath(path: string): boolean {
  return path.startsWith('/articles') || path === '/sources/public' || path.startsWith('/digests/latest');
}

function clearPrefixedKeys(): void {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => window.localStorage.removeItem(key));
}

export function savePersistentApiCache(path: string, data: unknown): void {
  if (!isCacheablePath(path)) return;
  const key = `${STORAGE_PREFIX}${path}`;
  const serialized = JSON.stringify(data);
  try {
    window.localStorage.setItem(key, serialized);
  } catch {
    // localStorage full (quota) — drop our own cached entries and retry once.
    clearPrefixedKeys();
    try {
      window.localStorage.setItem(key, serialized);
    } catch {
      // Still failing — give up silently; persistent cache is best-effort.
    }
  }
}

export function loadPersistentApiCache(path: string): unknown | null {
  if (!isCacheablePath(path)) return null;
  const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${path}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    window.localStorage.removeItem(`${STORAGE_PREFIX}${path}`);
    return null;
  }
}

export function markPersistentData<T extends Record<string, unknown>>(data: T): T & { offline: true; stale: true } {
  return { ...data, offline: true, stale: true };
}
