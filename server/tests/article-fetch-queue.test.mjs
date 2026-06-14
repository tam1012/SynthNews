import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTsModule(relativePath, stubs = {}) {
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
    URL,
    require: (name) => {
      if (stubs[name]) return stubs[name];
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('build discovered article job row with normalized public URL and discovered status', () => {
  const { buildArticleFetchJobRow } = loadTsModule('../src/services/article-fetch-queue.ts', {
    '../lib/utils.js': {
      generateId: (prefix) => `${prefix}_test`,
      normalizePublicHttpUrl: (url) => new URL(url).toString(),
    },
    '../lib/promoFilter.js': { matchPromoKeyword: () => null },
    './fetchers/blocklist.js': { getBlocklistMatch: async () => null, recordBlocklistHit: async () => {} },
    './fetchers/fetch-job-errors.js': { classifyFetchJobError: () => ({ type: 'unknown', retryable: true, httpStatus: null }) },
    '../db/index.js': {},
  });

  const row = buildArticleFetchJobRow({
    sourceId: 'src_1',
    url: 'https://example.com/post',
    title: ' Example ',
    externalId: 'guid-1',
    publishedAt: '2026-05-04T00:00:00.000Z',
    payload: { rawExcerpt: 'excerpt' },
  });

  assert.equal(row.id, 'afj_test');
  assert.equal(row.source_id, 'src_1');
  assert.equal(row.url, 'https://example.com/post');
  assert.equal(row.title, 'Example');
  assert.equal(row.status, 'discovered');
  assert.equal(row.retry_count, 0);
  assert.equal(row.last_error, null);
  assert.deepEqual(row.payload_json, { rawExcerpt: 'excerpt' });
});

test('claim pending article fetch jobs uses FOR UPDATE SKIP LOCKED', () => {
  const { buildClaimArticleFetchJobsSql } = loadTsModule('../src/services/article-fetch-queue.ts', {
    '../lib/utils.js': {},
    '../lib/promoFilter.js': { matchPromoKeyword: () => null },
    './fetchers/blocklist.js': { getBlocklistMatch: async () => null, recordBlocklistHit: async () => {} },
    './fetchers/fetch-job-errors.js': { classifyFetchJobError: () => ({ type: 'unknown', retryable: true, httpStatus: null }) },
    '../db/index.js': {},
  });
  const statement = buildClaimArticleFetchJobsSql(7);

  assert.match(statement.sql, /status = 'discovered'/);
  assert.match(statement.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(statement.sql, /SET status = 'fetching'/);
  assert.match(statement.sql, /ORDER BY created_at ASC/);
  assert.deepEqual(Array.from(statement.params), [7]);
});

test('reset retryable article fetch jobs respects retry cap', () => {
  const { buildResetRetryableArticleFetchJobsSql, MAX_ARTICLE_FETCH_RETRIES } = loadTsModule('../src/services/article-fetch-queue.ts', {
    '../lib/utils.js': {},
    '../lib/promoFilter.js': { matchPromoKeyword: () => null },
    './fetchers/blocklist.js': { getBlocklistMatch: async () => null, recordBlocklistHit: async () => {} },
    './fetchers/fetch-job-errors.js': { classifyFetchJobError: () => ({ type: 'unknown', retryable: true, httpStatus: null }) },
    '../db/index.js': {},
  });
  const statement = buildResetRetryableArticleFetchJobsSql(15);

  assert.equal(MAX_ARTICLE_FETCH_RETRIES, 3);
  assert.match(statement.sql, /status = 'failed'/);
  assert.match(statement.sql, /retry_count < \$1/);
  assert.match(statement.sql, /status = 'discovered'/);
  assert.deepEqual(Array.from(statement.params), [3, 15]);
});

test('short-content rescue query targets skipped RSS and web articles only', () => {
  const { buildFindShortContentArticlesSql } = loadTsModule('../src/services/article-fetch-queue.ts', {
    '../lib/utils.js': {},
    '../lib/promoFilter.js': { matchPromoKeyword: () => null },
    './fetchers/blocklist.js': { getBlocklistMatch: async () => null, recordBlocklistHit: async () => {} },
    './fetchers/fetch-job-errors.js': { classifyFetchJobError: () => ({ type: 'unknown', retryable: true, httpStatus: null }) },
    '../db/index.js': {},
  });
  const statement = buildFindShortContentArticlesSql(15, 500);

  assert.match(statement.sql, /summary_status = 'skipped'/);
  assert.match(statement.sql, /source content too short/);
  assert.match(statement.sql, /GREATEST\(length\(coalesce\(a\.raw_content/);
  assert.match(statement.sql, /s\.type IN \('rss', 'web'\)/);
  assert.deepEqual(Array.from(statement.params), [500, 15]);
});

test('requeue short-content articles stores rescue article id in fetch job payload', async () => {
  const insertedPayloads = [];
  const { requeueShortContentArticles } = loadTsModule('../src/services/article-fetch-queue.ts', {
    '../db/index.js': {
      getMany: async () => [{
        id: 'art_1',
        source_id: 'src_1',
        url: 'https://example.com/post',
        title: 'Example title',
        external_id: 'guid-1',
        published_at: '2026-05-09T00:00:00.000Z',
        author: 'Author',
        raw_excerpt: '',
        raw_content: '',
        image_url: null,
      }],
      query: async (_sql, params) => {
        insertedPayloads.push(params[6]);
        return { rowCount: 1 };
      },
    },
    '../lib/utils.js': {
      generateId: (prefix) => `${prefix}_test`,
      normalizePublicHttpUrl: (url) => url,
    },
    '../lib/promoFilter.js': { matchPromoKeyword: () => null },
    './fetchers/blocklist.js': { getBlocklistMatch: async () => null, recordBlocklistHit: async () => {} },
    './fetchers/fetch-job-errors.js': { classifyFetchJobError: () => ({ type: 'unknown', retryable: true, httpStatus: null }) },
  });

  const result = await requeueShortContentArticles(15, 500);

  assert.equal(result.checked, 1);
  assert.equal(result.enqueued, 1);
  assert.equal(insertedPayloads[0].rescueArticleId, 'art_1');
});
