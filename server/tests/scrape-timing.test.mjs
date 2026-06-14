import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTiming() {
  const source = readFileSync(resolve(__dirname, '../src/lib/scrapeTiming.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, { exports: moduleContext.exports, module: moduleContext, process: { env: {} } });
  return moduleContext.exports;
}

test('normalizeFetchIntervalMinutes keeps minute precision', () => {
  const { normalizeFetchIntervalMinutes } = loadTiming();

  assert.equal(normalizeFetchIntervalMinutes(15), 15);
  assert.equal(normalizeFetchIntervalMinutes(30), 30);
  assert.equal(normalizeFetchIntervalMinutes(90), 90);
  assert.equal(normalizeFetchIntervalMinutes(0), 60);
  assert.equal(normalizeFetchIntervalMinutes('bad'), 60);
});

test('success delay uses minute interval and deterministic jitter', () => {
  const { computeScrapeNextDelayMinutes } = loadTiming();

  assert.equal(computeScrapeNextDelayMinutes(30, false, () => 0.5), 30);
  assert.equal(computeScrapeNextDelayMinutes(90, false, () => 0.5), 90);
});

test('error delay doubles minute interval and caps at 24 hours', () => {
  const { computeScrapeNextDelayMinutes } = loadTiming();

  assert.equal(computeScrapeNextDelayMinutes(30, true, () => 0.5), 60);
  assert.equal(computeScrapeNextDelayMinutes(800, true, () => 0.5), 1440);
});

test('failure backoff uses minutes without rounding to hours', () => {
  const { computeScrapeFailureBackoffMinutes } = loadTiming();

  assert.equal(computeScrapeFailureBackoffMinutes(15, 1), 15);
  assert.equal(computeScrapeFailureBackoffMinutes(15, 2), 30);
  assert.equal(computeScrapeFailureBackoffMinutes(90, 1), 90);
});

test('source scrape timeout is shared for cron and manual routes', () => {
  const { getSourceScrapeTimeoutMs } = loadTiming();

  assert.equal(getSourceScrapeTimeoutMs({ name: 'Reddit Startups', url: 'https://reddit.com/r/startups' }), 180_000);
  assert.equal(getSourceScrapeTimeoutMs({ name: 'VOZ Phan mem', url: 'https://voz.vn/f/phan-mem.13/index.rss' }), 600_000);
  assert.equal(getSourceScrapeTimeoutMs({ name: 'AP TopNews', url: 'https://rsshub.example/ap' }), 90_000);
  assert.equal(getSourceScrapeTimeoutMs({ name: 'Any', url: 'https://example.com' }, { SOURCE_SCRAPE_TIMEOUT_MS: '120000' }), 120_000);
});
