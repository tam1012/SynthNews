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
    URL,
    Date,
    Promise,
    process: { env: {} },
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (stubs[name]) return stubs[name];
      throw new Error(`Unexpected require ${name}`);
    },
    ...globals,
  });
  return moduleContext.exports;
}

const trendingHtml = `
  <article class="Box-row">
    <h2><a href="/owner/repo"> owner / repo </a></h2>
    <p>A useful developer tool</p>
    <span itemprop="programmingLanguage">TypeScript</span>
    <a href="/owner/repo/stargazers"> 12,345 </a>
    <span class="d-inline-block float-sm-right">123 stars today</span>
  </article>
`;

test('discover GitHub Trending repositories with metadata payload', async () => {
  const fetchCalls = [];
  const { githubTrendingFetcher } = loadTsModule('../src/services/fetchers/github-trending-fetcher.ts', {
    cheerio,
    '../../lib/utils.js': {
      normalizePublicHttpUrl: (value) => new URL(value).toString(),
      truncate: (value, max) => String(value).slice(0, max),
    },
    './http-utils.js': { BROWSER_UA: 'test-agent', isBlockedHtml: () => false, playwrightFetch: async () => trendingHtml, randomUA: () => 'test-agent' },
    './scrapling-fetch.js': { scraplingFetch: async () => '', scraplingFetchWithFallback: async () => '' },
  }, {
    fetch: async (url) => {
      fetchCalls.push(url);
      return { ok: true, text: async () => trendingHtml };
    },
  });

  const items = await githubTrendingFetcher.discover({
    id: 'src_github',
    type: 'web',
    name: 'GitHub Trending',
    url: 'https://github.com/trending/typescript?since=daily',
    language: 'vi',
    category: null,
    fetch_interval_minutes: 1440,
    parser_config: {},
  });

  assert.equal(fetchCalls[0], 'https://github.com/trending/typescript?since=daily');
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://github.com/owner/repo');
  assert.equal(items[0].title, 'owner/repo');
  assert.equal(items[0].externalId, 'owner/repo');
  assert.equal(items[0].payload.description, 'A useful developer tool');
  assert.equal(items[0].payload.language, 'TypeScript');
  assert.equal(items[0].payload.stars, '12,345');
  assert.equal(items[0].payload.starsToday, '123 stars today');
});

test('fetch GitHub Trending article prefers raw README and preserves trending metadata', async () => {
  const fetchCalls = [];
  const { githubTrendingFetcher } = loadTsModule('../src/services/fetchers/github-trending-fetcher.ts', {
    cheerio,
    '../../lib/utils.js': {
      normalizePublicHttpUrl: (value) => new URL(value).toString(),
      truncate: (value, max) => String(value).slice(0, max),
    },
    './http-utils.js': { BROWSER_UA: 'test-agent', isBlockedHtml: () => false, playwrightFetch: async () => trendingHtml, randomUA: () => 'test-agent' },
    './scrapling-fetch.js': { scraplingFetch: async () => '', scraplingFetchWithFallback: async () => '' },
  }, {
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url === 'https://raw.githubusercontent.com/owner/repo/main/README.md') {
        return { ok: true, text: async () => '# Repo\n\nThis README explains the project in enough detail for a summary. It includes setup notes and feature details.' };
      }
      return { ok: false, text: async () => '' };
    },
  });

  const article = await githubTrendingFetcher.fetchArticle({
    id: 'afj_1',
    source_id: 'src_github',
    url: 'https://github.com/owner/repo',
    title: 'owner/repo',
    external_id: 'owner/repo',
    published_at: '2026-05-05T00:00:00.000Z',
    payload_json: {
      repoName: 'owner/repo',
      repoUrl: 'https://github.com/owner/repo',
      description: 'A useful developer tool',
      language: 'TypeScript',
      stars: '12,345',
      starsToday: '123 stars today',
      discoveredAt: '2026-05-05T00:00:00.000Z',
    },
  }, {
    id: 'src_github',
    type: 'web',
    name: 'GitHub Trending',
    url: 'https://github.com/trending',
    language: 'vi',
    category: null,
    fetch_interval_minutes: 1440,
    parser_config: {},
  });

  assert.equal(fetchCalls[0], 'https://raw.githubusercontent.com/owner/repo/main/README.md');
  assert.equal(article.title, 'owner/repo');
  assert.match(article.rawExcerpt, /123 stars today/);
  assert.match(article.rawContent, /README:/);
  assert.match(article.rawContent, /This README explains/);
  assert.equal(article.metadata.kind, 'github-trending');
  assert.equal(article.metadata.hasReadme, true);
  assert.equal(article.contentHashSeed, 'https://github.com/owner/repo:123 stars today');
});
