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
const { decodeHTML } = requireFromTest('entities');

// Default similarity stub: assume no clusters and no novelty pressure so the writer behaves
// like it did before clustering was introduced. Tests that need cluster behavior can supply
// their own stub via the `stubs` argument.
const defaultSimilarityStub = {
  CLUSTER_WINDOW_HOURS: 6,
  SIMILARITY_THRESHOLD: 0.6,
  NOVELTY_THRESHOLD: 0.3,
  IMAGE_MATCH_BONUS: 0.15,
  TITLE_LOCK_THRESHOLD: 0.85,
  buildClusterSignature: () => 'sig',
  computeNovelty: () => 1,
  computeSimilarity: () => ({ score: 0, titleScore: 0, excerptScore: 0, imageMatch: false }),
};

function loadTsModule(relativePath, stubs = {}) {
  const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  const mergedStubs = {
    '../../lib/similarity.js': defaultSimilarityStub,
    ...stubs,
  };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (mergedStubs[name]) return mergedStubs[name];
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('build article insert row with pending summary state and retry defaults', () => {
  const { buildArticleInsertRow } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async () => null,
      query: async () => ({ rowCount: 0 }),
    },
    '../../lib/utils.js': {
      createContentHash: (value) => `hash:${value.slice(0, 8)}`,
      generateId: (prefix) => `${prefix}_test`,
      truncate: (value, max) => String(value).slice(0, max),
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
  });

  const row = buildArticleInsertRow({
    source: { id: 'src_1', language: 'vi' },
    url: 'https://example.com/post',
    title: 'Example title',
    author: 'Author',
    publishedAt: '2026-05-04T00:00:00.000Z',
    rawExcerpt: 'excerpt',
    rawContent: 'content',
    imageUrl: 'https://example.com/image.jpg',
    externalId: 'guid-1',
  });

  assert.equal(row.id, 'art_test');
  assert.equal(row.summary_status, 'pending');
  assert.equal(row.retry_count, 0);
  assert.equal(row.last_summary_error, null);
  assert.equal(row.content_type, 'article');
  assert.equal(row.content_hash, 'hash:Example ');
});

test('build article insert row supports video content metadata', () => {
  const { buildArticleInsertRow } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async () => null,
      query: async () => ({ rowCount: 0 }),
    },
    '../../lib/utils.js': {
      createContentHash: (value) => `hash:${value.slice(0, 8)}`,
      generateId: (prefix) => `${prefix}_test`,
      truncate: (value, max) => String(value).slice(0, max),
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
  });

  const row = buildArticleInsertRow({
    source: { id: 'src_video', language: 'vi' },
    url: 'https://example.com/video/123',
    title: 'Video title',
    rawExcerpt: 'Video description',
    rawContent: 'Transcript text',
    contentType: 'video',
    metadata: { videoId: 'video-123', channelId: 'channel-123' },
  });

  assert.equal(row.content_type, 'video');
  assert.deepEqual(row.metadata, { videoId: 'video-123', channelId: 'channel-123' });
});

test('build article insert row replaces far future publish dates and keeps warning metadata', () => {
  const { buildArticleInsertRow } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async () => null,
      query: async () => ({ rowCount: 0 }),
    },
    '../../lib/utils.js': {
      createContentHash: (value) => `hash:${value.slice(0, 8)}`,
      generateId: (prefix) => `${prefix}_test`,
      truncate: (value, max) => String(value).slice(0, max),
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
  });

  const before = Date.now();
  const row = buildArticleInsertRow({
    source: { id: 'src_1', language: 'vi' },
    url: 'https://example.com/future',
    title: 'Future title',
    publishedAt: '2999-01-01T00:00:00.000Z',
    rawExcerpt: 'excerpt',
    rawContent: 'content',
    metadata: { source: 'test' },
  });
  const after = Date.now();

  assert.ok(new Date(row.published_at || '').getTime() >= before);
  assert.ok(new Date(row.published_at || '').getTime() <= after + 1000);
  assert.equal(row.metadata.source, 'test');
  assert.equal(row.metadata.publish_date_warning.original_published_at, '2999-01-01T00:00:00.000Z');
});

test('build article insert row decodes HTML entities in article text', () => {
  const { buildArticleInsertRow } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async () => null,
      query: async () => ({ rowCount: 0 }),
    },
    '../../lib/utils.js': {
      createContentHash: (value) => `hash:${value.slice(0, 8)}`,
      generateId: (prefix) => `${prefix}_test`,
      truncate: (value, max) => String(value).slice(0, max),
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
  });

  const row = buildArticleInsertRow({
    source: { id: 'src_1', language: 'vi' },
    url: 'https://example.com/post',
    title:
      'C&ocirc;ng ty x\u1ed5 s\u1ed1 chi h&agrave;ng ng&agrave;n l\u01b0\u1ee3ng v&agrave;ng mua nh&agrave; \u0111\u1ea5t t\u1ea1i TP.HCM r\u1ed3i b\u1ecf kh&ocirc;ng',
    rawExcerpt: 'Gi&aacute; v&agrave;ng t\u0103ng',
    rawContent: 'N\u1ed9i dung c&oacute; entity HTML',
  });

  assert.equal(
    row.title,
    'C\u00f4ng ty x\u1ed5 s\u1ed1 chi h\u00e0ng ng\u00e0n l\u01b0\u1ee3ng v\u00e0ng mua nh\u00e0 \u0111\u1ea5t t\u1ea1i TP.HCM r\u1ed3i b\u1ecf kh\u00f4ng'
  );
  assert.equal(row.raw_excerpt, 'Gi\u00e1 v\u00e0ng t\u0103ng');
  assert.equal(row.raw_content, 'N\u1ed9i dung c\u00f3 entity HTML');
});

