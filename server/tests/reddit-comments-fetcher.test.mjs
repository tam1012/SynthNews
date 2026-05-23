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

const forumUtilsStub = {
  normalizeWhitespace: (value) => String(value).replace(/\s+/g, ' ').trim(),
  scoreForumComment: (_body, reactions = 0, page = 1, order = 0) => reactions + (page === 1 ? 1 : 0) - order / 100,
  selectForumComments: (comments, limit) => comments.slice(0, limit),
  shouldInsertForumArticle: () => true,
};

function loadForumFetchers({ env = {}, rssItems = [], curlFetch, browserFetch, globals = {} } = {}) {
  const source = readFileSync(resolve(__dirname, '../src/services/fetchers/forum-fetchers.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    AbortSignal: { timeout: () => undefined },
    Buffer,
    URL,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date,
    Math,
    process: { env },
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (name === 'rss-parser') {
        return { default: class RssParser { async parseString() { return { items: rssItems }; } } };
      }
      if (name === 'cheerio') return cheerio;
      if (name === '../../db/index.js') return {};
      if (name === '../../lib/utils.js') {
        return {
          generateId: () => 'id',
          createContentHash: (value) => value,
          normalizePublicHttpUrl: (value) => new URL(value).toString(),
          truncate: (value) => value,
          sleep: async () => {},
        };
      }
      if (name === './http-utils.js') {
        return {
          BROWSER_UA: 'test-agent',
          browserFetch: browserFetch || (async () => { throw new Error('browser should not be used'); }),
          curlFetch: curlFetch || (async () => ({ ok: false, json: async () => null })),
          isBlockedHtml: () => false,
          playwrightFetch: async () => '',
          randomUA: () => 'test-agent',
        };
      }
      if (name === './forum-utils.js') return forumUtilsStub;
      if (name === './scrapling-fetch.js') {
        return {
          scraplingFetch: async () => '',
          scraplingFetchWithFallback: async () => '',
        };
      }
      if (name === '../../lib/dateUtils.js') {
        return {
          getDefaultTimezoneForLanguage: () => 'Z',
          normalizeDate: (v) => v,
        };
      }
      throw new Error(`Unexpected require ${name}`);
    },
    ...globals,
  });
  return moduleContext.exports;
}

function redditJson({ selftext = 'Expanded Reddit post content with useful context.', comments = [] } = {}) {
  return [
    { data: { children: [{ data: { selftext, url: 'https://example.com/shared-link', is_self: false } }] } },
    {
      data: {
        children: comments.map((body, index) => ({
          kind: 't1',
          data: { author: `user${index}`, body, score: 10 - index },
        })),
      },
    },
  ];
}

const usefulComment = 'This is a useful Reddit comment with enough detail to pass the length threshold.';

test('Reddit comment fetcher uses configured proxy URL before RSS', async () => {
  const curlCalls = [];
  const fetchCalls = [];
  const { fetchRedditCommentsForPost } = loadForumFetchers({
    env: { REDDIT_PROXY_URL: 'https://worker.example/reddit' },
    curlFetch: async (url) => {
      curlCalls.push(url);
      return { ok: true, json: async () => redditJson({ comments: [usefulComment] }) };
    },
    globals: {
      fetch: async (url) => {
        fetchCalls.push(url);
        return { ok: false, text: async () => '' };
      },
    },
  });

  const result = await fetchRedditCommentsForPost('/r/test/comments/abc/title/', 'Initial content');

  assert.equal(curlCalls.length, 1);
  assert.equal(curlCalls[0], 'https://worker.example/reddit?path=%2Fr%2Ftest%2Fcomments%2Fabc%2Ftitle%2F.json&limit=30&sort=best&depth=3');
  assert.equal(fetchCalls.length, 0);
  assert.equal(result.strategyUsed, 'proxy');
  assert.equal(result.outboundUrl, 'https://example.com/shared-link');
  assert.equal(result.discussionComments.length, 1);
  assert.equal(result.postContent, 'Expanded Reddit post content with useful context.');
});

test('Reddit comment fetcher falls back to RSS when proxy has no comments', async () => {
  const curlCalls = [];
  const fetchCalls = [];
  const { fetchRedditCommentsForPost } = loadForumFetchers({
    env: { REDDIT_PROXY_URL: 'https://worker.example/reddit' },
    rssItems: [
      { title: 'post item', contentSnippet: 'original post' },
      { author: 'rss-user', contentSnippet: usefulComment },
    ],
    curlFetch: async (url) => {
      curlCalls.push(url);
      return { ok: true, json: async () => redditJson({ comments: [] }) };
    },
    globals: {
      fetch: async (url) => {
        fetchCalls.push(url);
        return { ok: true, text: async () => '<rss />' };
      },
    },
  });

  const result = await fetchRedditCommentsForPost('/r/test/comments/abc/title/', 'Initial content');

  assert.equal(curlCalls.length, 1);
  assert.deepEqual(fetchCalls, ['https://www.reddit.com/r/test/comments/abc/title/.rss']);
  assert.equal(result.strategyUsed, 'rss');
  assert.equal(result.outboundUrl, null);
  assert.equal(result.discussionComments.length, 1);
  assert.equal(result.discussionComments[0].author, 'rss-user');
});
