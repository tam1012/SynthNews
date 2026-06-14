import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadScheduler(stubs = {}) {
  const source = readFileSync(resolve(__dirname, '../src/jobs/scheduler.ts'), 'utf8');
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
    process: { env: {}, argv: [] },
    console,
    setTimeout,
    clearTimeout,
    Date,
    URL,
    require: (name) => {
      if (stubs[name]) return stubs[name];
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

const schedulerStubs = {
  'node-cron': { default: { schedule: () => undefined }, schedule: () => undefined },
  '../db/index.js': { getMany: async () => [], query: async () => ({ rowCount: 0 }), getOne: async () => null },
  '../services/scraper.js': { scrapeSource: async () => ({ itemsFound: 0, itemsInserted: 0, errors: [] }), retryRedditComments: async () => ({ checked: 0, fixed: 0 }) },
  '../services/summarizer.js': { summarizePendingArticles: async () => ({ processed: 0, succeeded: 0, failed: 0 }), generateDigest: async () => null },
  '../lib/utils.js': { generateId: () => 'id_test', sleep: async () => undefined },
  '../services/rescrape.js': { rescrapeArticle: async () => undefined, runForumRescrapeJob: async () => ({ updated: 0 }) },
  '../services/fetchers/registry.js': { getFetcherForSource: () => ({ key: 'stub', fetchArticle: async () => null }) },
  '../services/fetchers/index.js': { sourceFetchers: [] },
  '../services/fetchers/article-writer.js': { insertArticleIfNew: async () => undefined, validateArticleContent: () => undefined },
  '../services/article-fetch-queue.js': {
    buildResetRetryableArticleFetchJobsSql: () => ({ sql: '', params: [] }),
    buildResetStuckArticleFetchJobsSql: () => ({ sql: '', params: [] }),
    claimArticleFetchJobs: async () => [],
    enqueueDiscoveredArticles: async () => 0,
    markArticleFetchJobDone: async () => undefined,
    markArticleFetchJobFailed: async () => undefined,
    requeueShortContentArticles: async () => ({ checked: 0, enqueued: 0 }),
  },
  '../lib/summaryRetryPolicy.js': {
    buildResetRetryableFailedSummariesSql: () => ({ sql: '', params: [] }),
    buildResetStuckProcessingSummariesSql: () => ({ sql: '', params: [] }),
  },
  '../lib/jobLock.js': { runWithJobLock: async (_name, fn) => fn() },
  '../lib/scrapeTiming.js': {
    computeScrapeNextDelayMinutes: () => 60,
    computeScrapeFailureBackoffMinutes: () => 60,
    getSourceScrapeTimeoutMs: () => 90_000,
  },
  '../services/fetchers/fetch-job-errors.js': { classifyFetchJobError: () => ({ type: 'unknown', retryable: true, httpStatus: null }), buildNullArticleSkipReason: () => 'skipped' },
};

test('article fetch jobs have bounded per-job timeout policy', () => {
  const { getArticleFetchTimeoutMs } = loadScheduler(schedulerStubs);

  assert.equal(getArticleFetchTimeoutMs({ url: 'https://www.yahoo.com/finance/article.html' }), 240_000);
  assert.equal(getArticleFetchTimeoutMs({ url: 'https://www.reuters.com/world/story' }), 360_000);
});

test('article fetch job runner wraps each fetcher call with timeout', () => {
  const source = readFileSync(resolve(__dirname, '../src/jobs/scheduler.ts'), 'utf8');

  assert.match(source, /withTimeout\(\s*fetcher\.fetchArticle\(job, source\)/);
  assert.match(source, /getArticleFetchTimeoutMs\(job\)/);
});