test('insert article skips duplicate URL before hashing', async () => {
  const queries = [];
  const { insertArticleIfNew } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async (sql, params) => {
        queries.push({ sql, params });
        if (/WHERE url =/.test(sql)) return { id: 'existing' };
        return null;
      },
      getMany: async () => [],
      query: async () => {
        throw new Error('insert should not be called');
      },
    },
    '../../lib/utils.js': {
      createContentHash: () => 'hash',
      generateId: () => 'art_test',
      truncate: (value) => value,
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
  });

  const inserted = await insertArticleIfNew({
    source: { id: 'src_1', language: 'vi' },
    url: 'https://example.com/post',
    title: 'Example title',
    rawExcerpt: '',
    rawContent: '',
  });

  assert.equal(inserted, false);
  assert.equal(queries.length, 1);
});

test('insert article rejects short article content before insert', async () => {
  const { insertArticleIfNew } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async () => null,
      getMany: async () => [],
      query: async () => {
        throw new Error('insert should not be called');
      },
    },
    '../../lib/utils.js': {
      createContentHash: () => 'hash',
      generateId: () => 'art_test',
      truncate: (value) => value,
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
  });

  await assert.rejects(
    insertArticleIfNew({
      source: { id: 'src_1', language: 'vi' },
      url: 'https://example.com/post',
      title: 'Example title',
      rawExcerpt: 'too short',
      rawContent: '',
    }),
    /Article content too short after fetch/
  );
});

test('insert article allows short video content', async () => {
  let inserted = false;
  const { insertArticleIfNew } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async () => null,
      getMany: async () => [],
      query: async () => {
        inserted = true;
        return { rowCount: 1 };
      },
    },
    '../../lib/utils.js': {
      createContentHash: () => 'hash',
      generateId: () => 'art_test',
      truncate: (value) => value,
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
  });

  const result = await insertArticleIfNew({
    source: { id: 'src_video', language: 'vi' },
    url: 'https://example.com/video/short',
    title: 'Video title',
    rawExcerpt: '',
    rawContent: 'short transcript',
    contentType: 'video',
  });

  assert.equal(result, true);
  assert.equal(inserted, true);
});

test('cluster: title-lock attaches as follower even when excerpts diverge (wire republish)', async () => {
  const insertParams = [];
  const { insertArticleIfNew } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async () => null,
      getMany: async () => [
        {
          id: 'art_leader',
          title: 'Quad foreign ministers hold talks in New Delhi',
          raw_excerpt: 'Different lead text from the AP version of the wire story.',
          image_url: null,
          parent_article_id: null,
        },
      ],
      query: async (sql, params) => {
        insertParams.push(params);
        return { rowCount: 1 };
      },
    },
    '../../lib/utils.js': {
      createContentHash: () => 'hash',
      generateId: () => 'art_new',
      truncate: (value) => value,
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
    '../../lib/similarity.js': {
      ...defaultSimilarityStub,
      computeSimilarity: () => ({ score: 1, titleScore: 1, excerptScore: 0.7, imageMatch: false }),
      computeNovelty: () => 0.96, // would normally trigger novel-update; title-lock should override
    },
  });

  await insertArticleIfNew({
    source: { id: 'src_yahoo', language: 'en' },
    url: 'https://yahoo.com/article/quad',
    title: 'Quad foreign ministers hold talks in New Delhi',
    rawExcerpt: 'A'.repeat(600),
    rawContent: 'B'.repeat(600),
  });

  assert.equal(insertParams.length, 1, 'one insert');
  // The 17th positional param is parent_article_id (see INSERT signature in article-writer.ts).
  assert.equal(insertParams[0][16], 'art_leader');
});

test('cluster: low title score + high novelty stays independent (genuine follow-up)', async () => {
  const insertParams = [];
  const { insertArticleIfNew } = loadTsModule('../src/services/fetchers/article-writer.ts', {
    '../../db/index.js': {
      getOne: async () => null,
      getMany: async () => [
        {
          id: 'art_leader',
          title: 'Plane crash kills 5 in Texas',
          raw_excerpt: 'A small plane crashed in rural Texas killing five people.',
          image_url: null,
          parent_article_id: null,
        },
      ],
      query: async (sql, params) => {
        insertParams.push(params);
        return { rowCount: 1 };
      },
    },
    '../../lib/utils.js': {
      createContentHash: () => 'hash',
      generateId: () => 'art_new',
      truncate: (value) => value,
    },
    '../../lib/htmlEntities.js': { decodeHtmlEntities: decodeHTML },
    '../../lib/similarity.js': {
      ...defaultSimilarityStub,
      // Above similarity threshold, but title is only modestly similar (no lock).
      computeSimilarity: () => ({ score: 0.65, titleScore: 0.5, excerptScore: 0.65, imageMatch: false }),
      computeNovelty: () => 0.5,
    },
  });

  await insertArticleIfNew({
    source: { id: 'src_news', language: 'en' },
    url: 'https://example.com/plane-update',
    title: 'NTSB names pilot of Texas plane crash, recovers black box',
    rawExcerpt: 'A'.repeat(600),
    rawContent: 'B'.repeat(600),
  });

  assert.equal(insertParams.length, 1);
  assert.equal(insertParams[0][16], null, 'follow-up should remain independent leader');
});
