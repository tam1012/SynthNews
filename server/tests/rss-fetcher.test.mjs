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

let currentVmProcess = null;

function loadTsModule(relativePath, stubs = {}, globals = {}) {
  currentVmProcess = globals.process || { env: {} };
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
      if (name === './scrapling-fetch.js') {
        return {
          scraplingFetch: async () => { throw new Error('Scrapling unavailable'); },
          scraplingFetchWithFallback: async (url, scraplingOpts, playwrightOpts) => {
            const httpUtils = stubs['./http-utils.js'];
            return httpUtils.playwrightFetch(url, playwrightOpts);
          },
          getScraplingProxyForUrl: () => undefined,
          isResidentialProxyConfigured: () => false,
        };
      }
      throw new Error(`Unexpected require ${name}`);
    },
    ...globals,
  });
  return moduleContext.exports;
}

const baseStubs = {
  'rss-parser': { default: class Parser { async parseString() { return { items: [] }; } } },
  cheerio,
  entities: { decodeHTML: (value) => value },
  '@mozilla/readability': { Readability: class { parse() { return null; } } },
  jsdom: { JSDOM: class { constructor() { this.window = { document: {}, close() {} }; } } },
  '../../lib/utils.js': {
    normalizePublicHttpUrl: (value) => new URL(value).toString(),
    normalizePublicHttpUrlWithDns: async (value) => new URL(value).toString(),
    truncate: (value) => value,
    sleep: async () => {},
  },
  './http-utils.js': {
    BROWSER_UA: 'test-agent',
    GOOGLEBOT_UA: 'googlebot-agent',
    browserHeaders: (ua) => ({ 'User-Agent': ua }),
    randomUA: () => 'random-agent',
    playwrightFetch: async () => '',
    isBlockedHtml: () => false,
    isWorkerProxyConfigured: () => false,
    shouldSkipWorkerProxy: () => false,
    workerProxyFetch: async () => ({ ok: false }),
    cookieAwareFetch: async () => ({ ok: false, status: 500, body: '' }),
  },
  './registry.js': {
    isMsnUrl: () => false,
  },
  './msn-fetcher.js': {
    fetchMsnArticleByUrl: async () => null,
    extractMsnArticleId: () => null,
    extractMsnGemId: () => null,
  },
  './article-writer.js': { insertArticleIfNew: async () => true, MIN_ARTICLE_TEXT_LENGTH: 500 },
  '../../lib/promoFilter.js': { matchPromoKeyword: () => null },
  './sitemap-discovery.js': { discoverSitemapArticles: async () => [] },
  './hosted-fetch.js': {
    hostedFetch: async () => { throw new Error('Hosted fetch unavailable'); },
    shouldUseHostedFetch: () => false,
    hasHostedFetchKey: () => false,
    isDataDomeHost: () => false,
    HostedFetchUnavailableError: class HostedFetchUnavailableError extends Error {},
  },
  './structured-data.js': { extractStructuredArticle: () => null },
  './archive-fetch.js': {
    archiveTodayFetch: async () => '',
    shouldUseArchiveFallback: () => false,
  },
  './selector-learning.js': { learnSelectorProfileFromHtml: async () => null },
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
  './blocklist.js': {
    isBlockedUrl: async (url) => {
      const env = currentVmProcess?.env || {};
      const domains = (env.BLOCKED_GOOGLE_NEWS_PUBLISHER_DOMAINS || '').split(',');
      return domains.some(d => d && url.includes(d));
    },
    getBlocklistMatch: async (url) => {
      const env = currentVmProcess?.env || {};
      const domains = (env.BLOCKED_GOOGLE_NEWS_PUBLISHER_DOMAINS || '').split(',');
      const matched = domains.find(d => d && url.includes(d));
      return matched ? { id: 'test_blk', pattern: matched, type: 'domain', reason: 'env override', is_enabled: true } : null;
    },
    recordBlocklistHit: async () => {},
  },
  '../../lib/dateUtils.js': {
    getDefaultTimezoneForLanguage: () => 'Z',
    normalizeDate: (v) => v,
  },
};

const guardianStyleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Guardian</title>
    <item>
      <title>World news live</title>
      <link>https://www.theguardian.com/world/live/2026/may/07/example</link>
      <guid isPermaLink="false">guardian/example</guid>
      <pubDate>Thu, 07 May 2026 09:30:00 GMT</pubDate>
      <description><![CDATA[<p>Live coverage with <strong>updates</strong>.</p>]]></description>
      <enclosure url="https://media.guim.co.uk/image.jpg" type="image/jpeg" />
      <media:content url="https://media.guim.co.uk/image.jpg" width="140" height="84" />
    </item>
  </channel>
</rss>`;

const googleNewsRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Decoded Google News story</title>
      <link>https://news.google.com/rss/articles/CBMi-test?oc=5</link>
      <guid isPermaLink="false">google/example</guid>
      <description>Google News excerpt</description>
    </item>
  </channel>
</rss>`;

function articleHtml(title, phrase) {
  return `<html><body><article><h1>${title}</h1><p>${phrase.repeat(40)}</p></article></body></html>`;
}

const malformedHackerNewsRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <item>
      <title><![CDATA[Powering up a module from the IBM 604]]></title>
      <description><![CDATA[
        <p>Article URL: <a href="https://www.righto.com/2026/06/ibm-604-thyraton-tube-module.html">https://www.righto.com/2026/06/ibm-604-thyraton-tube-module.html</a></p>
        <p>Comments URL: <a href="https://news.ycombinator.com/item?id=48436819">https://news.ycombinator.com/item?id=48436819</a></p>
      ]]></description>
      <pubDate>Sun, 07 Jun 2026 17:18:12 +0000</pubDate>
      <link>https://www.righto.com/2026/06/ibm-604-thyraton-tube-module.htmlelpockohttps://news.ycombinator.com/item?id=48436819https%3A%2F%2Fnews.ycombinator.com%2Fitem%3Fid%3D48436819</link>
      <dc:creator>elpocko</dc:creator>
      <guid isPermaLink="false">https://news.ycombinator.com/item?id=48436819</guid>
    </item>
  </channel>
