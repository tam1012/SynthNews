const STORAGE_PREFIX = 'synthnews:api-cache:';

function isCacheablePath(path: string): boolean {
  return path.startsWith('/articles') || path === '/sources/public' || path.startsWith('/digests/latest');
}

export function savePersistentApiCache(path: string, data: unknown): void {
  if (!isCacheablePath(path)) return;
  window.localStorage.setItem(`${STORAGE_PREFIX}${path}`, JSON.stringify(data));
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
