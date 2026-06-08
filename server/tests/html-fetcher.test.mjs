import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const requireFromTest = createRequire(import.meta.url);
const cheerio = requireFromTest('cheerio');

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
      if (name === './scrapling-fetch.js') {
        return {
          scraplingFetch: async () => { throw new Error('Scrapling unavailable'); },
          scraplingFetchWithFallback: async (url, scraplingOpts, playwrightOpts) => {
            const httpUtils = stubs['./http-utils.js'];
            return httpUtils.playwrightFetch(url, playwrightOpts);
          },
        };
      }
      if (stubs[name]) return stubs[name];
      throw new Error(`Unexpected require ${name}`);
    },
    ...globals,
  });
  return moduleContext.exports;
}

const baseStubs = {
  cheerio,
  '../../lib/utils.js': {
    normalizePublicHttpUrl: (value) => new URL(value).toString(),
    normalizePublicHttpUrlWithDns: async (value) => new URL(value).toString(),
    truncate: (value, length) => value.slice(0, length),
    sleep: async () => {},
  },
  '../../lib/promoFilter.js': { matchPromoKeyword: () => null },
  './http-utils.js': {
    browserHeaders: (ua) => ({ 'User-Agent': ua }),
    isBlockedHtml: () => false,
    randomUA: () => 'random-agent',
    playwrightFetch: async () => '',
  },
  './article-writer.js': { insertArticleIfNew: async () => true },
  './selector-learning.js': { learnSelectorProfileFromHtml: async () => null },
  './hosted-fetch.js': {
    hostedFetch: async () => { throw new Error('Hosted fetch unavailable'); },
    shouldUseHostedFetch: () => false,
    hasHostedFetchKey: () => false,
    HostedFetchUnavailableError: class HostedFetchUnavailableError extends Error {},
  },
  './structured-data.js': { extractStructuredArticle: () => null },
  './archive-fetch.js': {
    archiveTodayFetch: async () => '',
    shouldUseArchiveFallback: () => false,
  },
  './selector-profile.js': {
    extractWithSelectorProfile: () => ({ title: '', content: '', imageUrl: null, publishedAt: null, matchedSelector: null }),
    getDomainFromUrl: () => null,
    getSourceProfile: async () => null,
    isExtractionUsable: () => false,
    recordProfileFailure: async () => {},
    recordProfileSuccess: async () => {},
    rowToSelectorProfile: () => null,
    saveSourceProfile: async () => null,
  },
  './sitemap-discovery.js': { discoverSitemapArticles: async () => [] },
  '../../lib/dateUtils.js': {
    getDefaultTimezoneForLanguage: () => 'Z',
    normalizeDate: (v) => v,
  },
};

test('HTML discover uses heuristic article links when configured selector finds none', async () => {
  const { htmlFetcher } = loadTsModule('../src/services/fetchers/html-fetcher.ts', baseStubs, {
    fetch: async () => ({
      ok: true,
      text: async () => `<html><body>
        <a href="/tag/world">World tag</a>
        <a href="/2026/05/12/important-world-story-with-long-slug">Important world story with a long enough title</a>
        <a href="https://social.example/share">Share</a>
      </body></html>`,
    }),
  });

  const items = await htmlFetcher.discover({
    id: 'src_web',
    type: 'web',
    name: 'Example',
    url: 'https://example.com/',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: { articleLinkSelector: '.missing-link' },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/2026/05/12/important-world-story-with-long-slug');
  assert.equal(items[0].payload.discovery, 'web-heuristic');
});

test('HTML discover allows sitemap-only web sources', async () => {
  const { htmlFetcher } = loadTsModule('../src/services/fetchers/html-fetcher.ts', {
    ...baseStubs,
    './sitemap-discovery.js': {
      discoverSitemapArticles: async () => [{
        sourceId: 'src_web',
        url: 'https://example.com/2026/05/12/sitemap-story',
        title: 'Sitemap story',
        externalId: 'https://example.com/2026/05/12/sitemap-story',
        publishedAt: '2026-05-12T00:00:00.000Z',
        payload: { discovery: 'sitemap', sitemapUrl: 'https://example.com/sitemap.xml', rawExcerpt: '', rawContent: '' },
      }],
    },
  }, {
    fetch: async () => ({ ok: true, text: async () => '<html><body>No links</body></html>' }),
  });

  const items = await htmlFetcher.discover({
    id: 'src_web',
    type: 'web',
    name: 'Example',
    url: 'https://example.com/',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: { discoverSitemap: true },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/2026/05/12/sitemap-story');
  assert.equal(items[0].payload.discovery, 'sitemap');
});