</rss>`;

test('RSS fetcher falls back to tolerant item parsing when strict parser rejects feed XML', async () => {
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    'rss-parser': {
      default: class StrictParser {
        async parseString() {
          throw new Error('Attribute without value Line: 13 Column: 5 Char: /');
        }
      },
    },
  }, {
    fetch: async () => ({ ok: true, text: async () => guardianStyleRss }),
  });

  const items = await rssFetcher.discover({
    id: 'src_guardian',
    type: 'rss',
    name: 'The Guardian',
    url: 'https://www.theguardian.com/international/rss',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'World news live');
  assert.equal(items[0].url, 'https://www.theguardian.com/world/live/2026/may/07/example');
  assert.equal(items[0].externalId, 'guardian/example');
  assert.equal(items[0].payload.rawExcerpt, 'Live coverage with updates.');
  assert.equal(items[0].payload.imageUrl, 'https://media.guim.co.uk/image.jpg');
});

test('RSS discover decodes Google News URLs before enqueueing', async () => {
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    'rss-parser': {
      default: class Parser {
        async parseString() {
          return {
            items: [{
              title: 'Decoded Google News story',
              link: 'https://news.google.com/rss/articles/CBMi-test?oc=5',
              guid: 'google/example',
              contentSnippet: 'Google News excerpt',
            }],
          };
        }
      },
    },
    'google-news-url-decoder': {
      GoogleDecoder: class {
        async decode() {
          return { status: true, decoded_url: 'https://www.apnews.com/world/example' };
        }
      },
    },
  }, {
    fetch: async () => ({ ok: true, text: async () => googleNewsRss }),
  });

  const items = await rssFetcher.discover({
    id: 'src_google',
    type: 'rss',
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=test',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://www.apnews.com/world/example');
  assert.equal(items[0].payload.googleNewsUrl, 'https://news.google.com/rss/articles/CBMi-test?oc=5');
});

test('RSS discover recovers clean Hacker News article URLs from description when fallback link text is polluted', async () => {
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    'rss-parser': {
      default: class StrictParser {
        async parseString() {
          throw new Error('force tolerant parser');
        }
      },
    },
  }, {
    fetch: async () => ({ ok: true, text: async () => malformedHackerNewsRss }),
  });

  const items = await rssFetcher.discover({
    id: 'src_hn',
    type: 'rss',
    name: 'Hacker News',
    url: 'https://hnrss.org/frontpage',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Powering up a module from the IBM 604');
  assert.equal(items[0].url, 'https://www.righto.com/2026/06/ibm-604-thyraton-tube-module.html');
  assert.equal(items[0].externalId, 'https://news.ycombinator.com/item?id=48436819');
});

test('RSS discover skips blocked Google News publisher domains after decode', async () => {
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    'rss-parser': {
      default: class Parser {
        async parseString() {
          return {
            items: [{
              title: 'Blocked Google News story',
              link: 'https://news.google.com/rss/articles/CBMi-blocked?oc=5',
              guid: 'google/blocked',
              contentSnippet: 'Google News excerpt',
            }],
          };
        }
      },
    },
    'google-news-url-decoder': {
      GoogleDecoder: class {
        async decode() {
          return { status: true, decoded_url: 'https://www.nytimes.com/2026/05/09/business/example.html' };
        }
      },
    },
  }, {
    fetch: async () => ({ ok: true, text: async () => googleNewsRss }),
    console: { warn: () => {}, log: () => {} },
    process: { env: { BLOCKED_GOOGLE_NEWS_PUBLISHER_DOMAINS: 'nytimes.com' } },
  });

  const items = await rssFetcher.discover({
    id: 'src_google',
    type: 'rss',
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=test',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(items.length, 0);
});

test('RSS fetchArticle rejects queued blocked Google News publisher domains', async () => {
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', baseStubs, {
    fetch: async () => ({ ok: true, text: async () => '<html><body>unused</body></html>' }),
    process: { env: { BLOCKED_GOOGLE_NEWS_PUBLISHER_DOMAINS: 'nytimes.com' } },
  });

  const result = await rssFetcher.fetchArticle({
    id: 'job_blocked',
    source_id: 'src_google',
    url: 'https://www.nytimes.com/2026/05/09/business/example.html',
    title: 'Blocked story',
    external_id: 'google/blocked',
    published_at: null,
    payload_json: { googleNewsUrl: 'https://news.google.com/rss/articles/CBMi-test?oc=5' },
  }, {
    id: 'src_google',
    type: 'rss',
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=test',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(result, null);
});

test('RSS fetchArticle uses RSS snippet fallback when full article fetch fails', async () => {
  const longSnippet = 'Detailed RSS content '.repeat(60);
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', baseStubs, {
    fetch: async () => { throw new Error('origin blocked'); },
    console: { warn: () => {}, log: () => {} },
  });

  const article = await rssFetcher.fetchArticle({
    id: 'job_1',
    source_id: 'src_google',
    url: 'https://www.apnews.com/world/example',
    title: 'Paywalled story',
    external_id: 'google/paywall',
    published_at: null,
    payload_json: {
      rawExcerpt: longSnippet,
      rawContent: '',
      googleNewsUrl: 'https://news.google.com/rss/articles/CBMi-test?oc=5',
    },
  }, {
    id: 'src_google',
    type: 'rss',
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=test',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(article.rawContent, longSnippet);
  assert.equal(article.metadata.extractor, 'rss:snippet-fallback');
  assert.equal(article.metadata.googleNewsUrl, 'https://news.google.com/rss/articles/CBMi-test?oc=5');
});

test('RSS fetchArticle passes lightweight browser options for anti-bot-light domains', async () => {
  let browserOptions;
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    './http-utils.js': {
      BROWSER_UA: 'test-agent',
      GOOGLEBOT_UA: 'googlebot-agent',
      browserHeaders: (ua) => ({ 'User-Agent': ua }),
      randomUA: () => 'random-agent',
      playwrightFetch: async (_url, options) => {
        browserOptions = options;
        return '<html><body><article>' + 'Full browser article '.repeat(40) + '</article></body></html>';
      },
      isBlockedHtml: () => false,
      isWorkerProxyConfigured: () => false,
      shouldSkipWorkerProxy: () => false,
      workerProxyFetch: async () => ({ ok: false }),
    },
  }, {
    fetch: async () => ({ ok: true, text: async () => '<html><body>short</body></html>' }),
    console: { warn: () => {}, log: () => {} },
  });

  const article = await rssFetcher.fetchArticle({
    id: 'job_2',
    source_id: 'src_google',
    url: 'https://kotaku.com/example-story',
    title: 'Kotaku story',
    external_id: 'google/kotaku',
    published_at: null,
    payload_json: { rawExcerpt: '', rawContent: '' },
  }, {
    id: 'src_google',
    type: 'rss',
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=test',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(browserOptions.waitUntil, 'domcontentloaded');
  assert.equal(browserOptions.blockHeavyResources, true);
  assert.equal(article.metadata.extractor, 'scrapling-stealth:selectors');
});

test('RSS fetchArticle tries residential proxy Cloudflare solve before hosted fetch for blocked non-DataDome pages', async () => {
  const scraplingAttempts = [];
  let hostedCalled = false;
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    './scrapling-fetch.js': {
      getScraplingProxyForUrl: () => undefined,
      isResidentialProxyConfigured: () => true,
      scraplingFetchWithFallback: async (_url, options) => {
        scraplingAttempts.push(options);
        if (options.forceProxy && options.solveCloudflare) {
          return articleHtml('Recovered console story', 'Recovered console article ');
        }
        return '<html><title>Just a moment...</title><script src="https://challenges.cloudflare.com"></script></html>';
      },
    },
    './hosted-fetch.js': {
      ...baseStubs['./hosted-fetch.js'],
      hasHostedFetchKey: () => true,
      hostedFetch: async () => {
        hostedCalled = true;
        throw new Error('hosted fetch should not be called');
      },
    },
    './http-utils.js': {
      ...baseStubs['./http-utils.js'],
      isBlockedHtml: (html) => html.toLowerCase().includes('cloudflare') || html.toLowerCase().includes('just a moment'),
    },
  }, {
    fetch: async () => ({ ok: false, status: 403, text: async () => '<html>blocked</html>' }),
    console: { warn: () => {}, log: () => {} },
  });

  const article = await rssFetcher.fetchArticle({
    id: 'job_cloudflare_proxy',
    source_id: 'src_google',
    url: 'https://www.purexbox.com/news/example',
    title: 'Cloudflare story',
    external_id: 'google/cloudflare',
    published_at: null,
    payload_json: { rawExcerpt: '', rawContent: '' },
  }, {
    id: 'src_google',
    type: 'rss',
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=test',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.ok(article.metadata, `expected recovered metadata; rawContent length=${article.rawContent.length}; attempts=${JSON.stringify(scraplingAttempts)}`);
  assert.equal(article.metadata.extractor, 'scrapling-proxy-cloudflare:selectors');
  assert.equal(hostedCalled, false);
  assert.equal(scraplingAttempts.some((options) => options.forceProxy && options.solveCloudflare), true);
});

test('RSS fetchArticle sends configured Reuters cookie through residential proxy before hosted fetch', async () => {
  const scraplingAttempts = [];
  let hostedCalled = false;
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    './scrapling-fetch.js': {
      getScraplingProxyForUrl: () => undefined,
      isResidentialProxyConfigured: () => true,
      scraplingFetchWithFallback: async (_url, options) => {
        scraplingAttempts.push(options);
        if (options.forceProxy && options.cookieHeader) {
          return articleHtml('Recovered Reuters story', 'Recovered Reuters article ');
        }
        return '<html><script src="https://captcha-delivery.com"></script>datadome</html>';
      },
    },
    './hosted-fetch.js': {
      ...baseStubs['./hosted-fetch.js'],
      isDataDomeHost: (url) => url.includes('reuters.com'),
      hasHostedFetchKey: () => true,
      hostedFetch: async () => {
        hostedCalled = true;
        throw new Error('hosted fetch should not be called');
      },
    },
    './http-utils.js': {
      ...baseStubs['./http-utils.js'],
      isBlockedHtml: (html) => html.toLowerCase().includes('datadome') || html.toLowerCase().includes('captcha-delivery.com'),
    },
  }, {
    fetch: async () => ({ ok: false, status: 401, text: async () => '<html>blocked</html>' }),
    console: { warn: () => {}, log: () => {} },
    process: { env: { REUTERS_COOKIE_HEADER: 'datadome=test-cookie; other=value' } },
  });

  const article = await rssFetcher.fetchArticle({
    id: 'job_reuters_cookie',
    source_id: 'src_reuters',
    url: 'https://www.reuters.com/world/example-2026-06-08',
    title: 'Reuters story',
    external_id: 'reuters/cookie',
    published_at: null,
    payload_json: { rawExcerpt: '', rawContent: '' },
  }, {
    id: 'src_reuters',
    type: 'rss',
    name: 'Reuters',
    url: 'https://news.google.com/rss/search?q=site%3Areuters.com',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.ok(article.metadata, `expected recovered metadata; rawContent length=${article.rawContent.length}; attempts=${JSON.stringify(scraplingAttempts)}`);
  assert.equal(article.metadata.extractor, 'scrapling-proxy-cookie:selectors');
  assert.equal(hostedCalled, false);
  assert.equal(scraplingAttempts.some((options) => options.forceProxy && options.cookieHeader === 'datadome=test-cookie; other=value'), true);
});

test('RSS fetchArticle accepts base64 encoded Reuters cookie env', async () => {
  const scraplingAttempts = [];
  const cookieHeader = 'datadome=test-cookie; other=value';
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    './scrapling-fetch.js': {
      getScraplingProxyForUrl: () => undefined,
      isResidentialProxyConfigured: () => true,
      scraplingFetchWithFallback: async (_url, options) => {
        scraplingAttempts.push(options);
        if (options.forceProxy && options.cookieHeader === cookieHeader) {
          return articleHtml('Recovered Reuters story', 'Recovered Reuters article ');
        }
        return '<html><script src="https://captcha-delivery.com"></script>datadome</html>';
      },
    },
    './hosted-fetch.js': {
      ...baseStubs['./hosted-fetch.js'],
      isDataDomeHost: (url) => url.includes('reuters.com'),
    },
    './http-utils.js': {
      ...baseStubs['./http-utils.js'],
      isBlockedHtml: (html) => html.toLowerCase().includes('datadome') || html.toLowerCase().includes('captcha-delivery.com'),
    },
  }, {
    fetch: async () => ({ ok: false, status: 401, text: async () => '<html>blocked</html>' }),
    console: { warn: () => {}, log: () => {} },
    process: { env: { REUTERS_COOKIE_HEADER_B64: Buffer.from(cookieHeader, 'utf8').toString('base64') } },
    Buffer,
  });

  const article = await rssFetcher.fetchArticle({
    id: 'job_reuters_cookie_b64',
    source_id: 'src_reuters',
    url: 'https://www.reuters.com/world/example-2026-06-08',
    title: 'Reuters story',
    external_id: 'reuters/cookie-b64',
    published_at: null,
    payload_json: { rawExcerpt: '', rawContent: '' },
  }, {
    id: 'src_reuters',
    type: 'rss',
    name: 'Reuters',
    url: 'https://news.google.com/rss/search?q=site%3Areuters.com',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(article.metadata.extractor, 'scrapling-proxy-cookie:selectors');
  assert.equal(scraplingAttempts.some((options) => options.cookieHeader === cookieHeader), true);
});

test('RSS discover skips Google News items when decode fails', async () => {
  const { rssFetcher } = loadTsModule('../src/services/fetchers/rss-fetcher.ts', {
    ...baseStubs,
    'rss-parser': {
      default: class Parser {
        async parseString() {
          return {
            items: [{
              title: 'Undecoded Google News story',
              link: 'https://news.google.com/rss/articles/CBMi-fail?oc=5',
              guid: 'google/fail',
              contentSnippet: 'Google News excerpt',
            }],
          };
        }
      },
    },
    'google-news-url-decoder': {
      GoogleDecoder: class {
        async decode() {
          return { status: false, message: 'decode failed' };
        }
      },
    },
  }, {
    fetch: async () => ({ ok: true, text: async () => googleNewsRss }),
    console: { warn: () => {}, log: () => {} },
  });

  const items = await rssFetcher.discover({
    id: 'src_google',
    type: 'rss',
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=test',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: null,
  });

  assert.equal(items.length, 0);
});
