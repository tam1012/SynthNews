import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('VOZ rescrape uses shared VOZ fetch helper instead of direct curl fetch', () => {
  const rescrapeSource = readFileSync(resolve(__dirname, '../src/services/rescrape.ts'), 'utf8');
  const helperSource = readFileSync(resolve(__dirname, '../src/services/fetchers/voz-fetch-utils.ts'), 'utf8');

  assert.match(rescrapeSource, /fetchVozThreadHtml/);
  assert.doesNotMatch(rescrapeSource, /curlFetch\(pageUrl/);
  assert.match(helperSource, /scraplingFetchWithFallback/);
  assert.match(helperSource, /solveCloudflare: true/);
});
