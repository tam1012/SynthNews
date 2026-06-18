// ── Hanoi weather endpoint (Open-Meteo, no API key) ──
export const HANOI_WEATHER_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=21.0245&longitude=105.8412&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=Asia%2FHo_Chi_Minh';

// ── Vietnam date/time formatting ──

export interface VietnamDateTime {
  dateText: string;
  timeText: string;
  zoneText: string;
}

const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';

export function formatVietnamDateTime(now: Date): VietnamDateTime {
  const dateFormatter = new Intl.DateTimeFormat('vi-VN', {
    timeZone: VN_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
    timeZone: VN_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return {
    dateText: dateFormatter.format(now),
    timeText: timeFormatter.format(now),
    zoneText: 'GMT+7',
  };
}

// ── WMO Weather Code → Vietnamese label ──

/**
 * Map WMO weather interpretation codes to concise Vietnamese labels.
 * Reference: https://www.nodc.noaa.gov/archive/arc0021/0002199/1.1/data/0-data/HTML/WMO-CODE/WMO4677.HTM
 */
export function describeWeatherCode(code: number): { label: string; emoji: string } {
  if (code === 0) return { label: 'Trời quang', emoji: '☀️' };
  if (code >= 1 && code <= 3) return { label: 'Ít mây', emoji: '⛅' };
  if (code === 45 || code === 48) return { label: 'Sương mù', emoji: '🌫️' };
  if (code >= 51 && code <= 57) return { label: 'Mưa phùn', emoji: '🌦️' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: 'Mưa', emoji: '🌧️' };
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return { label: 'Tuyết / Mưa đá', emoji: '🌨️' };
  if (code >= 95 && code <= 99) return { label: 'Dông', emoji: '⛈️' };
  return { label: 'Không rõ', emoji: '🌡️' };
}

// ── Weather API response normalization ──

export interface WeatherApiCurrent {
  temperature_2m: number;
  relative_humidity_2m: number;
  apparent_temperature: number;
  weather_code: number;
  wind_speed_10m: number;
  time?: string;
}

export interface NormalizedWeather {
  temp: number;
  apparent: number;
  humidity: number;
  wind: number;
  label: string;
  emoji: string;
  observedAt: string;
}

export function normalizeWeather(current: WeatherApiCurrent): NormalizedWeather {
  const { label, emoji } = describeWeatherCode(current.weather_code);
  return {
    temp: Math.round(current.temperature_2m),
    apparent: Math.round(current.apparent_temperature),
    humidity: Math.round(current.relative_humidity_2m),
    wind: Math.round(current.wind_speed_10m * 10) / 10,
    label,
    emoji,
    observedAt: current.time ?? '',
  };
}
