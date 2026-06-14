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
    URL,
    exports: moduleContext.exports,
    module: moduleContext,
  });
  return moduleContext.exports;
}

test('select source fetcher by URL specialization before generic source type', () => {
  const { getFetcherKeyForSource } = loadTsModule('../src/services/fetchers/registry.ts');

  assert.equal(getFetcherKeyForSource({ type: 'rss', url: 'https://www.reddit.com/r/LocalLLaMA/.rss' }), 'reddit');
  assert.equal(getFetcherKeyForSource({ type: 'rss', url: 'https://voz.vn/forums/chuyen-tro-linh-tinh.17/index.rss' }), 'voz');
  assert.equal(getFetcherKeyForSource({ type: 'rss', url: 'https://example.com/feed.xml' }), 'rss');
  assert.equal(getFetcherKeyForSource({ type: 'web', url: 'https://github.com/trending' }), 'github-trending');
  assert.equal(getFetcherKeyForSource({ type: 'web', url: 'https://news.qq.com/ch/news' }), 'qq-news');
  assert.equal(getFetcherKeyForSource({ type: 'web', url: 'https://i.news.qq.com/web_feed/getHotModuleList?channel_id=news_news_top' }), 'qq-news');
  assert.equal(getFetcherKeyForSource({ type: 'web', url: 'https://example.com' }), 'html');
});

test('throw clear error when no fetcher can handle a source', () => {
  const { getFetcherKeyForSource } = loadTsModule('../src/services/fetchers/registry.ts');

  assert.throws(
    () => getFetcherKeyForSource({ type: 'unknown', url: 'https://example.com/custom' }),
    /No fetcher registered/
  );
});

test('registry resolves by SourceFetcher canHandle contract', () => {
  const { getFetcherForSource } = loadTsModule('../src/services/fetchers/registry.ts');
  const fetchers = [
    { key: 'first', canHandle: () => false, fetch: async () => ({}) },
    { key: 'match', canHandle: (source) => source.type === 'custom', fetch: async () => ({}) },
  ];

  const fetcher = getFetcherForSource({ type: 'custom', url: 'https://example.com' }, fetchers);

  assert.equal(fetcher.key, 'match');
});
