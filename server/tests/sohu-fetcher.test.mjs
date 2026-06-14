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
    normalizeDate: (v) => v,
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

test('SOHU fetchArticle fetches from m.sohu.com (mobile) for static content', async () => {
  let fetchedUrl = null;
  const articleBody = '\u4e2d'.repeat(600);
  const html = `<html><head>
    <title>Static Sohu title_搜狐</title>
    <meta property="og:release_date" content="2026-06-13 10:51">
  </head><body><article><p>${articleBody}</p><p>返回搜狐，查看更多</p></article></body></html>`;

  const { sohuFetcher } = loadTsModule('../src/services/fetchers/sohu-fetcher.ts', {
    ...baseStubs,
  }, {
    fetch: async (url) => {
      fetchedUrl = url;
      return { ok: true, text: async () => html };
    },
    console: { log: () => {}, warn: () => {} },
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

  assert.equal(fetchedUrl, 'https://m.sohu.com/a/1036003965_121347613');
  assert.match(article.rawContent, /^\u4e2d{600}/);
  assert.equal(article.metadata.extractor, 'sohu:mobile-html');
  assert.equal(article.publishedAt, '2026-06-13 10:51');
});

test('SOHU fetchArticle skips short content', async () => {
  const html = `<html><head><title>Short</title></head><body><article><p>Short</p></article></body></html>`;

  const { sohuFetcher } = loadTsModule('../src/services/fetchers/sohu-fetcher.ts', {
    ...baseStubs,
  }, {
    fetch: async () => ({ ok: true, text: async () => html }),
    console: { log: () => {}, warn: () => {} },
  });

  const result = await sohuFetcher.fetchArticle({
    id: 'job_sohu',
    source_id: 'src_sohu',
    url: 'https://www.sohu.com/a/1036003965_121347613',
    title: 'Short article',
    external_id: '1036003965',
    published_at: null,
    payload_json: null,
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

  assert.equal(result, null);
});

test('SOHU discover uses static HTML blockRenderData only', async () => {
  const blockRenderData = JSON.stringify({
    TPLSomeBlock: {
      param: {
        data: {
          data: [
            { url: '/a/1036338382_121019331', title: 'Test article 1', cover: ['https://img.example.com/1.jpg'] },
            { url: '/a/1036298066_122341610', title: 'Test article 2', cover: [] },
          ],
        },
      },
    },
  });
  const html = `<html><body><script>window.blockRenderData = ${blockRenderData};</script></body></html>`;

  const { sohuFetcher } = loadTsModule('../src/services/fetchers/sohu-fetcher.ts', {
    ...baseStubs,
  }, {
    fetch: async () => ({ ok: true, text: async () => html }),
    console: { log: () => {}, warn: () => {} },
  });

  const discovered = await sohuFetcher.discover({
    id: 'src_sohu',
    type: 'web',
    name: 'SOHU',
    url: 'https://www.sohu.com/xchannel/TURBd01EQXhOVEl6',
    language: 'zh',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(discovered.length, 2);
  assert.equal(discovered[0].title, 'Test article 1');
  assert.equal(discovered[0].payload.imageUrl, 'https://img.example.com/1.jpg');
  assert.equal(discovered[1].title, 'Test article 2');
});

test('SOHU discover filters out non-articles', async () => {
  const blockRenderData = JSON.stringify({
    TPLSomeBlock: {
      param: {
        data: {
          data: [
            { url: '/a/1036338382_121019331', title: 'Real news article title' },
            { url: '/a/1036298066_122341610', title: 'Short' },
            { url: '/a/1036374890_120914498', title: '视频：something' },
            { url: '/a/1036364074_121627717', title: '图片集：photos' },
          ],
        },
      },
    },
  });
  const html = `<html><body><script>window.blockRenderData = ${blockRenderData};</script></body></html>`;

  const { sohuFetcher } = loadTsModule('../src/services/fetchers/sohu-fetcher.ts', {
    ...baseStubs,
  }, {
    fetch: async () => ({ ok: true, text: async () => html }),
    console: { log: () => {}, warn: () => {} },
  });

  const discovered = await sohuFetcher.discover({
    id: 'src_sohu',
    type: 'web',
    name: 'SOHU',
    url: 'https://www.sohu.com/xchannel/TURBd01EQXhOVEl6',
    language: 'zh',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].title, 'Real news article title');
});
