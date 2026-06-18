import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTsModule(relativePath) {
  const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
    URL: URL,
    Intl: Intl,
  });
  return moduleContext.exports;
}

// ── HANOI_WEATHER_URL ──

test('HANOI_WEATHER_URL contains Hanoi coordinates and required params', () => {
  const { HANOI_WEATHER_URL } = loadTsModule('../src/pages/home/welcomeUtility.ts');

  assert.ok(HANOI_WEATHER_URL.startsWith('https://api.open-meteo.com/v1/forecast'));
  assert.ok(HANOI_WEATHER_URL.includes('latitude=21.0245'));
  assert.ok(HANOI_WEATHER_URL.includes('longitude=105.8412'));
  assert.ok(HANOI_WEATHER_URL.includes('current='));
  assert.ok(HANOI_WEATHER_URL.includes('temperature_2m'));
  assert.ok(HANOI_WEATHER_URL.includes('relative_humidity_2m'));
  assert.ok(HANOI_WEATHER_URL.includes('apparent_temperature'));
  assert.ok(HANOI_WEATHER_URL.includes('weather_code'));
  assert.ok(HANOI_WEATHER_URL.includes('wind_speed_10m'));
  assert.ok(HANOI_WEATHER_URL.includes('timezone=Asia%2FHo_Chi_Minh'));
});

// ── formatVietnamDateTime ──

test('formatVietnamDateTime converts fixed UTC noon to VN evening time', () => {
  const { formatVietnamDateTime } = loadTsModule('../src/pages/home/welcomeUtility.ts');

  // 2026-06-18T12:00:00Z = 2026-06-18T19:00:00+07:00 in Vietnam
  const fixedDate = new Date('2026-06-18T12:00:00Z');
  const result = formatVietnamDateTime(fixedDate);

  assert.ok(result.timeText.includes('19:'));
  assert.ok(result.dateText.includes('2026') || result.dateText.includes('18'));
  assert.equal(result.zoneText, 'GMT+7');
});

test('formatVietnamDateTime returns all three text fields', () => {
  const { formatVietnamDateTime } = loadTsModule('../src/pages/home/welcomeUtility.ts');

  const result = formatVietnamDateTime(new Date('2026-06-18T00:00:00Z'));

  assert.equal(typeof result.dateText, 'string');
  assert.ok(result.dateText.length > 0);
  assert.equal(typeof result.timeText, 'string');
  assert.ok(result.timeText.length > 0);
  assert.equal(typeof result.zoneText, 'string');
  assert.ok(result.zoneText.length > 0);
});

test('formatVietnamDateTime handles midnight UTC as 7am VN', () => {
  const { formatVietnamDateTime } = loadTsModule('../src/pages/home/welcomeUtility.ts');

  // 2026-01-15T00:00:00Z → VN 07:00
  const result = formatVietnamDateTime(new Date('2026-01-15T00:00:00Z'));
  assert.ok(result.timeText.includes('07:'));
});

// ── describeWeatherCode ──

