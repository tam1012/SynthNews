import { useState, useEffect, useCallback } from 'react';

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
  const FONT_SIZES = [12, 14, 16, 18, 20] as const;
  const DEFAULT_FONT_SIZE = 16;

  const [fontSize, setFontSize] = useState(() =>
    parseInt(localStorage.getItem('font_size') || String(DEFAULT_FONT_SIZE))
  );
  const [fontDir, setFontDir] = useState<1 | -1>(() => {
    const saved = localStorage.getItem('font_dir');
    return saved === '-1' ? -1 : 1;
  });
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });


  const updateFontSize = (size: number) => {
    setFontSize(size);
    localStorage.setItem('font_size', String(size));
    document.documentElement.style.setProperty('--font-size', `${size}px`);
    document.documentElement.style.fontSize = `${size}px`;
  };

  /** Ping-pong cycle: 16→18→20→18→16→14→12→14→16… */
  const cycleFontSize = () => {
    const idx = FONT_SIZES.indexOf(fontSize as typeof FONT_SIZES[number]);
    const currentIdx = idx >= 0 ? idx : FONT_SIZES.indexOf(DEFAULT_FONT_SIZE);
    let nextDir = fontDir;

    // Reverse direction at boundaries
    if (currentIdx >= FONT_SIZES.length - 1 && fontDir === 1) nextDir = -1;
    if (currentIdx <= 0 && fontDir === -1) nextDir = 1;

    const nextIdx = currentIdx + nextDir;
    const nextSize = FONT_SIZES[Math.max(0, Math.min(nextIdx, FONT_SIZES.length - 1))];

    setFontDir(nextDir);
    localStorage.setItem('font_dir', String(nextDir));
    updateFontSize(nextSize);
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
    cycleFontSize,
    theme,
    toggleTheme,
  };
}
