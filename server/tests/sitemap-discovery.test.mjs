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
    process: { env: {} },
    Date,
    Map,
    Set,
    exports: moduleContext.exports,
    module: moduleContext,
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
  cheerio,
  '../../lib/utils.js': { normalizePublicHttpUrl: (value) => new URL(value).toString() },
  '../../lib/dateUtils.js': {
    normalizeDate: (value, options = {}) => {
      if (!value) return null;
      let normalized = String(value).trim();
      if (!normalized) return null;
      const tz = options.defaultTimezone || 'Z';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) normalized += tz;
      else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) normalized = normalized.replace(' ', 'T') + tz;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += `T00:00:00${tz}`;
      const date = new Date(normalized);
      if (Number.isNaN(date.getTime())) return null;
      const year = date.getUTCFullYear();
      if (year < 2000 || year > new Date().getUTCFullYear() + 1) return null;
      return date.toISOString();
    },
  },
  './http-utils.js': {
    browserHeaders: () => ({ 'User-Agent': 'test-ua', Accept: 'text/html' }),
    randomUA: () => 'test-ua',
  },
};

test('build sitemap candidates from site origin', () => {
  const { buildSitemapCandidates } = loadTsModule('../src/services/fetchers/sitemap-discovery.ts', baseStubs);
  const candidates = buildSitemapCandidates('https://example.com/world/latest?x=1');

  assert.equal(candidates[0], 'https://example.com/sitemap.xml');
  assert.ok(candidates.includes('https://example.com/news-sitemap.xml'));
  assert.ok(candidates.includes('https://example.com/post-sitemap.xml'));
});

test('parse news sitemap URLs with title and publication date', () => {
  const { parseSitemapUrls } = loadTsModule('../src/services/fetchers/sitemap-discovery.ts', baseStubs);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url>
        <loc>/world/example-story</loc>
        <news:news>
          <news:publication_date>2026-05-12T07:30:00Z</news:publication_date>
          <news:title>Example world story</news:title>
        </news:news>
      </url>
    </urlset>`;

  const entries = parseSitemapUrls(xml, 'https://example.com/sitemap.xml');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, 'https://example.com/world/example-story');
  assert.equal(entries[0].title, 'Example world story');
  assert.equal(entries[0].publishedAt, '2026-05-12T07:30:00.000Z');
});

test('parse sitemap index URLs', () => {
  const { parseSitemapIndexUrls } = loadTsModule('../src/services/fetchers/sitemap-discovery.ts', baseStubs);
  const xml = `<sitemapindex>
    <sitemap><loc>https://example.com/news-sitemap.xml</loc></sitemap>
    <sitemap><loc>/post-sitemap.xml</loc></sitemap>
  </sitemapindex>`;

  const urls = parseSitemapIndexUrls(xml, 'https://example.com/sitemap.xml');

  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://example.com/news-sitemap.xml');
  assert.equal(urls[1], 'https://example.com/post-sitemap.xml');
});

test('discover sitemap articles follows one sitemap index level and dedupes', async () => {
  const { discoverSitemapArticles } = loadTsModule('../src/services/fetchers/sitemap-discovery.ts', baseStubs);
  const responses = new Map([
    ['https://example.com/sitemap.xml', `<sitemapindex><sitemap><loc>https://example.com/news-sitemap.xml</loc></sitemap></sitemapindex>`],
    ['https://example.com/news-sitemap.xml', `<urlset>
      <url><loc>https://example.com/2026/05/12/story-one</loc><lastmod>2026-05-12T00:00:00Z</lastmod></url>
      <url><loc>https://example.com/2026/05/12/story-one</loc><lastmod>2026-05-12T00:00:00Z</lastmod></url>
    </urlset>`],
  ]);
  const fetcher = async (url) => ({
    ok: responses.has(url),
    status: responses.has(url) ? 200 : 404,
    text: async () => responses.get(url) || '',
  });

  const articles = await discoverSitemapArticles(
    { id: 'src_1', url: 'https://example.com/' },
    fetcher,
    { candidates: ['https://example.com/sitemap.xml'], limit: 10 }
  );

  assert.equal(articles.length, 1);
  assert.equal(articles[0].sourceId, 'src_1');
  assert.equal(articles[0].url, 'https://example.com/2026/05/12/story-one');
  assert.equal(articles[0].payload.discovery, 'sitemap');
  assert.equal(articles[0].payload.sitemapUrl, 'https://example.com/news-sitemap.xml');
});
