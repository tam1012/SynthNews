import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('admin health response includes deploy, runtime, and public check groups', () => {
  const source = readFileSync(resolve(__dirname, '../src/routes/health.ts'), 'utf8');

  assert.match(source, /getDeployInfo/);
  assert.match(source, /getRuntimeInfo/);
  assert.match(source, /getPublicChecks/);
  assert.match(source, /deploy,/);
  assert.match(source, /runtime,/);
  assert.match(source, /publicChecks,/);
});

test('admin health trigger endpoints lock singleton jobs and run queue workers immediately', () => {
  const source = readFileSync(resolve(__dirname, '../src/routes/health.ts'), 'utf8');

  assert.match(source, /triggerLockedJobInBackground/);
  assert.match(source, /triggerQueueWorkerInBackground/);
  assert.match(source, /triggerLockedJobInBackground\('scrape', runScrapeJob\)/);
  assert.match(source, /triggerQueueWorkerInBackground\('article-fetch', runArticleFetchJob\)/);
  assert.match(source, /triggerQueueWorkerInBackground\('summarize', runSummarizeJob\)/);
  assert.match(source, /triggerLockedJobInBackground\('digest', runDigestJob\)/);
  assert.match(source, /already running/);
});

test('admin health response includes pipeline diagnostics', () => {
  const source = readFileSync(resolve(__dirname, '../src/routes/health.ts'), 'utf8');

  assert.match(source, /oldest_discovered_age_minutes/);
  assert.match(source, /topFetchErrors/);
  assert.match(source, /topSummaryErrors/);
  assert.match(source, /lowYieldSources/);
});
