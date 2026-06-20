import { useEffect, useState } from 'react';
import {
  type NormalizedWeather,
  formatVietnamDateTime,
  HANOI_WEATHER_URL,
  normalizeWeather,
} from './welcomeUtility';

const CLOCK_INTERVAL_MS = 60_000;
const WEATHER_REFRESH_MS = 15 * 60_000; // 15 minutes

function useVietnamClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return formatVietnamDateTime(now);
}

function useHanoiWeather() {
  const [weather, setWeather] = useState<NormalizedWeather | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let aborted = false;
    const controller = new AbortController();

    async function fetchWeather() {
      try {
        const res = await fetch(HANOI_WEATHER_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!aborted) {
          setWeather(normalizeWeather(data.current));
          setError(false);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!aborted) setError(true);
      } finally {
        if (!aborted) setLoading(false);
      }
    }

    fetchWeather();

    const intervalId = setInterval(fetchWeather, WEATHER_REFRESH_MS);

    return () => {
      aborted = true;
      controller.abort();
      clearInterval(intervalId);
    };
  }, []);

  return { weather, loading, error } as const;
}

export function ReadmeWelcome() {
  const { dateText, timeText, zoneText } = useVietnamClock();
  const { weather, loading, error } = useHanoiWeather();

  return (
    <div className="welcome-empty-state">
      {/* Live utility card: Vietnam clock + Hanoi weather */}
      <div className="welcome-utility-card">
        <div className="welcome-utility-clock">
          <div className="welcome-utility-zone">Việt Nam · {zoneText}</div>
          <div className="welcome-utility-time">{timeText}</div>
          <div className="welcome-utility-date">{dateText}</div>
        </div>

        <div className="welcome-utility-divider" aria-hidden="true" />

        <div className="welcome-utility-weather">
          {loading ? (
            <div className="welcome-utility-weather-placeholder">
              Đang tải thời tiết Hà Nội…
            </div>
          ) : error || !weather ? (
            <div className="welcome-utility-weather-placeholder welcome-utility-weather-muted">
              Chưa tải được thời tiết Hà Nội
            </div>
          ) : (
            <>
              <div className="welcome-utility-weather-header">Hà Nội</div>
              <div className="welcome-utility-weather-main">
                <span className="welcome-utility-weather-emoji">{weather.emoji}</span>
                <span className="welcome-utility-weather-temp">{weather.temp}°C</span>
                <span className="welcome-utility-weather-label">{weather.label}</span>
              </div>
              <div className="welcome-utility-weather-detail">
                Cảm giác {weather.apparent}°C · Độ ẩm {weather.humidity}% · Gió {weather.wind} km/h
              </div>
              {weather.observedAt && (
                <div className="welcome-utility-weather-updated">
                  Cập nhật {weather.observedAt.slice(11, 16)}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Existing content */}
      <div className="welcome-illustration">
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          {/* Newspaper / reading icon */}
          <rect x="20" y="24" width="80" height="72" rx="6" fill="var(--color-surface-container)" stroke="var(--color-border)" strokeWidth="1.5"/>
          <rect x="30" y="36" width="35" height="4" rx="2" fill="var(--color-accent)" opacity="0.7"/>
          <rect x="30" y="46" width="60" height="3" rx="1.5" fill="var(--color-border)" opacity="0.5"/>
          <rect x="30" y="54" width="55" height="3" rx="1.5" fill="var(--color-border)" opacity="0.4"/>
          <rect x="30" y="62" width="50" height="3" rx="1.5" fill="var(--color-border)" opacity="0.3"/>
          <rect x="30" y="74" width="28" height="14" rx="3" fill="var(--color-surface-container-low)" stroke="var(--color-border-light)" strokeWidth="1"/>
          <rect x="64" y="74" width="26" height="14" rx="3" fill="var(--color-surface-container-low)" stroke="var(--color-border-light)" strokeWidth="1"/>
          {/* AI sparkle */}
          <circle cx="92" cy="32" r="10" fill="var(--color-accent)" opacity="0.12"/>
          <path d="M92 25 L93.5 30 L98 32 L93.5 34 L92 39 L90.5 34 L86 32 L90.5 30 Z" fill="var(--color-accent)" opacity="0.6"/>
        </svg>
      </div>

      <h2 className="welcome-title">Chọn bài viết để đọc</h2>
      <p className="welcome-subtitle">
        Chọn một bài từ danh sách bên trái, hoặc mở tab <strong>Bản tin</strong> để xem tổng hợp gần nhất.
      </p>

      <div className="welcome-features">
        <div className="welcome-feature">
          <span className="welcome-feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg>
          </span>
          <span>RSS, Reddit, VOZ</span>
        </div>
        <div className="welcome-feature">
          <span className="welcome-feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 L13.5 8 L20 9.5 L13.5 11 L12 17 L10.5 11 L4 9.5 L10.5 8 Z"/><path d="M19 15 L19.7 17 L22 17.5 L19.7 18 L19 20 L18.3 18 L16 17.5 L18.3 17 Z"/></svg>
          </span>
          <span>AI dịch</span>
        </div>
        <div className="welcome-feature">
          <span className="welcome-feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          </span>
          <span>Cập nhật 24/7</span>
        </div>
      </div>

      <div className="welcome-kbd-hint">
        <kbd>←</kbd> <kbd>→</kbd> điều hướng bài &nbsp;·&nbsp; <kbd>Esc</kbd> đóng
      </div>
    </div>
  );
}
