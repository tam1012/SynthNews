import { useState, useEffect, useCallback } from 'react';

export const FONT_SIZES = [12, 14, 16, 18, 20] as const;
const DEFAULT_FONT_SIZE = 16;

function normalizeFontSize(size: number) {
  return FONT_SIZES.includes(size as typeof FONT_SIZES[number]) ? size : DEFAULT_FONT_SIZE;
}

export function useFetch<T>(fetcher: () => Promise<{ data: T }>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

export function useFetchRaw<T>(fetcher: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}



export function useSettings() {
  const [fontSize, setFontSize] = useState(() =>
    normalizeFontSize(parseInt(localStorage.getItem('font_size') || String(DEFAULT_FONT_SIZE)))
  );
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });


  const updateFontSize = (size: number) => {
    const nextSize = normalizeFontSize(size);
    setFontSize(nextSize);
    localStorage.setItem('font_size', String(nextSize));
    document.documentElement.style.setProperty('--font-size', `${nextSize}px`);
    document.documentElement.style.fontSize = `${nextSize}px`;
  };

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  useEffect(() => {
    document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
    document.documentElement.style.fontSize = `${fontSize}px`;
    document.documentElement.setAttribute('data-theme', theme);
  }, []);

  return {
    fontSize,
    setFontSize: updateFontSize,
    theme,
    toggleTheme,
  };
}
