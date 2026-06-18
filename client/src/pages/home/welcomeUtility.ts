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
export function describeWeatherCode(code: number): string {
  if (code === 0) return 'Trời quang';
  if (code >= 1 && code <= 3) return 'Ít mây';
  if (code === 45 || code === 48) return 'Sương mù';
  if (code >= 51 && code <= 57) return 'Mưa phùn';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'Mưa';
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 'Tuyết / Mưa đá';
  if (code >= 95 && code <= 99) return 'Dông';
  return 'Không rõ';
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
  observedAt: string;
}

export function normalizeWeather(current: WeatherApiCurrent): NormalizedWeather {
  return {
    temp: Math.round(current.temperature_2m),
    apparent: Math.round(current.apparent_temperature),
    humidity: Math.round(current.relative_humidity_2m),
    wind: Math.round(current.wind_speed_10m * 10) / 10,
    label: describeWeatherCode(current.weather_code),
    observedAt: current.time ?? '',
  };
}
