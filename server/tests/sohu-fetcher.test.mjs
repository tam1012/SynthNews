import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTsModule(relativePath, stubs = {}, globals = {}) {
  const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    AbortSignal: { timeout: () => undefined },
    exports: moduleContext.exports,
    module: moduleContext,
    process: { env: {} },
    URL,
    require: (name) => {
      if (stubs[name]) return stubs[name];
      throw new Error(`Unexpected require ${name}`);
    },
    ...globals,
  });
  return moduleContext.exports;
}

const baseStubs = {
  '../../lib/utils.js': {
    normalizePublicHttpUrlWithDns: async (value) => new URL(value).toString(),
    truncate: (value, max) => String(value).slice(0, max),
  },
  '../../lib/dateUtils.js': {
    getDefaultTimezoneForLanguage: () => '+08:00',
  },
  './article-writer.js': {
    insertArticleIfNew: async () => true,
  },
  './http-utils.js': {
    browserHeaders: (ua) => ({ 'User-Agent': ua }),
    randomUA: () => 'test-agent',
    isWorkerProxyConfigured: () => false,
    shouldSkipWorkerProxy: () => false,
    workerProxyFetch: async () => ({ ok: false, body: '' }),
    WorkerProxyUnavailableError: class WorkerProxyUnavailableError extends Error {},
    isBlockedHtml: () => false,
  },
};

test('SOHU fetchArticle parses static article HTML before using Scrapling', async () => {
  let fetchCount = 0;
  let scraplingCalled = false;
  const articleBody = '\u4e2d'.repeat(191);
  const html = `<html><head>
    <title>Static Sohu title_搜狐</title>
    <meta property="og:release_date" content="2026-06-13 10:51">
  </head><body><article><p>${articleBody}</p><p>返回搜狐，查看更多</p></article></body></html>`;

  const { sohuFetcher } = loadTsModule('../src/services/fetchers/sohu-fetcher.ts', {
    ...baseStubs,
    './scrapling-fetch.js': {
      scraplingFetch: async () => {
        scraplingCalled = true;
        throw new Error('Scrapling should not be called for static Sohu article HTML');
      },
    },
  }, {
    fetch: async () => {
      fetchCount++;
      return { ok: true, text: async () => html };
    },
  });

  const article = await sohuFetcher.fetchArticle({
    id: 'job_sohu',
    source_id: 'src_sohu',
    url: 'https://www.sohu.com/a/1036003965_121347613',
    title: 'Queued Sohu title',
    external_id: '1036003965',
    published_at: null,
    payload_json: { imageUrl: 'https://example.com/image.png' },
  }, {
    id: 'src_sohu',
    type: 'web',
    name: 'SOHU',
    url: 'https://news.sohu.com/',
    language: 'zh',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(fetchCount, 1);
  assert.equal(scraplingCalled, false);
  assert.match(article.rawContent, /^\u4e2d{191}/);
  assert.equal(article.metadata.extractor, 'sohu:static-html');
  assert.equal(article.publishedAt, '2026-06-13 10:51');
});
