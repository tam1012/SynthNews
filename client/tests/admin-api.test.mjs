import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadApiModule(fetchImpl) {
  const source = readFileSync(resolve(__dirname, '../src/services/api.ts'), 'utf8');
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
    fetch: fetchImpl,
    localStorage: {
      getItem: () => 'admin-token',
      setItem: () => {},
    },
    window: {
      prompt: () => '',
    },
    URLSearchParams,
    require: (name) => {
      if (name === './apiCache') {
        return {
          getCachePolicy: () => ({ cacheable: false, ttlMs: 0 }),
          makeApiCacheKey: (path) => path,
        };
      }
      if (name === './persistentCache') {
        return {
          loadPersistentApiCache: () => null,
          markPersistentData: (data) => data,
          savePersistentApiCache: () => {},
        };
      }
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('admin API can trigger article fetch worker', async () => {
  const calls = [];
  const { api } = loadApiModule(async (url, options) => {
    calls.push({ url, options });
    return {
      json: async () => ({ success: true, data: { message: 'ok' } }),
    };
  });

  await api.triggerFetchArticles();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/health/trigger/fetch-articles');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer admin-token');
});

test('article search API serializes date, source, and feed filters', async () => {
  const calls = [];
  const { api } = loadApiModule(async (url, options) => {
    calls.push({ url, options });
    return {
      json: async () => ({ success: true, data: [] }),
    };
  });

  await api.searchArticles('gemini', {
    limit: 20,
    date: '2026-05-29',
    sourceId: 'src_1',
    feedTab: 'tech',
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url, 'https://synthnews.local');
  assert.equal(url.pathname, '/api/articles/search');
  assert.equal(url.searchParams.get('q'), 'gemini');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.get('date'), '2026-05-29');
  assert.equal(url.searchParams.get('sourceId'), 'src_1');
  assert.equal(url.searchParams.get('feedTab'), 'tech');
});

test('digest search API serializes query, date, and limit', async () => {
  const calls = [];
  const { api } = loadApiModule(async (url) => {
    calls.push({ url });
    return {
      json: async () => ({ success: true, data: [] }),
    };
  });

  assert.equal(typeof api.searchDigests, 'function');
  await api.searchDigests('bản tin', { date: '2026-05-29', limit: 10 });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url, 'https://synthnews.local');
  assert.equal(url.pathname, '/api/digests/search');
  assert.equal(url.searchParams.get('q'), 'bản tin');
  assert.equal(url.searchParams.get('date'), '2026-05-29');
  assert.equal(url.searchParams.get('limit'), '10');
});
