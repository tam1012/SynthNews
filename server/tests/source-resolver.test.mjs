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
    AbortSignal: { timeout: () => undefined },
    URL,
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (stubs[name]) return stubs[name];
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

const resolverStubs = {
  './utils.js': {
    normalizePublicHttpUrlWithDns: async (url) => new URL(url).toString(),
  },
  '../services/fetchers/sitemap-discovery.js': {
    buildSitemapCandidates: (url) => [`${new URL(url).origin}/sitemap.xml`],
    parseSitemapIndexUrls: () => [],
    parseSitemapUrls: (xml) => xml.includes('<url>') ? [{ url: 'https://example.com/story', title: 'Story', publishedAt: null }] : [],
  },
};

test('detect GitHub Trending as supported web source with parser preset', async () => {
  const { resolveSourceUrl } = loadTsModule('../src/lib/sourceResolver.ts', resolverStubs);
  const result = await resolveSourceUrl('https://github.com/trending/typescript?since=daily');

  assert.equal(result.supported, true);
  assert.equal(result.detected_kind, 'github-trending');
  assert.equal(result.type, 'web');
  assert.equal(result.canonical_url, 'https://github.com/trending/typescript?since=daily');
  assert.equal(result.parser_config.kind, 'github-trending');
  assert.ok(result.parser_config.articleLinkSelector);
});

test('detect YouTube channel as disabled source', async () => {
  const { resolveSourceUrl } = loadTsModule('../src/lib/sourceResolver.ts', resolverStubs);
  const result = await resolveSourceUrl('https://www.youtube.com/@mkbhd');

  assert.equal(result.supported, false);
  assert.equal(result.detected_kind, 'youtube');
  assert.equal(result.name, 'YouTube');
  assert.match(result.warnings.join(' '), /disabled/i);
});

test('detect YouTube video URL as disabled source', async () => {
  const { resolveSourceUrl } = loadTsModule('../src/lib/sourceResolver.ts', resolverStubs);
  const result = await resolveSourceUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  assert.equal(result.supported, false);
  assert.equal(result.detected_kind, 'youtube');
  assert.equal(result.name, 'YouTube');
  assert.match(result.warnings.join(' '), /disabled/i);
});

test('reject private network URLs before probing', async () => {
  const { resolveSourceUrl } = loadTsModule('../src/lib/sourceResolver.ts', resolverStubs);
  await assert.rejects(
    () => resolveSourceUrl('http://127.0.0.1:3000/feed', async () => {
      throw new Error('fetcher should not be called');
    }),
    /public http\(s\) URL/
  );
});

test('detect Reddit subreddit and suggest stable RSS URL', async () => {
  const { resolveSourceUrl } = loadTsModule('../src/lib/sourceResolver.ts', resolverStubs);
  const result = await resolveSourceUrl('https://www.reddit.com/r/LocalLLaMA/');

  assert.equal(result.supported, true);
  assert.equal(result.detected_kind, 'reddit');
  assert.equal(result.type, 'rss');
  assert.equal(result.suggested_url, 'https://www.reddit.com/r/LocalLLaMA/.rss');
});

test('probe common RSS paths when HTML page has no alternate feed link', async () => {
  const { resolveSourceUrl } = loadTsModule('../src/lib/sourceResolver.ts', resolverStubs);
  const fetcher = async (url) => {
    if (url === 'https://example.com/') {
      return {
        ok: true,
        url,
        headers: { get: () => 'text/html' },
        text: async () => '<html><head><title>Example</title></head><body>News</body></html>',
      };
    }
    if (url === 'https://example.com/feed') {
      return {
        ok: true,
        url,
        headers: { get: () => 'application/rss+xml' },
        text: async () => '<rss><channel><title>Example feed</title></channel></rss>',
      };
    }
    return {
      ok: false,
      url,
      headers: { get: () => 'text/plain' },
      text: async () => '',
    };
  };

  const result = await resolveSourceUrl('https://example.com/', fetcher);

  assert.equal(result.type, 'rss');
  assert.equal(result.suggested_url, 'https://example.com/feed');
  assert.equal(result.preview.rss_count, 1);
});

test('surface HTTP status in detect warnings when source fetch fails', async () => {
  const { resolveSourceUrl } = loadTsModule('../src/lib/sourceResolver.ts', resolverStubs);
  const result = await resolveSourceUrl('https://example.com/', async (url) => ({
    ok: false,
    status: 503,
    url,
    headers: { get: () => 'text/plain' },
    text: async () => '',
  }));

  assert.match(result.warnings.join(' '), /503/);
});

test('detect sitemap-only web source and suggest sitemap parser config', async () => {
  const { resolveSourceUrl } = loadTsModule('../src/lib/sourceResolver.ts', resolverStubs);
  const fetcher = async (url) => {
    if (url === 'https://example.com/') {
      return {
        ok: true,
        url,
        headers: { get: () => 'text/html' },
        text: async () => '<html><head><title>Example</title></head><body>News</body></html>',
      };
    }
    if (url === 'https://example.com/sitemap.xml') {
      return {
        ok: true,
        url,
        headers: { get: () => 'application/xml' },
        text: async () => '<urlset><url><loc>https://example.com/story</loc></url></urlset>',
      };
    }
    return {
      ok: false,
      url,
      headers: { get: () => 'text/plain' },
      text: async () => '',
    };
  };

  const result = await resolveSourceUrl('https://example.com/', fetcher);

  assert.equal(result.type, 'web');
  assert.equal(result.parser_config.discoverSitemap, true);
  assert.equal(result.preview.sitemap_count, 1);
  assert.equal(result.preview.recent_sitemap_count, 1);
});