test('describeWeatherCode maps WMO codes to Vietnamese labels', () => {
  const { describeWeatherCode } = loadTsModule('../src/pages/home/welcomeUtility.ts');

  // Clear (0)
  assert.ok(describeWeatherCode(0).length > 0);
  // Partly cloudy (1-3)
  assert.ok(describeWeatherCode(1).length > 0);
  assert.ok(describeWeatherCode(2).length > 0);
  assert.ok(describeWeatherCode(3).length > 0);
  // Fog (45, 48)
  assert.ok(describeWeatherCode(45).length > 0);
  assert.ok(describeWeatherCode(48).length > 0);
  // Drizzle (51-57)
  assert.ok(describeWeatherCode(51).length > 0);
  assert.ok(describeWeatherCode(53).length > 0);
  assert.ok(describeWeatherCode(55).length > 0);
  assert.ok(describeWeatherCode(56).length > 0);
  assert.ok(describeWeatherCode(57).length > 0);
  // Rain (61-67)
  assert.ok(describeWeatherCode(61).length > 0);
  assert.ok(describeWeatherCode(63).length > 0);
  assert.ok(describeWeatherCode(65).length > 0);
  assert.ok(describeWeatherCode(66).length > 0);
  assert.ok(describeWeatherCode(67).length > 0);
  // Rain showers (80-82)
  assert.ok(describeWeatherCode(80).length > 0);
  assert.ok(describeWeatherCode(81).length > 0);
  assert.ok(describeWeatherCode(82).length > 0);
  // Snow (71, 73, 75, 77, 85, 86)
  assert.ok(describeWeatherCode(71).length > 0);
  assert.ok(describeWeatherCode(73).length > 0);
  assert.ok(describeWeatherCode(75).length > 0);
  assert.ok(describeWeatherCode(77).length > 0);
  assert.ok(describeWeatherCode(85).length > 0);
  assert.ok(describeWeatherCode(86).length > 0);
  // Thunderstorm (95-99)
  assert.ok(describeWeatherCode(95).length > 0);
  assert.ok(describeWeatherCode(96).length > 0);
  assert.ok(describeWeatherCode(99).length > 0);
});

test('describeWeatherCode returns non-empty fallback for unknown codes', () => {
  const { describeWeatherCode } = loadTsModule('../src/pages/home/welcomeUtility.ts');

  // Unknown codes still return a label
  assert.ok(describeWeatherCode(999).length > 0);
  assert.ok(describeWeatherCode(-1).length > 0);
  assert.ok(describeWeatherCode(100).length > 0);
});

// ── normalizeWeather ──

test('normalizeWeather rounds values and maps fields correctly', () => {
  const { normalizeWeather } = loadTsModule('../src/pages/home/welcomeUtility.ts');

  const apiCurrent = {
    temperature_2m: 32.7,
    relative_humidity_2m: 68.3,
    apparent_temperature: 38.9,
    weather_code: 1,
    wind_speed_10m: 12.4,
    time: '2026-06-18T12:00',
  };

  const result = normalizeWeather(apiCurrent);

  assert.equal(result.temp, 33);
  assert.equal(result.apparent, 39);
  assert.equal(result.humidity, 68);
  assert.equal(result.wind, 12.4);
  assert.equal(typeof result.label, 'string');
  assert.ok(result.label.length > 0);
  assert.equal(result.observedAt, '2026-06-18T12:00');
});

test('normalizeWeather handles integer values without change', () => {
  const { normalizeWeather } = loadTsModule('../src/pages/home/welcomeUtility.ts');

  const result = normalizeWeather({
    temperature_2m: 25,
    relative_humidity_2m: 60,
    apparent_temperature: 26,
    weather_code: 0,
    wind_speed_10m: 5,
    time: '2026-06-18T08:00',
  });

  assert.equal(result.temp, 25);
  assert.equal(result.apparent, 26);
  assert.equal(result.humidity, 60);
  assert.equal(result.wind, 5);
});

// ── ReadmeWelcome source contract ──

test('ReadmeWelcome imports welcomeUtility helpers and renders utility card markup', () => {
  const source = readFileSync(resolve(__dirname, '../src/pages/home/ReadmeWelcome.tsx'), 'utf8');

  // Imports from welcomeUtility
  assert.ok(source.includes('from \'./welcomeUtility\'') || source.includes('from "./welcomeUtility"'));
  assert.ok(source.includes('HANOI_WEATHER_URL'));
  assert.ok(source.includes('formatVietnamDateTime'));
  assert.ok(source.includes('normalizeWeather'));

  // Renders the utility card class
  assert.ok(source.includes('welcome-utility-card'));
  assert.ok(source.includes('welcome-utility-clock'));
  assert.ok(source.includes('welcome-utility-weather'));

  // Has loading/error fallback text
  assert.ok(source.includes('Đang tải thời tiết Hà Nội'));
  assert.ok(source.includes('Chưa tải được thời tiết Hà Nội'));

  // Uses React hooks
  assert.ok(source.includes('useEffect'));
  assert.ok(source.includes('useState'));
});
